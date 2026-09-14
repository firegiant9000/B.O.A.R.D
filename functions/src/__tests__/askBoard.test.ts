// Board Q&A retrieval + chat. The handler's dependencies are injected, so every
// gate, both paid calls and the citation-liveness filter are exercised without
// Firestore, OpenAI or the Functions runtime.
//
// `../ai/usage` and `../ai/rateLimit` are PARTIALLY mocked: only the two
// Firestore-touching entry points the deps factory calls are replaced. The pure
// maths (`estimateCostUsd`, `DEFAULT_BUCKET`) stays real, because the cost and
// bucket assertions below are about real numbers — a fully mocked module would
// have let them pass against `undefined`.

jest.mock("firebase-admin/firestore", () => ({ getFirestore: () => ({}) }));
jest.mock("../lib/board", () => ({ resolveBoardAccess: jest.fn() }));
jest.mock("../ai/rateLimit", () => ({
  ...jest.requireActual("../ai/rateLimit"),
  consumeToken: jest.fn(),
}));
jest.mock("../ai/usage", () => ({
  ...jest.requireActual("../ai/usage"),
  recordAiUsage: jest.fn(),
  checkFeatureQuota: jest.fn(),
}));

import * as fs from "fs";
import * as path from "path";
import { type CallableRequest } from "firebase-functions/v2/https";
import {
  handleAskBoard,
  makeAskBoardDeps,
  collectionForElementType,
  qaBucketKey,
  QA_BUCKET,
  BOARD_QA_FEATURE,
  ELEMENT_COLLECTIONS,
  type AskBoardDeps,
  type AskBoardRequest,
} from "../callable/askBoard";
import { DEFAULT_BUCKET, consumeToken } from "../ai/rateLimit";
import { estimateCostUsd, recordAiUsage, checkFeatureQuota } from "../ai/usage";
import { resolveBoardAccess } from "../lib/board";
import { RETRIEVAL_TOP_K, type RetrievedChunk } from "../ai/boardQaPrompt";
import type { AIProvider, ChatRequest } from "../ai/provider";

const T = Date.UTC(2026, 8, 11, 12, 0, 0); // 2026-09-11 -> period "2026-09"

const CHUNKS: RetrievedChunk[] = [
  { elementId: "note1", elementType: "note", text: "Photosynthesis happens in chloroplasts." },
  { elementId: "text2", elementType: "textElement", text: "Chlorophyll absorbs red and blue light." },
];

const CHAT_USAGE = { promptTokens: 900, completionTokens: 120, totalTokens: 1020 };
const EMBED_USAGE = { promptTokens: 1000, totalTokens: 1000 };

interface DepsOverrides {
  workspaceId?: string;
  isMember?: boolean;
  boardMissing?: boolean;
  allowed?: boolean;
  withinQuota?: boolean;
  candidates?: RetrievedChunk[];
  /** Element ids whose canvas element still exists. Defaults to all candidates. */
  liveIds?: string[];
  answer?: string;
}

function makeDeps(over: DepsOverrides = {}) {
  const candidates = over.candidates ?? CHUNKS;
  const liveIds = new Set(over.liveIds ?? candidates.map((c) => c.elementId));

  const provider: AIProvider = {
    chat: jest.fn(async (_req: ChatRequest) => ({
      text: over.answer ?? "It happens in chloroplasts [[note1]].",
      model: "gpt-4o-mini",
      usage: CHAT_USAGE,
    })),
  };

  const deps: AskBoardDeps = {
    resolveAccess: jest.fn(async () =>
      over.boardMissing
        ? null
        : {
            workspaceId: over.workspaceId ?? "wsA",
            isMember: over.isMember ?? true,
            isAdmin: false,
          }
    ),
    consumeToken: jest.fn(async () => over.allowed ?? true),
    checkQuota: jest.fn(async () => over.withinQuota ?? true),
    findNearest: jest.fn(async () => candidates),
    elementExists: jest.fn(async (_b: string, _t: string, elementId: string) =>
      liveIds.has(elementId)
    ),
    embedder: {
      embed: jest.fn(async () => ({
        vector: [0.1, 0.2, 0.3],
        model: "text-embedding-3-small",
        usage: EMBED_USAGE,
      })),
    },
    provider,
    recordUsage: jest.fn(async () => undefined),
  };
  return deps;
}

function req(over: Partial<CallableRequest<AskBoardRequest>> = {}) {
  return {
    auth: { uid: "u1" },
    data: { boardId: "board-1", question: "Where does photosynthesis happen?" },
    ...over,
  } as CallableRequest<AskBoardRequest>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── the gate, before the provider call ──────────────────────────────────────

describe("handleAskBoard — gates run before anything is spent", () => {
  it("refuses when the workspace is over its Q&A quota", async () => {
    const depsOverQuota = makeDeps({ withinQuota: false });

    await expect(handleAskBoard(req(), depsOverQuota, T)).rejects.toThrow(/limit/i);
    expect(depsOverQuota.provider.chat).not.toHaveBeenCalled();
  });

  it("does not even pay for the question embedding when over quota", async () => {
    // The chat call is the expensive one, but retrieval needs a paid embedding
    // FIRST. A gate placed between the two would still bill every denied
    // question — cheaply, invisibly, and on exactly the tier that is supposed
    // to be capped.
    const depsOverQuota = makeDeps({ withinQuota: false });

    await expect(handleAskBoard(req(), depsOverQuota, T)).rejects.toThrow(/limit/i);
    expect(depsOverQuota.embedder.embed).not.toHaveBeenCalled();
    expect(depsOverQuota.findNearest).not.toHaveBeenCalled();
    expect(depsOverQuota.recordUsage).not.toHaveBeenCalled();
  });

  it("refuses a throttled caller before spending anything either", async () => {
    const deps = makeDeps({ allowed: false });

    await expect(handleAskBoard(req(), deps, T)).rejects.toThrow(/wait a moment/i);
    expect(deps.embedder.embed).not.toHaveBeenCalled();
    expect(deps.provider.chat).not.toHaveBeenCalled();
    // The quota read is two Firestore gets; a throttled caller should not pay
    // for them either.
    expect(deps.checkQuota).not.toHaveBeenCalled();
  });

  it("skips the plan gate for a legacy board with no workspace, but still rate-limits it", async () => {
    const deps = makeDeps({ workspaceId: "" });

    await handleAskBoard(req(), deps, T);

    expect(deps.checkQuota).not.toHaveBeenCalled();
    expect(deps.consumeToken).toHaveBeenCalledWith(qaBucketKey("solo-u1"), T);
    // Nothing to meter under: a synthetic solo key is a bucket address, not a
    // workspace document.
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });
});

// ── the two denial reasons a client has to tell apart ───────────────────────

describe("handleAskBoard — resource-exhausted carries a routable reason", () => {
  it("tags the transient throttle as rate-limit, not a plan cap", async () => {
    const deps = makeDeps({ allowed: false });

    // A free-tier user who clicked twice quickly must not be shown an upgrade
    // prompt — this field is the only thing that lets the client tell the two
    // denials apart, since both arrive as the same RPC code.
    await expect(handleAskBoard(req(), deps, T)).rejects.toMatchObject({
      code: "resource-exhausted",
      details: { reason: "rate-limit" },
    });
  });

  it("tags the plan cap as plan-quota", async () => {
    const deps = makeDeps({ withinQuota: false });

    await expect(handleAskBoard(req(), deps, T)).rejects.toMatchObject({
      code: "resource-exhausted",
      details: { reason: "plan-quota" },
    });
  });

  it("has no resource-exhausted throw site this suite hasn't covered", () => {
    // A partial adoption of `details: { reason }` is worse than none: the
    // client routes on the field, so a throw site that omits it silently falls
    // through to the "reason unknown" path and the user gets whatever the
    // generic branch shows. The two sites above are behaviourally pinned; this
    // fails the moment a third appears, so it cannot be added untested.
    const src = fs.readFileSync(
      path.join(__dirname, "../callable/askBoard.ts"),
      "utf8"
    );
    const throwSites = src.match(/"resource-exhausted"/g) ?? [];
    expect(throwSites).toHaveLength(2); // guard: a non-empty parse
    expect(src.match(/reason: "rate-limit"/g)).toHaveLength(1);
    expect(src.match(/reason: "plan-quota"/g)).toHaveLength(1);
  });
});

// ── its own, tighter bucket ─────────────────────────────────────────────────

describe("board Q&A rate bucket", () => {
  it("uses a tighter bucket than summaries", () => {
    expect(QA_BUCKET.capacity).toBeLessThan(DEFAULT_BUCKET.capacity);
  });

  it("also refills more slowly than the shared bucket", () => {
    // Capacity alone only bounds a burst. Without a slower refill the sustained
    // cost is unchanged, which is the half that actually adds up over a month.
    expect(QA_BUCKET.refillPerSec).toBeLessThan(DEFAULT_BUCKET.refillPerSec);
  });

  it("addresses a DIFFERENT bucket document from the shared one", () => {
    // `consumeToken` stores every bucket at workspaces/{key}/aiRate/bucket, so
    // a tighter config under the SAME key is not a second bucket — it is two
    // configs clamping one document's state on alternate calls. This is the
    // assertion that makes "its own bucket" mean something.
    expect(qaBucketKey("wsA")).not.toBe("wsA");
    expect(qaBucketKey("solo-u1")).not.toBe("solo-u1");
  });

  it("passes the Q&A key, not the bare workspace id, to the limiter", async () => {
    const deps = makeDeps();
    await handleAskBoard(req(), deps, T);
    expect(deps.consumeToken).toHaveBeenCalledWith(qaBucketKey("wsA"), T);
  });
});

// ── the answer and its citations ────────────────────────────────────────────

describe("handleAskBoard — answers cite the elements they came from", () => {
  it("returns an answer with the elements it cited", async () => {
    const deps = makeDeps({
      answer: "Chloroplasts [[note1]], using chlorophyll [[text2]].",
    });

    const res = await handleAskBoard(req(), deps, T);

    expect(res.citations).toEqual([
      {
        elementId: "note1",
        elementType: "note",
        excerpt: "Photosynthesis happens in chloroplasts.",
      },
      {
        elementId: "text2",
        elementType: "textElement",
        excerpt: "Chlorophyll absorbs red and blue light.",
      },
    ]);
    expect(res.answer).toBe("Chloroplasts, using chlorophyll.");
    expect(res.model).toBe("gpt-4o-mini");
  });

  it("drops an id the model invented instead of offering it as something to click", async () => {
    const deps = makeDeps({ answer: "Because [[note1]] and [[ghost404]]." });

    const res = await handleAskBoard(req(), deps, T);

    expect(res.citations.map((c) => c.elementId)).toEqual(["note1"]);
  });

  it("falls back to the whole retrieved set when the model cited nothing", async () => {
    // The user must always have something to verify against; these really are
    // the elements the answer was produced from.
    const deps = makeDeps({ answer: "Chloroplasts." });

    const res = await handleAskBoard(req(), deps, T);

    expect(res.citations.map((c) => c.elementId)).toEqual(["note1", "text2"]);
  });

  it("asks for only the top K nearest elements", async () => {
    const deps = makeDeps();
    await handleAskBoard(req(), deps, T);
    expect(deps.findNearest).toHaveBeenCalledWith("board-1", [0.1, 0.2, 0.3], RETRIEVAL_TOP_K);
  });

  it("replays the client's thread, bounded, so a follow-up resolves", async () => {
    const deps = makeDeps();
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      text: `turn-${i}`,
    }));

    await handleAskBoard(
      req({ data: { boardId: "board-1", question: "And why?", history } }),
      deps,
      T
    );

    const sent = (deps.provider.chat as jest.Mock).mock.calls[0][0] as ChatRequest;
    // system + bounded history + the question. Twenty turns must not all arrive.
    expect(sent.messages.length).toBeLessThan(history.length);
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[sent.messages.length - 1].role).toBe("user");
  });
});

// ── citations survive (by not being offered for) a deleted element ──────────

describe("handleAskBoard — a stale embedding never becomes a citation", () => {
  it("drops a candidate whose element has been deleted", async () => {
    // Deletion cleanup is eventually consistent and can fail outright, so an
    // embedding CAN outlive its element. If that id reached the client it would
    // render as a tappable citation that resolves to nothing — which, to the
    // person tapping it, looks exactly like the model inventing board content.
    //
    // The model is made to cite BOTH ids on purpose. With the default answer
    // (which cites only the surviving one) this assertion passes whether or not
    // the filter runs at all — the fixture, not the code, would be producing
    // the result. Citing both means the stale id is dropped only if something
    // actually drops it.
    const deps = makeDeps({
      liveIds: ["note1"],
      answer: "Both [[note1]] and [[text2]] are relevant.",
    });

    const res = await handleAskBoard(req(), deps, T);

    expect(res.citations.map((c) => c.elementId)).toEqual(["note1"]);
  });

  it("keeps deleted content out of the prompt entirely, not just out of the citations", async () => {
    // The stronger property: a user who deletes a note should not find the
    // answer still quoting it back at them.
    const deps = makeDeps({ liveIds: ["note1"] });

    await handleAskBoard(req(), deps, T);

    const sent = (deps.provider.chat as jest.Mock).mock.calls[0][0] as ChatRequest;
    const prompt = String(sent.messages[sent.messages.length - 1].content);
    expect(prompt).toContain("Photosynthesis happens in chloroplasts.");
    expect(prompt).not.toContain("Chlorophyll absorbs red and blue light.");
    expect(prompt).not.toContain("text2");
  });

  it("never calls the model at all when every retrieved element is gone", async () => {
    const deps = makeDeps({ liveIds: [] });

    const res = await handleAskBoard(req(), deps, T);

    expect(deps.provider.chat).not.toHaveBeenCalled();
    expect(res.citations).toEqual([]);
    expect(res.answer).toMatch(/couldn't find anything/i);
  });

  it("names what it cannot see, so a session question isn't a silent dead end", async () => {
    // ROADMAP.md scopes this chat over "board content + session history +
    // comments"; session history is not indexed (see the callable's header).
    // Someone who asks about something said in a session and gets a bare
    // "nothing found" would reasonably conclude the feature is broken, or that
    // the thing was never discussed.
    const deps = makeDeps({ candidates: [] });

    const res = await handleAskBoard(req(), deps, T);

    expect(res.answer).toMatch(/session/i);
    expect(res.answer).toMatch(/comment/i);
  });

  it("still meters the question embedding it already paid for on that path", async () => {
    // Otherwise an empty board is an unmetered embedding generator with only
    // the rate limiter in front of it.
    const deps = makeDeps({ liveIds: [] });

    await handleAskBoard(req(), deps, T);

    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
    expect((deps.recordUsage as jest.Mock).mock.calls[0][0]).toMatchObject({
      feature: BOARD_QA_FEATURE,
      model: "text-embedding-3-small",
    });
  });
});

// ── metering ────────────────────────────────────────────────────────────────

describe("handleAskBoard — cost telemetry", () => {
  it("records one call per question, under the boardQa feature", async () => {
    const deps = makeDeps();

    await handleAskBoard(req(), deps, T);

    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
    expect((deps.recordUsage as jest.Mock).mock.calls[0][0]).toMatchObject({
      workspaceId: "wsA",
      uid: "u1",
      feature: "boardQa",
      model: "gpt-4o-mini",
      usage: CHAT_USAGE,
      now: T,
    });
  });

  it("folds the question embedding's cost into the recorded dollar figure", async () => {
    // One question makes TWO paid calls but is counted as one, so the token
    // counters only carry the completion call's. If the embed's dollars were
    // dropped too, the spend would be invisible in both places at once.
    const deps = makeDeps();

    await handleAskBoard(req(), deps, T);

    const { flatCostUsd } = (deps.recordUsage as jest.Mock).mock.calls[0][0];
    const chatOnly = estimateCostUsd("gpt-4o-mini", CHAT_USAGE);
    expect(chatOnly).toBeGreaterThan(0); // guard: the comparison below isn't 0 vs 0
    expect(flatCostUsd).toBeGreaterThan(chatOnly);
  });

  it("still returns the answer when the telemetry write fails", async () => {
    const deps = makeDeps();
    (deps.recordUsage as jest.Mock).mockRejectedValue(new Error("firestore down"));

    const res = await handleAskBoard(req(), deps, T);

    expect(res.answer).toBeTruthy();
  });
});

// ── auth, validation, access ────────────────────────────────────────────────

describe("handleAskBoard — auth, input and access", () => {
  it("rejects an unauthenticated caller", async () => {
    const deps = makeDeps();
    await expect(
      handleAskBoard(req({ auth: undefined }), deps, T)
    ).rejects.toThrow(/sign in/i);
    expect(deps.resolveAccess).not.toHaveBeenCalled();
  });

  it("requires a boardId", async () => {
    const deps = makeDeps();
    await expect(
      handleAskBoard(
        req({ data: { boardId: "", question: "hi" } }),
        deps,
        T
      )
    ).rejects.toThrow(/boardId/i);
  });

  it("requires a non-blank question", async () => {
    const deps = makeDeps();
    await expect(
      handleAskBoard(
        req({ data: { boardId: "board-1", question: "   " } }),
        deps,
        T
      )
    ).rejects.toThrow(/question is required/i);
    expect(deps.consumeToken).not.toHaveBeenCalled();
  });

  it("rejects an oversized question before it becomes prompt tokens", async () => {
    const deps = makeDeps();
    await expect(
      handleAskBoard(
        req({ data: { boardId: "board-1", question: "q".repeat(5000) } }),
        deps,
        T
      )
    ).rejects.toThrow(/at most/i);
    expect(deps.embedder.embed).not.toHaveBeenCalled();
  });

  it("404s a board that doesn't exist", async () => {
    const deps = makeDeps({ boardMissing: true });
    await expect(handleAskBoard(req(), deps, T)).rejects.toThrow(/not found/i);
  });

  it("refuses a non-member — the Admin SDK bypasses rules, so this IS the check", async () => {
    const deps = makeDeps({ isMember: false });
    await expect(handleAskBoard(req(), deps, T)).rejects.toThrow(/not a member/i);
    expect(deps.embedder.embed).not.toHaveBeenCalled();
  });
});

// ── the element-type → collection map ───────────────────────────────────────

describe("collectionForElementType", () => {
  it("maps every type the embedding trigger's extractors stamp", () => {
    expect(collectionForElementType("note")).toBe("notes");
    expect(collectionForElementType("textElement")).toBe("textElements");
    expect(collectionForElementType("path")).toBe("paths");
  });

  it("covers the other two element subcollections too", () => {
    expect(collectionForElementType("shape")).toBe("shapes");
    expect(collectionForElementType("image")).toBe("images");
  });

  it("places a comment thread, which is indexed but is not a canvas element", () => {
    // ROADMAP.md scopes this chat over "board content + session history +
    // comments". If retrieval could not place a comment's type, every comment
    // citation would fail the liveness check and drop — the text would be
    // indexed, searched, matched, and then silently discarded.
    expect(collectionForElementType("comment")).toBe("comments");
  });

  it("fails closed on a type this build doesn't know", () => {
    // A future embeddable kind (audio transcripts are next) must be added here
    // to be citable. Guessing a path would put an unverifiable citation on a
    // user's screen, which is the one outcome this check exists to prevent.
    expect(collectionForElementType("audio")).toBeNull();
    expect(collectionForElementType("")).toBeNull();
  });

  it("never maps a type to a path segment with a slash in it", () => {
    // The value is interpolated straight into a document path; a slash would
    // silently re-target the read at a different depth.
    for (const collection of Object.values(ELEMENT_COLLECTIONS)) {
      expect(collection).not.toContain("/");
    }
  });
});

// ── the real Firestore wiring ───────────────────────────────────────────────

/** A fake Firestore that records the paths asked for and answers from a fixed
 *  map — the only way to see whether the deps factory reads the collections it
 *  is supposed to. Getting these paths wrong would leave the handler running,
 *  answering, and silently citing either nothing or everything. */
function fakeDb(opts: {
  docs?: Record<string, Record<string, unknown> | undefined>;
  nearest?: { id: string; data: Record<string, unknown> }[];
}) {
  const docPaths: string[] = [];
  const collectionPaths: string[] = [];
  let nearestOptions: any = null;

  const db = {
    doc: (p: string) => {
      docPaths.push(p);
      return {
        get: async () => {
          const data = opts.docs?.[p];
          return { exists: data !== undefined, data: () => data };
        },
      };
    },
    collection: (p: string) => {
      collectionPaths.push(p);
      return {
        findNearest: (options: any) => {
          nearestOptions = options;
          return {
            get: async () => ({
              docs: (opts.nearest ?? []).map((d) => ({
                id: d.id,
                data: () => d.data,
              })),
            }),
          };
        },
      };
    },
  } as any;

  return {
    db,
    docPaths,
    collectionPaths,
    nearestOptions: () => nearestOptions,
  };
}

const noopProvider: AIProvider = { chat: jest.fn() };
const noopEmbedder = { embed: jest.fn() };

describe("makeAskBoardDeps — the real path wiring", () => {
  it("queries the asking board's OWN embeddings subcollection", async () => {
    const f = fakeDb({ nearest: [] });
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);

    await deps.findNearest("board-1", [1, 2, 3], 6);

    // The board filter IS the path — a collection-group query here would reach
    // every other board's index.
    expect(f.collectionPaths).toEqual(["boards/board-1/embeddings"]);
  });

  it("searches the indexed vector field with the measure the index was built for", async () => {
    const f = fakeDb({ nearest: [] });
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);

    await deps.findNearest("board-1", [1, 2, 3], 6);

    expect(f.nearestOptions()).toMatchObject({
      vectorField: "vector",
      queryVector: [1, 2, 3],
      limit: 6,
      distanceMeasure: "COSINE",
    });
  });

  it("maps a nearest hit to its element id, kind and indexed text", async () => {
    const f = fakeDb({
      nearest: [{ id: "note1", data: { elementType: "note", text: "Chloroplasts." } }],
    });
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);

    await expect(deps.findNearest("board-1", [1], 6)).resolves.toEqual([
      { elementId: "note1", elementType: "note", text: "Chloroplasts." },
    ]);
  });

  it("drops a hit with no usable text rather than citing an empty excerpt", async () => {
    const f = fakeDb({
      nearest: [
        { id: "ok", data: { elementType: "note", text: "real" } },
        { id: "blank", data: { elementType: "note", text: "   " } },
        { id: "typeless", data: { elementType: 7, text: 12 } },
      ],
    });
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);

    const hits = await deps.findNearest("board-1", [1], 6);
    expect(hits.map((h) => h.elementId)).toEqual(["ok"]);
  });

  it("checks an element's liveness in the collection its type actually lives in", async () => {
    const f = fakeDb({ docs: { "boards/board-1/notes/n1": { content: "hi" } } });
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);

    await expect(deps.elementExists("board-1", "note", "n1")).resolves.toBe(true);
    expect(f.docPaths).toEqual(["boards/board-1/notes/n1"]);
  });

  it("reads comments for a comment thread", async () => {
    const f = fakeDb({ docs: { "boards/board-1/comments/c1": { body: "we decided X" } } });
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);

    await expect(deps.elementExists("board-1", "comment", "c1")).resolves.toBe(true);
    expect(f.docPaths).toEqual(["boards/board-1/comments/c1"]);
  });

  it("reads textElements (not notes) for a text element", async () => {
    // Pointing the liveness read at one fixed collection would make the guard
    // pass for notes and fail for everything else, with the whole suite green.
    const f = fakeDb({ docs: { "boards/board-1/textElements/t1": { text: "hi" } } });
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);

    await expect(deps.elementExists("board-1", "textElement", "t1")).resolves.toBe(true);
    expect(f.docPaths).toEqual(["boards/board-1/textElements/t1"]);
  });

  it("reports a deleted element as gone", async () => {
    const f = fakeDb({ docs: {} });
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);

    await expect(deps.elementExists("board-1", "note", "gone")).resolves.toBe(false);
  });

  it("reads nothing at all for an element type it can't place", async () => {
    const f = fakeDb({ docs: {} });
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);

    await expect(deps.elementExists("board-1", "audio", "a1")).resolves.toBe(false);
    expect(f.docPaths).toEqual([]);
  });

  it("spends a token from the Q&A bucket's config, not the shared default", async () => {
    const f = fakeDb({});
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);
    (consumeToken as jest.Mock).mockResolvedValue(true);

    await deps.consumeToken("wsA:boardQa", T);

    expect(consumeToken).toHaveBeenCalledWith(f.db, "wsA:boardQa", T, QA_BUCKET);
  });

  it("gates on boardQaPerPeriod, under the boardQa feature counter", async () => {
    const f = fakeDb({});
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);
    (checkFeatureQuota as jest.Mock).mockResolvedValue(true);

    await deps.checkQuota("wsA", T);

    expect(checkFeatureQuota).toHaveBeenCalledWith(f.db, "wsA", "boardQa", "boardQaPerPeriod", T);
  });

  it("forwards the feature and the folded cost through to recordAiUsage", async () => {
    const f = fakeDb({});
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);
    (recordAiUsage as jest.Mock).mockResolvedValue({ period: "2026-09", costUsd: 1 });

    await deps.recordUsage({
      workspaceId: "wsA",
      uid: "u1",
      feature: BOARD_QA_FEATURE,
      model: "gpt-4o-mini",
      usage: CHAT_USAGE,
      flatCostUsd: 0.00042,
      now: T,
    });

    expect(recordAiUsage).toHaveBeenCalledWith(f.db, {
      workspaceId: "wsA",
      uid: "u1",
      feature: "boardQa",
      model: "gpt-4o-mini",
      usage: CHAT_USAGE,
      flatCostUsd: 0.00042,
      now: T,
    });
  });

  it("resolves board access through the shared server-side membership check", async () => {
    const f = fakeDb({});
    const deps = makeAskBoardDeps(f.db, noopProvider, noopEmbedder);
    (resolveBoardAccess as jest.Mock).mockResolvedValue({
      workspaceId: "wsA",
      isMember: true,
      isAdmin: false,
    });

    await deps.resolveAccess("board-1", "u1");

    expect(resolveBoardAccess).toHaveBeenCalledWith(f.db, "board-1", "u1");
  });
});
