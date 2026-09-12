// Unit tests for the board Q&A embedding TRIGGER (Month 6) — the
// unchanged-content gate, the metering-gated pure handler (including legacy-
// board telemetry and the write/delete race guard), deletion cleanup, the
// per-collection extractors, and the actual registered shape of all ten
// bindings. No emulator, no Functions runtime: mirrors pollTally.test.ts's
// split between pure-logic tests (deps injected directly) and "__endpoint"
// metadata tests that pin the real registered event type/path without ever
// invoking a handler through a fake CloudEvent.

// Only `recordAiUsage` is swapped out (real `checkAiQuota`/`hashWorkspaceId`/
// `estimateCostUsd` stay live via `requireActual`) — needed so the
// "makeDeps — real Firestore path wiring" tests below can assert on the
// `feature`/`completionTokens` fields `deps.recordUsage` passes THROUGH to
// it, without also having to simulate `recordAiUsage`'s own transactional
// read-modify-write against a fake Firestore. Every other test in this file
// injects `EmbeddingTriggerDeps` by hand and never reaches this module at
// all, so this mock changes nothing about them.
jest.mock("../ai/usage", () => ({
  ...jest.requireActual("../ai/usage"),
  recordAiUsage: jest.fn(async () => ({ period: "2026-06", costUsd: 0 })),
}));

import type { Firestore } from "firebase-admin/firestore";
import {
  isContentUnchanged,
  handleElementWrite,
  handleElementDeleted,
  authorOf,
  extractNote,
  extractTextElement,
  extractPath,
  extractShape,
  extractImage,
  EXTRACTORS,
  makeDeps,
  onNoteWritten,
  onTextElementWritten,
  onPathWritten,
  onShapeWritten,
  onImageWritten,
  onNoteDeleted,
  onTextElementDeleted,
  onPathDeleted,
  onShapeDeleted,
  onImageDeleted,
  type EmbeddingTriggerDeps,
  type CleanupDeps,
  type ExtractedElement,
} from "../triggers/embeddings";
import { contentHashFor, type StoredEmbedding, type EmbedOutcome, type EmbeddingProvider } from "../ai/embeddings";
import { ocrCacheKey } from "../ai/ocrCache";
import { recordAiUsage } from "../ai/usage";

const recordAiUsageMock = recordAiUsage as jest.Mock;

function makeStored(overrides: Partial<StoredEmbedding> = {}): StoredEmbedding {
  return {
    vector: {},
    text: "old text",
    elementType: "note",
    contentHash: contentHashFor("old text"),
    updatedAt: 1_000,
    schemaVersion: 1,
    ...overrides,
  };
}

describe("isContentUnchanged", () => {
  it("is true when the stored contentHash matches the new text's hash", () => {
    const stored = makeStored({ contentHash: contentHashFor("same text") });
    expect(isContentUnchanged(stored, "same text")).toBe(true);
  });

  it("is false when the text changed", () => {
    const stored = makeStored({ contentHash: contentHashFor("old") });
    expect(isContentUnchanged(stored, "new")).toBe(false);
  });

  it("is false when there is no stored doc yet (first-ever embed)", () => {
    expect(isContentUnchanged(null, "brand new text")).toBe(false);
  });
});

describe("handleElementWrite", () => {
  // Named distinctly from the module's own exported `makeDeps` (real
  // Firestore path wiring, tested separately below) — this one builds a
  // hand-injected fixture, never touching Firestore at all.
  function makeTestDeps(overrides: Partial<EmbeddingTriggerDeps> = {}): EmbeddingTriggerDeps {
    return {
      getBoardWorkspaceId: jest.fn(async () => "wsA"),
      getStoredEmbedding: jest.fn(async () => null),
      consumeToken: jest.fn(async () => true),
      checkAiQuota: jest.fn(async () => true),
      embed: jest.fn(async (): Promise<EmbedOutcome> => ({
        embedded: true,
        model: "text-embedding-3-small",
        usage: { promptTokens: 5, totalTokens: 5 },
      })),
      recordUsage: jest.fn(async () => undefined),
      elementStillExists: jest.fn(async () => true),
      deleteEmbedding: jest.fn(async () => undefined),
      ...overrides,
    };
  }

  function extracted(text = "hello", authorUid = "author-1"): ExtractedElement {
    return { element: { id: "el1", elementType: "note", text }, authorUid };
  }

  it("embeds and meters on the happy path, and does not touch the race guard's delete", async () => {
    const deps = makeTestDeps();
    await handleElementWrite("b1", extracted(), deps, 1_000_000);

    expect(deps.embed).toHaveBeenCalledWith("b1", extracted().element, 1_000_000);
    expect(deps.recordUsage).toHaveBeenCalledWith({
      workspaceId: "wsA",
      uid: "author-1",
      model: "text-embedding-3-small",
      usage: { promptTokens: 5, totalTokens: 5 },
      now: 1_000_000,
    });
    expect(deps.elementStillExists).toHaveBeenCalledTimes(1);
    expect(deps.deleteEmbedding).not.toHaveBeenCalled();
  });

  it("skips the embed (no board read, no rate-limit consume) when the content hash is unchanged", async () => {
    const stored = makeStored({ contentHash: contentHashFor("hello") });
    const deps = makeTestDeps({ getStoredEmbedding: jest.fn(async () => stored) });
    await handleElementWrite("b1", extracted("hello"), deps, 999_999_999);

    expect(deps.getBoardWorkspaceId).not.toHaveBeenCalled();
    expect(deps.consumeToken).not.toHaveBeenCalled();
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it("skips everything (no rate-limit consume, no embed) when the board doc is missing", async () => {
    const deps = makeTestDeps({ getBoardWorkspaceId: jest.fn(async () => null) });
    await handleElementWrite("gone", extracted(), deps, 1_000_000);

    expect(deps.consumeToken).not.toHaveBeenCalled();
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it("does NOT call the provider when the rate limiter denies", async () => {
    const deps = makeTestDeps({ consumeToken: jest.fn(async () => false) });
    await handleElementWrite("b1", extracted(), deps, 1_000_000);

    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  // The check the coordinator explicitly asked to see RED-checked.
  it("does NOT call the provider when the workspace is over its AI quota", async () => {
    const deps = makeTestDeps({ checkAiQuota: jest.fn(async () => false) });
    await handleElementWrite("b1", extracted(), deps, 1_000_000);

    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  // Legacy boards have no workspace to meter a plan quota against, but the
  // spend still happened — recorded under a synthetic bucket so it is
  // visible rather than silently unaccounted for.
  it("a legacy (no-workspace) board buckets the rate limit AND meters usage under the synthetic solo-author bucket, but skips the quota check", async () => {
    const deps = makeTestDeps({ getBoardWorkspaceId: jest.fn(async () => "") });
    await handleElementWrite("legacyBoard", extracted("hello", "author-9"), deps, 1_000_000);

    expect(deps.consumeToken).toHaveBeenCalledWith("solo-author-9", 1_000_000);
    expect(deps.checkAiQuota).not.toHaveBeenCalled();
    expect(deps.embed).toHaveBeenCalled();
    expect(deps.recordUsage).toHaveBeenCalledWith({
      workspaceId: "solo-author-9",
      uid: "author-9",
      model: "text-embedding-3-small",
      usage: { promptTokens: 5, totalTokens: 5 },
      now: 1_000_000,
    });
  });

  it("does not meter or check the race guard when embedElement itself reports a hash-skip (a narrow race with another invocation)", async () => {
    const deps = makeTestDeps({ embed: jest.fn(async () => ({ embedded: false })) });
    await handleElementWrite("b1", extracted(), deps, 1_000_000);

    expect(deps.recordUsage).not.toHaveBeenCalled();
    expect(deps.elementStillExists).not.toHaveBeenCalled();
    expect(deps.deleteEmbedding).not.toHaveBeenCalled();
  });

  it("swallows a usage-telemetry write failure without throwing (a paid embed must not be undone by a logging failure)", async () => {
    const deps = makeTestDeps({ recordUsage: jest.fn(async () => { throw new Error("firestore down"); }) });
    await expect(handleElementWrite("b1", extracted(), deps, 1_000_000)).resolves.toBeUndefined();
  });

  // A multi-second embed call leaves a window where the element can be
  // deleted before the write that started it lands.
  it("deletes the just-written embedding when the element was deleted during the (multi-second) embed call, while still recording the spend that already happened", async () => {
    const deps = makeTestDeps({ elementStillExists: jest.fn(async () => false) });
    await handleElementWrite("b1", extracted(), deps, 1_000_000);

    expect(deps.recordUsage).toHaveBeenCalled(); // the OpenAI call already happened and was paid for
    expect(deps.deleteEmbedding).toHaveBeenCalledWith("b1", "el1");
    expect(deps.deleteEmbedding).toHaveBeenCalledTimes(1);
  });

  it("does not delete the embedding when the element still exists (the ordinary case)", async () => {
    const deps = makeTestDeps({ elementStillExists: jest.fn(async () => true) });
    await handleElementWrite("b1", extracted(), deps, 1_000_000);

    expect(deps.deleteEmbedding).not.toHaveBeenCalled();
  });

  // Without this catch, a throw here would reject the whole handler —
  // `onDocumentWritten` defaults to `retry: false`, so the resurrected
  // embedding would stand permanently and silently, exactly what the race
  // guard exists to prevent.
  it("swallows a compensating-delete failure without throwing (mirrors the usage-telemetry catch above it)", async () => {
    const deps = makeTestDeps({
      elementStillExists: jest.fn(async () => false),
      deleteEmbedding: jest.fn(async () => { throw new Error("firestore down"); }),
    });

    await expect(handleElementWrite("b1", extracted(), deps, 1_000_000)).resolves.toBeUndefined();
  });
});

describe("handleElementDeleted", () => {
  it("deletes the element's embedding doc", async () => {
    const deleteEmbedding = jest.fn(async () => undefined);
    const deps: CleanupDeps = { deleteEmbedding };

    await handleElementDeleted("b1", "el1", deps);

    expect(deleteEmbedding).toHaveBeenCalledWith("b1", "el1");
    expect(deleteEmbedding).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// makeDeps — the REAL Firestore path wiring, not the pure handler above.
// `handleElementWrite`'s own tests inject `EmbeddingTriggerDeps` by hand, so
// they cannot catch `elementStillExists`/`deleteEmbedding` pointing at the
// WRONG collection: if `elementStillExists` read `boards/{b}/embeddings/
// {el}` instead of the element's own collection, the document would ALWAYS
// exist (the embed handler just wrote it), so the race guard would silently
// never fire — and every one of those hand-injected-deps tests would still
// pass, because they never exercise this wiring at all. These tests do.
function fakePathDb() {
  const gets: string[] = [];
  const deletes: string[] = [];
  const store = new Map<string, boolean>(); // path -> exists
  const db = {
    doc: (path: string) => ({
      get: async () => {
        gets.push(path);
        return { exists: store.get(path) ?? false };
      },
      delete: async () => {
        deletes.push(path);
      },
    }),
  };
  return { db: db as unknown as Firestore, gets, deletes, store };
}

const dummyProvider = { embed: jest.fn() } as unknown as EmbeddingProvider;

describe("makeDeps — real Firestore path wiring", () => {
  beforeEach(() => {
    recordAiUsageMock.mockClear();
  });

  it("elementStillExists reads the ELEMENT's own collection path, not the embeddings collection", async () => {
    const { db, gets, store } = fakePathDb();
    store.set("boards/b1/notes/el1", true);
    const deps = makeDeps(db, dummyProvider, "b1", "notes", "el1");

    const exists = await deps.elementStillExists();

    expect(gets).toEqual(["boards/b1/notes/el1"]);
    expect(exists).toBe(true);
  });

  it("elementStillExists is false when nothing is at the element's own path — the exact case the write/delete race guard depends on", async () => {
    const { db } = fakePathDb(); // nothing seeded anywhere
    const deps = makeDeps(db, dummyProvider, "b1", "notes", "el1");

    expect(await deps.elementStillExists()).toBe(false);
  });

  it("deleteEmbedding deletes the EMBEDDINGS doc for the given board/element, never the element's own doc", async () => {
    const { db, deletes } = fakePathDb();
    const deps = makeDeps(db, dummyProvider, "b1", "notes", "el1");

    await deps.deleteEmbedding("b1", "el1");

    expect(deletes).toEqual(["boards/b1/embeddings/el1"]);
  });

  it("recordUsage passes feature: 'embeddings' and completionTokens: 0 through to recordAiUsage", async () => {
    const { db } = fakePathDb();
    const deps = makeDeps(db, dummyProvider, "b1", "notes", "el1");

    await deps.recordUsage({
      workspaceId: "wsA",
      uid: "u1",
      model: "text-embedding-3-small",
      usage: { promptTokens: 5, totalTokens: 5 },
      now: 123,
    });

    expect(recordAiUsageMock).toHaveBeenCalledWith(db, {
      workspaceId: "wsA",
      uid: "u1",
      feature: "embeddings",
      model: "text-embedding-3-small",
      usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
      now: 123,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Extractors, each tested against the REAL element
// field names (src/types/index.ts:342-367: TextNote.content,
// TextElement.text), not just imported and trusted: if `extractNote` read
// `data.text` instead of `data.content`, these fixtures (which set only
// `content`) would make it return null instead of the expected element,
// and the test below would fail — the whole point, since a silent field-
// name mismatch here means the feature indexes nothing, with no error
// anywhere to notice it by.

describe("authorOf", () => {
  it("returns the element's userId when present", () => {
    expect(authorOf({ userId: "alice" })).toBe("alice");
  });

  it("falls back to 'unknown' when userId is missing, empty, or not a string", () => {
    expect(authorOf({})).toBe("unknown");
    expect(authorOf({ userId: "" })).toBe("unknown");
    expect(authorOf({ userId: 42 })).toBe("unknown");
  });
});

describe("extractNote", () => {
  it("extracts a TextNote's content field (not text — notes have no such field)", async () => {
    const result = await extractNote({} as any, "b1", "n1", { content: "hello board", userId: "alice" });
    expect(result).toEqual({
      element: { id: "n1", elementType: "note", text: "hello board" },
      authorUid: "alice",
    });
  });

  it("returns null for blank or missing content", async () => {
    expect(await extractNote({} as any, "b1", "n1", { content: "   ", userId: "alice" })).toBeNull();
    expect(await extractNote({} as any, "b1", "n1", { userId: "alice" })).toBeNull();
  });
});

describe("extractTextElement", () => {
  it("extracts a TextElement's text field (not content — text elements have no such field)", async () => {
    const result = await extractTextElement({} as any, "b1", "t1", { text: "hello board", userId: "bob" });
    expect(result).toEqual({
      element: { id: "t1", elementType: "textElement", text: "hello board" },
      authorUid: "bob",
    });
  });

  it("returns null for blank or missing text (e.g. a freshly created, still-empty text box)", async () => {
    expect(await extractTextElement({} as any, "b1", "t1", { text: "", userId: "bob" })).toBeNull();
    expect(await extractTextElement({} as any, "b1", "t1", { userId: "bob" })).toBeNull();
  });
});

describe("extractPath", () => {
  function fakeOcrDb(
    entries: Record<string, { text: string; confidence: number; source: string; model: string; createdAt: number } | undefined>
  ) {
    return {
      doc: (path: string) => ({
        get: async () => {
          const hit = entries[path];
          return { exists: hit !== undefined, data: () => hit };
        },
      }),
    } as any;
  }

  it("returns the cached OCR text for a single-stroke selection (ocrCacheKey([elementId]) hit)", async () => {
    const key = ocrCacheKey(["p1"]);
    const db = fakeOcrDb({ [`boards/b1/ocrCache/${key}`]: { text: "hi", confidence: 1, source: "vision", model: "m", createdAt: 0 } });

    const result = await extractPath(db, "b1", "p1", { userId: "carol" });

    expect(result).toEqual({
      element: { id: "p1", elementType: "path", text: "hi" },
      authorUid: "carol",
    });
  });

  it("returns null when there is no cache entry for this single-stroke key (the common multi-stroke case)", async () => {
    const db = fakeOcrDb({});
    expect(await extractPath(db, "b1", "p1", { userId: "carol" })).toBeNull();
  });

  it("returns null when the cached OCR text is blank", async () => {
    const key = ocrCacheKey(["p1"]);
    const db = fakeOcrDb({ [`boards/b1/ocrCache/${key}`]: { text: "   ", confidence: 1, source: "vision", model: "m", createdAt: 0 } });
    expect(await extractPath(db, "b1", "p1", { userId: "carol" })).toBeNull();
  });
});

describe("extractShape / extractImage", () => {
  it("always return null regardless of input — no text source exists for either today", async () => {
    expect(await extractShape({} as any, "b1", "s1", { shape: "rect" })).toBeNull();
    expect(await extractImage({} as any, "b1", "i1", { alt: "photo.png" })).toBeNull();
  });
});

describe("EXTRACTORS — wiring, not just presence", () => {
  it("maps each collection to its OWN extractor, not a swapped one", () => {
    expect(EXTRACTORS.notes).toBe(extractNote);
    expect(EXTRACTORS.textElements).toBe(extractTextElement);
    expect(EXTRACTORS.paths).toBe(extractPath);
    expect(EXTRACTORS.shapes).toBe(extractShape);
    expect(EXTRACTORS.images).toBe(extractImage);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Binding shape — pins the REAL registered event, exactly like pollTally.
// test.ts's own "__endpoint" tests. Confirmed against the installed
// firebase-functions package by printing each endpoint's actual eventTrigger
// before writing these assertions, not assumed from source line numbers.

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

describe("write bindings — five explicit paths, not a wildcard", () => {
  const cases: Array<[string, unknown, string]> = [
    ["notes", onNoteWritten, "boards/{boardId}/notes/{elementId}"],
    ["textElements", onTextElementWritten, "boards/{boardId}/textElements/{elementId}"],
    ["paths", onPathWritten, "boards/{boardId}/paths/{elementId}"],
    ["shapes", onShapeWritten, "boards/{boardId}/shapes/{elementId}"],
    ["images", onImageWritten, "boards/{boardId}/images/{elementId}"],
  ];

  it.each(cases)("%s is bound to its own literal path, on the 'written' event, with the OpenAI secret attached", (_name, fn, path) => {
    const endpoint = endpointOf(fn);
    expect(endpoint.eventTrigger.eventType).toBe("google.cloud.firestore.document.v1.written");
    expect(endpoint.eventTrigger.eventFilterPathPatterns?.document).toBe(path);
    expect(endpoint.secretEnvironmentVariables).toEqual([{ key: "OPENAI_API_KEY" }]);
  });

  it("is NOT a single wildcard binding — five distinct literal document patterns, one per collection", () => {
    const patterns = cases.map(([, fn]) => endpointOf(fn).eventTrigger.eventFilterPathPatterns?.document);
    expect(new Set(patterns).size).toBe(5);
    expect(patterns.some((p) => p?.includes("{collectionId}"))).toBe(false);
  });
});

describe("deletion-cleanup bindings — one per collection, on the 'deleted' event", () => {
  const cases: Array<[string, unknown, string]> = [
    ["notes", onNoteDeleted, "boards/{boardId}/notes/{elementId}"],
    ["textElements", onTextElementDeleted, "boards/{boardId}/textElements/{elementId}"],
    ["paths", onPathDeleted, "boards/{boardId}/paths/{elementId}"],
    ["shapes", onShapeDeleted, "boards/{boardId}/shapes/{elementId}"],
    ["images", onImageDeleted, "boards/{boardId}/images/{elementId}"],
  ];

  it.each(cases)("%s is bound to its own literal path, on the 'deleted' event", (_name, fn, path) => {
    const endpoint = endpointOf(fn);
    expect(endpoint.eventTrigger.eventType).toBe("google.cloud.firestore.document.v1.deleted");
    expect(endpoint.eventTrigger.eventFilterPathPatterns?.document).toBe(path);
  });
});
