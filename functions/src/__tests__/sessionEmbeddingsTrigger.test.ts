// Unit tests for the SESSION SUMMARY embedding trigger (Month 6) — the
// seventh indexed source and the first that is not under `boards/`. Same split
// as embeddingsTrigger.test.ts: pure-logic tests with deps injected by hand,
// path wiring pinned against a fake Firestore, and "__endpoint" metadata tests
// that pin the real registered event type and document pattern without ever
// invoking a handler through a fake CloudEvent.
//
// `../ai/usage` is PARTIALLY mocked for the same reason it is there: the pure
// maths stays live via `requireActual`, and only the Firestore-touching entry
// points the deps factory calls are swapped out, so the wiring tests can see
// WHICH quota entry point this trigger is bound to. That choice is load-bearing
// and invisible everywhere else — `checkFeatureOnlyQuota` paired with
// `countsTowardAiCap: false` is what keeps automated indexing out of the
// interactive AI cap, and every test of the shared handler injects its own
// `checkQuota` so it would stay green against any of the three.
jest.mock("../ai/usage", () => ({
  ...jest.requireActual("../ai/usage"),
  recordAiUsage: jest.fn(async () => ({ period: "2026-09", costUsd: 0 })),
  checkAiQuota: jest.fn(async () => true),
  checkFeatureQuota: jest.fn(async () => true),
  checkFeatureOnlyQuota: jest.fn(async () => true),
}));

import {
  summaryTextOf,
  extractSessionSummary,
  boardIdOf,
  makeSessionDeps,
  onSessionWritten,
  onSessionDeleted,
} from "../triggers/sessionEmbeddings";
import { handleElementWrite, type EmbeddingTriggerDeps } from "../triggers/embeddings";
import {
  SESSION_ELEMENT_TYPE,
  contentHashFor,
  type EmbedOutcome,
  type EmbeddingProvider,
  type StoredEmbedding,
} from "../ai/embeddings";
import {
  recordAiUsage,
  checkAiQuota,
  checkFeatureQuota,
  checkFeatureOnlyQuota,
} from "../ai/usage";

const recordAiUsageMock = recordAiUsage as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// Both on-disk summary shapes.

describe("summaryTextOf — two shapes, one indexable text", () => {
  it("indexes a pre-Phase-3 PLAIN STRING summary", () => {
    // `Session.summary` is `string | SessionSummary`. Sessions summarised
    // before Phase 3 carry the string form on disk and there is no backfill
    // planned, so reading only the structured shape would silently stop
    // indexing every older session — with nothing failing.
    expect(summaryTextOf("We agreed to ship on Friday.")).toBe("We agreed to ship on Friday.");
  });

  it("indexes a STRUCTURED summary, flattening every one of its four fields", () => {
    const text = summaryTextOf({
      tldr: "Scope cut.",
      actionItems: ["Ana drafts the RFC"],
      decisions: ["Drop milestone three"],
      openQuestions: ["Who owns the migration?"],
    });
    // All four carry real content a question might reach for; dropping any one
    // would make that content unsearchable while the session still indexed.
    expect(text).toContain("Scope cut.");
    expect(text).toContain("Ana drafts the RFC");
    expect(text).toContain("Drop milestone three");
    expect(text).toContain("Who owns the migration?");
  });

  it("reads like prose, not like JSON — the text IS the chunk the model is shown", () => {
    const text = summaryTextOf({
      tldr: "Scope cut.",
      actionItems: ["Ana drafts the RFC"],
      decisions: [],
      openQuestions: [],
    });
    expect(text).not.toContain('"tldr"');
    expect(text).not.toContain("[");
    expect(text).toContain("Action items:");
  });

  it("omits the label for a section that is empty", () => {
    const text = summaryTextOf({ tldr: "Just a summary.", actionItems: [], decisions: [], openQuestions: [] });
    expect(text).toBe("Just a summary.");
  });

  it("is order-stable, so unchanged content keeps hashing the same", () => {
    // An unstable join order would change the content hash on every write and
    // re-bill an embed for a summary that did not change.
    const a = summaryTextOf({ tldr: "x", actionItems: ["a"], decisions: ["d"], openQuestions: ["q"] });
    const b = summaryTextOf({ openQuestions: ["q"], decisions: ["d"], actionItems: ["a"], tldr: "x" });
    expect(a).toBe(b);
    expect(contentHashFor(a)).toBe(contentHashFor(b));
  });

  it("skips non-string entries inside a section rather than stringifying them", () => {
    const text = summaryTextOf({ tldr: "t", actionItems: ["real", 7, null, { a: 1 }] });
    expect(text).toContain("- real");
    expect(text).not.toContain("7");
    expect(text).not.toContain("object");
  });

  it("yields nothing for anything that is not a usable summary", () => {
    for (const v of [undefined, null, "", "   ", 42, [], {}, { tldr: "  " }]) {
      expect(summaryTextOf(v)).toBe("");
    }
  });

  it("yields nothing for a structured summary whose four fields are all empty", () => {
    expect(summaryTextOf({ tldr: "", actionItems: [], decisions: [], openQuestions: [] })).toBe("");
  });
});

describe("extractSessionSummary", () => {
  const base = { boardId: "b1", createdById: "creator-1" };

  it("stamps the session element type, keyed by the session's own id", () => {
    const got = extractSessionSummary("sess1", { ...base, summary: "hello" });
    expect(got).toEqual({
      element: { id: "sess1", elementType: SESSION_ELEMENT_TYPE, text: "hello" },
      authorUid: "creator-1",
    });
  });

  it("attributes the spend to createdById, NOT userId — a session has no userId", () => {
    // The comment extractor's divergence, again: the wrong field here does not
    // fail, it silently logs every session's cost against "unknown" and, on a
    // legacy board, collapses every creator's rate limit into one bucket.
    const got = extractSessionSummary("sess1", { boardId: "b1", userId: "wrong", summary: "hello" });
    expect(got?.authorUid).toBe("unknown");
    expect(extractSessionSummary("sess1", { ...base, summary: "hello" })?.authorUid).toBe("creator-1");
  });

  it("extracts NOTHING for a session that has never been summarised", () => {
    // Not an empty embedding: a zero-content vector would match every question
    // weakly and cite a session that says nothing.
    expect(extractSessionSummary("sess1", { ...base })).toBeNull();
    expect(extractSessionSummary("sess1", { ...base, summary: "" })).toBeNull();
    expect(extractSessionSummary("sess1", { ...base, summary: "   " })).toBeNull();
  });

  it("never reads the transcript or the canvas snapshot", () => {
    // SUMMARIES ONLY is a standing privacy decision. A future field that looked
    // summary-adjacent must not be picked up by accident.
    const got = extractSessionSummary("sess1", {
      ...base,
      summary: "the summary",
      canvasSnapshot: "<svg>SECRET-SNAPSHOT</svg>",
      transcript: "SECRET-TRANSCRIPT every word anyone said",
    });
    expect(got?.element.text).toBe("the summary");
    expect(got?.element.text).not.toContain("SECRET-SNAPSHOT");
    expect(got?.element.text).not.toContain("SECRET-TRANSCRIPT");
  });

  it("extracts nothing when only a transcript exists — a transcript is not a fallback", () => {
    expect(
      extractSessionSummary("sess1", { ...base, transcript: "every word anyone said" })
    ).toBeNull();
  });
});

describe("boardIdOf", () => {
  it("reads the board off the session document — no lookup needed", () => {
    expect(boardIdOf({ boardId: "b1" })).toBe("b1");
  });

  it("is null for a session that names no board", () => {
    expect(boardIdOf({})).toBeNull();
    expect(boardIdOf({ boardId: "" })).toBeNull();
    expect(boardIdOf({ boardId: 7 })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Re-summarisation, metering and the race guard — all of it borrowed from the
// board trigger's `handleElementWrite`, exercised here through a session's own
// extracted shape so the reuse is pinned rather than assumed.

describe("a session summary through the shared write handler", () => {
  function makeTestDeps(overrides: Partial<EmbeddingTriggerDeps> = {}): EmbeddingTriggerDeps {
    return {
      getBoardWorkspaceId: jest.fn(async () => "wsA"),
      getStoredEmbedding: jest.fn(async () => null),
      consumeToken: jest.fn(async () => true),
      checkQuota: jest.fn(async () => true),
      embed: jest.fn(async (): Promise<EmbedOutcome> => ({
        embedded: true,
        model: "text-embedding-3-small",
        usage: { promptTokens: 9, totalTokens: 9 },
      })),
      recordUsage: jest.fn(async () => undefined),
      elementStillExists: jest.fn(async () => true),
      deleteEmbedding: jest.fn(async () => undefined),
      ...overrides,
    };
  }

  const extracted = (text: string) => extractSessionSummary("sess1", {
    boardId: "b1",
    createdById: "creator-1",
    summary: text,
  })!;

  it("charges the embed against the board's quota and rate bucket, like any other source", () => {
    // The brief's "do not add an unmetered AI call path". Both gates run and
    // both run before the provider call.
    const deps = makeTestDeps();
    return handleElementWrite("b1", extracted("v1"), deps, 1_000).then(() => {
      expect(deps.consumeToken).toHaveBeenCalledWith("wsA", 1_000);
      expect(deps.checkQuota).toHaveBeenCalledWith("wsA", 1_000);
      expect(deps.embed).toHaveBeenCalled();
      expect(deps.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "wsA", uid: "creator-1" })
      );
    });
  });

  it("does not call the paid provider when over quota", async () => {
    const deps = makeTestDeps({ checkQuota: jest.fn(async () => false) });
    await handleElementWrite("b1", extracted("v1"), deps, 1_000);
    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it("does not call the paid provider when rate-limited", async () => {
    const deps = makeTestDeps({ consumeToken: jest.fn(async () => false) });
    await handleElementWrite("b1", extracted("v1"), deps, 1_000);
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it("buckets a LEGACY board's session under solo-<creator>, and still meters it", async () => {
    const deps = makeTestDeps({ getBoardWorkspaceId: jest.fn(async () => "") });
    await handleElementWrite("b1", extracted("v1"), deps, 1_000);
    expect(deps.consumeToken).toHaveBeenCalledWith("solo-creator-1", 1_000);
    // No plan to cap on a legacy board, but the spend is still visible.
    expect(deps.checkQuota).not.toHaveBeenCalled();
    expect(deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "solo-creator-1" })
    );
  });

  it("RE-SUMMARISATION updates rather than duplicating: same id, one embedding", async () => {
    // The embedding is keyed by the session id, so a second, different summary
    // overwrites the first. There is no path that produces two documents.
    const deps = makeTestDeps();
    await handleElementWrite("b1", extracted("first summary"), deps, 1_000);
    await handleElementWrite("b1", extracted("second summary"), deps, 2_000);

    const ids = (deps.embed as jest.Mock).mock.calls.map((c) => c[1].id);
    expect(ids).toEqual(["sess1", "sess1"]);
    expect((deps.embed as jest.Mock).mock.calls[1][1].text).toBe("second summary");
  });

  it("re-summarising with the SAME text costs nothing at all", async () => {
    const stored: StoredEmbedding = {
      vector: {},
      text: "unchanged",
      elementType: SESSION_ELEMENT_TYPE,
      contentHash: contentHashFor("unchanged"),
      updatedAt: 1,
      schemaVersion: 1,
    };
    const deps = makeTestDeps({ getStoredEmbedding: jest.fn(async () => stored) });

    await handleElementWrite("b1", extracted("unchanged"), deps, 1_000);

    expect(deps.getBoardWorkspaceId).not.toHaveBeenCalled();
    expect(deps.consumeToken).not.toHaveBeenCalled();
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it("runs the write/delete race guard: a session deleted mid-embed loses its embedding", async () => {
    const deps = makeTestDeps({ elementStillExists: jest.fn(async () => false) });
    await handleElementWrite("b1", extracted("v1"), deps, 1_000);
    expect(deps.deleteEmbedding).toHaveBeenCalledWith("b1", "sess1");
  });

  it("leaves the embedding alone when the session is still there", async () => {
    const deps = makeTestDeps();
    await handleElementWrite("b1", extracted("v1"), deps, 1_000);
    expect(deps.deleteEmbedding).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Real Firestore path wiring. Two paths at two different depths that must not
// be swapped: the session is TOP-LEVEL, its embedding is under the BOARD.

function fakeDb(docs: Record<string, Record<string, unknown> | undefined>) {
  const reads: string[] = [];
  const deletes: string[] = [];
  const db = {
    doc: (p: string) => ({
      get: async () => {
        reads.push(p);
        const data = docs[p];
        return { exists: data !== undefined, data: () => data };
      },
      delete: async () => {
        deletes.push(p);
      },
    }),
  } as never;
  return { db, reads, deletes };
}

const noopProvider: EmbeddingProvider = { embed: jest.fn() };

describe("makeSessionDeps — the real path wiring", () => {
  it("re-reads the SESSION itself for the race guard, not the embedding and not a board subcollection", async () => {
    const f = fakeDb({ "sessions/sess1": { boardId: "b1" } });
    const deps = makeSessionDeps(f.db, noopProvider, "sess1");

    await expect(deps.elementStillExists()).resolves.toBe(true);
    expect(f.reads).toEqual(["sessions/sess1"]);
  });

  it("reports a deleted session as gone", async () => {
    const f = fakeDb({});
    const deps = makeSessionDeps(f.db, noopProvider, "sess1");
    await expect(deps.elementStillExists()).resolves.toBe(false);
  });

  it("deletes the embedding from under the BOARD, keyed by the session id", async () => {
    // The two halves of the race guard read and write at different depths. Point
    // either at the other's shape and the guard silently never fires.
    const f = fakeDb({});
    const deps = makeSessionDeps(f.db, noopProvider, "sess1");

    await deps.deleteEmbedding("b1", "sess1");

    expect(f.deletes).toEqual(["boards/b1/embeddings/sess1"]);
  });

  it("resolves the workspace from the BOARD document, not the session's own field", async () => {
    // Session.workspaceId is migration-tolerant and would invent a second
    // convention; the board trigger already answers this and a legacy board
    // reads "".
    const f = fakeDb({ "boards/b1": { workspaceId: "wsA" } });
    const deps = makeSessionDeps(f.db, noopProvider, "sess1");

    await expect(deps.getBoardWorkspaceId("b1")).resolves.toBe("wsA");
    expect(f.reads).toEqual(["boards/b1"]);
  });

  it("reads a legacy board's missing workspaceId as \"\", and a missing board as null", async () => {
    const f = fakeDb({ "boards/b1": {} });
    const deps = makeSessionDeps(f.db, noopProvider, "sess1");
    await expect(deps.getBoardWorkspaceId("b1")).resolves.toBe("");
    await expect(deps.getBoardWorkspaceId("gone")).resolves.toBeNull();
  });

  it("gates on embeddingsPerPeriod via checkFeatureOnlyQuota, NOT the workspace-wide AI cap", async () => {
    const f = fakeDb({});
    const deps = makeSessionDeps(f.db, noopProvider, "sess1");

    await deps.checkQuota("wsA", 1_000);

    expect(checkFeatureOnlyQuota).toHaveBeenCalledWith(f.db, "wsA", "embeddings", "embeddingsPerPeriod", 1_000);
    expect(checkFeatureQuota).not.toHaveBeenCalled();
    expect(checkAiQuota).not.toHaveBeenCalled();
  });

  it("reports the spend but carves it out of the interactive AI cap", async () => {
    // The pairing rule: `checkFeatureOnlyQuota` above and
    // `countsTowardAiCap: false` here go together. Gating on a counter this
    // trigger deliberately does not feed would let an unrelated summary stop a
    // board from re-indexing.
    const f = fakeDb({});
    const deps = makeSessionDeps(f.db, noopProvider, "sess1");

    await deps.recordUsage({
      workspaceId: "wsA",
      uid: "creator-1",
      model: "text-embedding-3-small",
      usage: { promptTokens: 9, totalTokens: 9 },
      now: 1_000,
    });

    expect(recordAiUsageMock).toHaveBeenCalledWith(f.db, {
      workspaceId: "wsA",
      uid: "creator-1",
      feature: "embeddings",
      model: "text-embedding-3-small",
      usage: { promptTokens: 9, completionTokens: 0, totalTokens: 9 },
      now: 1_000,
      countsTowardAiCap: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Binding shape — pins the REAL registered event, the same way
// embeddingsTrigger.test.ts pins its twelve.

type Endpoint = {
  eventTrigger: {
    eventType: string;
    eventFilterPathPatterns?: { document?: string };
  };
  secretEnvironmentVariables?: Array<{ key: string }>;
};

function endpointOf(fn: unknown): Endpoint {
  return (fn as { __endpoint: Endpoint }).__endpoint;
}

describe("session bindings — top-level, and paired", () => {
  it("binds the write trigger to the TOP-LEVEL sessions collection with the OpenAI secret attached", () => {
    // This is the whole reason this file exists separately: no value of
    // `<collection>` in `boards/{boardId}/<collection>/{elementId}` produces
    // this pattern.
    const endpoint = endpointOf(onSessionWritten);
    expect(endpoint.eventTrigger.eventType).toBe("google.cloud.firestore.document.v1.written");
    expect(endpoint.eventTrigger.eventFilterPathPatterns?.document).toBe("sessions/{sessionId}");
    expect(endpoint.secretEnvironmentVariables).toEqual([{ key: "OPENAI_API_KEY" }]);
  });

  it("is not bound under boards/ — an embedding is, the session is not", () => {
    const pattern = endpointOf(onSessionWritten).eventTrigger.eventFilterPathPatterns?.document;
    expect(pattern?.startsWith("boards/")).toBe(false);
  });

  it("pairs the write binding with a delete binding on the same path", () => {
    // An unpaired source indexes fine and cleans up never: its embeddings
    // outlive their sessions and cost a read on every question forever.
    const endpoint = endpointOf(onSessionDeleted);
    expect(endpoint.eventTrigger.eventType).toBe("google.cloud.firestore.document.v1.deleted");
    expect(endpoint.eventTrigger.eventFilterPathPatterns?.document).toBe("sessions/{sessionId}");
  });
});
