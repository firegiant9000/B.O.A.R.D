// Unit tests for the board Q&A embedding TRIGGER (Month 6) — the debounce
// gate, the metering-gated pure handler, deletion cleanup, and the actual
// registered shape of all ten bindings. No emulator, no Functions runtime:
// mirrors pollTally.test.ts's split between pure-logic tests (deps injected
// directly) and "__endpoint" metadata tests that pin the real registered
// event type/path without ever invoking a handler through a fake CloudEvent.

// No jest.mock calls needed: every test below either calls the pure
// functions directly with hand-built deps, or inspects an exported
// trigger's `__endpoint` metadata without ever invoking its handler body —
// so `getFirestore()`, `OpenAIEmbeddingProvider`, `consumeToken`, etc. are
// never actually reached. Mirrors pollTally.test.ts's own "__endpoint"
// tests, which need no mocking for the same reason.

import {
  shouldSkipEmbedAttempt,
  handleElementWrite,
  handleElementDeleted,
  EMBEDDING_DEBOUNCE_MS,
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
import { contentHashFor, type StoredEmbedding, type EmbedOutcome } from "../ai/embeddings";

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

describe("shouldSkipEmbedAttempt", () => {
  it("skips when the content hash is unchanged", () => {
    const stored = makeStored({ contentHash: contentHashFor("same text") });
    expect(shouldSkipEmbedAttempt(stored, "same text", 999_999)).toBe(true);
  });

  it("skips when the text changed but the last real embed was inside the debounce window", () => {
    const stored = makeStored({ contentHash: contentHashFor("old"), updatedAt: 1_000 });
    const now = 1_000 + EMBEDDING_DEBOUNCE_MS - 1;
    expect(shouldSkipEmbedAttempt(stored, "new", now)).toBe(true);
  });

  it("attempts when the text changed and the debounce window has passed", () => {
    const stored = makeStored({ contentHash: contentHashFor("old"), updatedAt: 1_000 });
    const now = 1_000 + EMBEDDING_DEBOUNCE_MS;
    expect(shouldSkipEmbedAttempt(stored, "new", now)).toBe(false);
  });

  it("never debounces the first-ever embed (no stored doc)", () => {
    expect(shouldSkipEmbedAttempt(null, "brand new text", 5)).toBe(false);
  });

  // The NaN-guard direction. Deliberately does NOT follow the "deny unless
  // provably under" quota-gate convention here (see this function's own
  // header) — corrupt/non-finite `updatedAt` must fail toward ATTEMPT
  // (self-healing: a real embed overwrites it with a fresh value), not
  // toward skip (which would silently stop re-indexing this element
  // forever, since a skip never writes anything). This is genuinely
  // falsifiable: the OPPOSITE, "deny unless provably past the cooldown"
  // phrasing (`!(elapsed >= debounceMs)`) flips a NaN `updatedAt` to
  // "skip" instead — see this task's report for the RED-check confirming
  // that flip actually fails this exact assertion.
  it("attempts (does not silently skip forever) when updatedAt is corrupt/non-finite", () => {
    const stored = makeStored({ contentHash: contentHashFor("old"), updatedAt: NaN });
    expect(shouldSkipEmbedAttempt(stored, "new", 1_000_000)).toBe(false);
  });
});

describe("handleElementWrite", () => {
  function makeDeps(overrides: Partial<EmbeddingTriggerDeps> = {}): EmbeddingTriggerDeps {
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
      ...overrides,
    };
  }

  function extracted(text = "hello", authorUid = "author-1"): ExtractedElement {
    return { element: { id: "el1", elementType: "note", text }, authorUid };
  }

  it("embeds and meters on the happy path", async () => {
    const deps = makeDeps();
    await handleElementWrite("b1", extracted(), deps, 1_000_000);

    expect(deps.embed).toHaveBeenCalledWith("b1", extracted().element, 1_000_000);
    expect(deps.recordUsage).toHaveBeenCalledWith({
      workspaceId: "wsA",
      uid: "author-1",
      model: "text-embedding-3-small",
      usage: { promptTokens: 5, totalTokens: 5 },
      now: 1_000_000,
    });
  });

  it("skips everything (no rate-limit consume, no embed) when the board doc is missing", async () => {
    const deps = makeDeps({ getBoardWorkspaceId: jest.fn(async () => null) });
    await handleElementWrite("gone", extracted(), deps, 1_000_000);

    expect(deps.consumeToken).not.toHaveBeenCalled();
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it("skips the embed (no rate-limit consume) when the content hash is unchanged", async () => {
    const stored = makeStored({ contentHash: contentHashFor("hello") });
    const deps = makeDeps({ getStoredEmbedding: jest.fn(async () => stored) });
    await handleElementWrite("b1", extracted("hello"), deps, 999_999_999);

    expect(deps.consumeToken).not.toHaveBeenCalled();
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it("skips the embed when debounced (changed text, too soon since the last real embed)", async () => {
    const stored = makeStored({ contentHash: contentHashFor("old"), updatedAt: 1_000 });
    const deps = makeDeps({ getStoredEmbedding: jest.fn(async () => stored) });
    await handleElementWrite("b1", extracted("new"), deps, 1_000 + EMBEDDING_DEBOUNCE_MS - 1);

    expect(deps.consumeToken).not.toHaveBeenCalled();
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it("does NOT call the provider when the rate limiter denies", async () => {
    const deps = makeDeps({ consumeToken: jest.fn(async () => false) });
    await handleElementWrite("b1", extracted(), deps, 1_000_000);

    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  // The check the coordinator explicitly asked to see RED-checked.
  it("does NOT call the provider when the workspace is over its AI quota", async () => {
    const deps = makeDeps({ checkAiQuota: jest.fn(async () => false) });
    await handleElementWrite("b1", extracted(), deps, 1_000_000);

    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it("a legacy (no-workspace) board buckets the rate limit per author and skips the quota check and metering", async () => {
    const deps = makeDeps({ getBoardWorkspaceId: jest.fn(async () => "") });
    await handleElementWrite("legacyBoard", extracted("hello", "author-9"), deps, 1_000_000);

    expect(deps.consumeToken).toHaveBeenCalledWith("solo-author-9", 1_000_000);
    expect(deps.checkAiQuota).not.toHaveBeenCalled();
    expect(deps.embed).toHaveBeenCalled(); // still embeds — just nothing to meter under
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it("does not meter when embedElement itself reports a hash-skip (a narrow race with another invocation)", async () => {
    const deps = makeDeps({ embed: jest.fn(async () => ({ embedded: false })) });
    await handleElementWrite("b1", extracted(), deps, 1_000_000);

    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it("swallows a usage-telemetry write failure without throwing (a paid embed must not be undone by a logging failure)", async () => {
    const deps = makeDeps({ recordUsage: jest.fn(async () => { throw new Error("firestore down"); }) });
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
