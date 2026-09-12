// Unit tests for the board Q&A embedding write path (Month 6). No emulator:
// `db` is a tiny in-memory fake (a real Map-backed store, not a mock that
// just returns a canned value — mirrors generateFlashcards.test.ts's own
// memoization tests) so the skip/re-embed behavior is a genuine two-call
// proof against the actual read-then-write path in embedElement, not an
// assertion about a mock's return value.

jest.mock("firebase-admin/firestore", () => ({
  FieldValue: { vector: (v: number[]) => ({ __vector: v }) },
}));

import type { Firestore } from "firebase-admin/firestore";
import {
  embedElement,
  getStoredEmbedding,
  contentHashFor,
  truncateForEmbedding,
  EMBEDDING_DIMENSIONS,
  MAX_EMBEDDING_INPUT_CHARS,
  type EmbeddingProvider,
  type EmbedResult,
  type BoardElementInput,
} from "../ai/embeddings";

function makeVector(seed = 0.1): number[] {
  return new Array(EMBEDDING_DIMENSIONS).fill(seed);
}

function makeFakeDb() {
  const store = new Map<string, unknown>();
  const db = {
    doc: (path: string) => ({
      get: async () => ({
        exists: store.has(path),
        data: () => store.get(path),
      }),
      set: async (value: unknown) => {
        store.set(path, value);
      },
    }),
  };
  return { db: db as unknown as Firestore, store };
}

function makeEmbedResult(vector: number[] = makeVector()): EmbedResult {
  return {
    vector,
    model: "text-embedding-3-small",
    usage: { promptTokens: 12, totalTokens: 12 },
  };
}

function makeProvider(result: EmbedResult = makeEmbedResult()): EmbeddingProvider {
  return { embed: jest.fn(async () => result) };
}

describe("embedElement", () => {
  it("skips re-embedding when the content hash is unchanged", async () => {
    const { db } = makeFakeDb();
    const provider = makeProvider();
    const el: BoardElementInput = { id: "el1", elementType: "note", text: "hello board" };

    await embedElement(db, "b1", el, provider);
    await embedElement(db, "b1", el, provider);

    expect(provider.embed).toHaveBeenCalledTimes(1);
  });

  it("re-embeds when the text changes", async () => {
    const { db } = makeFakeDb();
    const provider = makeProvider();
    const el: BoardElementInput = { id: "el1", elementType: "note", text: "hello board" };

    await embedElement(db, "b1", el, provider);
    await embedElement(db, "b1", { ...el, text: "hello board, edited" }, provider);

    expect(provider.embed).toHaveBeenCalledTimes(2);
  });

  // Per-ELEMENT memoization, not per-text: two distinct elements that happen
  // to share identical text are two distinct documents, so both are embedded.
  // If this ever collapsed to a text-keyed store instead of a
  // path/id-keyed one, this is the test that would catch it.
  it("does not skip a different element that happens to share the same text", async () => {
    const { db } = makeFakeDb();
    const provider = makeProvider();

    await embedElement(db, "b1", { id: "el1", elementType: "note", text: "same" }, provider);
    await embedElement(db, "b1", { id: "el2", elementType: "note", text: "same" }, provider);

    expect(provider.embed).toHaveBeenCalledTimes(2);
  });

  it("stores the full contract shape on a fresh embed", async () => {
    const { db, store } = makeFakeDb();
    const vector = makeVector(0.5);
    const provider = makeProvider(makeEmbedResult(vector));
    const el: BoardElementInput = { id: "el1", elementType: "sticky", text: "hi" };

    await embedElement(db, "b1", el, provider, 12345);

    expect(store.get("boards/b1/embeddings/el1")).toEqual({
      vector: { __vector: vector },
      text: "hi",
      elementType: "sticky",
      contentHash: contentHashFor("hi"),
      updatedAt: 12345,
      schemaVersion: 1,
    });
  });

  it("overwrites the stored elementType/text/updatedAt when the text actually changes", async () => {
    const { db, store } = makeFakeDb();
    const provider = makeProvider();
    const el: BoardElementInput = { id: "el1", elementType: "note", text: "v1" };

    await embedElement(db, "b1", el, provider, 1000);
    await embedElement(db, "b1", { ...el, text: "v2" }, provider, 2000);

    const stored = store.get("boards/b1/embeddings/el1") as { text: string; updatedAt: number };
    expect(stored.text).toBe("v2");
    expect(stored.updatedAt).toBe(2000);
  });

  it("throws when the provider returns a vector of the wrong dimension", async () => {
    const { db } = makeFakeDb();
    const provider = makeProvider(makeEmbedResult([0.1, 0.2])); // deliberately wrong length
    const el: BoardElementInput = { id: "el1", elementType: "note", text: "hi" };

    await expect(embedElement(db, "b1", el, provider)).rejects.toThrow(/dimension/);
  });

  describe("return value (what the trigger layer meters on)", () => {
    it("returns embedded: false, with no model/usage, on a hash-skip", async () => {
      const { db } = makeFakeDb();
      const provider = makeProvider();
      const el: BoardElementInput = { id: "el1", elementType: "note", text: "same" };

      await embedElement(db, "b1", el, provider);
      const second = await embedElement(db, "b1", el, provider);

      expect(second).toEqual({ embedded: false });
    });

    it("returns embedded: true with the provider's model/usage on a real embed", async () => {
      const { db } = makeFakeDb();
      const result = makeEmbedResult();
      const provider = makeProvider(result);
      const el: BoardElementInput = { id: "el1", elementType: "note", text: "hi" };

      const outcome = await embedElement(db, "b1", el, provider);

      expect(outcome).toEqual({
        embedded: true,
        model: result.model,
        usage: result.usage,
      });
    });
  });
});

describe("contentHashFor", () => {
  it("is deterministic for the same text", () => {
    expect(contentHashFor("a")).toBe(contentHashFor("a"));
  });

  it("differs for different text", () => {
    expect(contentHashFor("a")).not.toBe(contentHashFor("b"));
  });
});

describe("getStoredEmbedding", () => {
  it("returns null when no embedding has been written yet", async () => {
    const { db } = makeFakeDb();
    await expect(getStoredEmbedding(db, "b1", "missing")).resolves.toBeNull();
  });

  it("returns the stored doc once one exists", async () => {
    const { db } = makeFakeDb();
    const provider = makeProvider();
    const el: BoardElementInput = { id: "el1", elementType: "note", text: "hi" };
    await embedElement(db, "b1", el, provider, 999);

    const stored = await getStoredEmbedding(db, "b1", "el1");
    expect(stored?.contentHash).toBe(contentHashFor("hi"));
    expect(stored?.updatedAt).toBe(999);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Input length. `text-embedding-3-small` rejects input over 8,191 tokens, and
// nothing upstream of here bounds an element's text: not firestore.rules, not
// commentService, not the UI. A comment thread is embedded whole on every
// reply, so this is reachable by ordinary accumulation — 200 replies of 160
// characters is a semester of classroom discussion, not an attack.
//
// The failure it prevents is the expensive one: an over-long input throws
// inside the provider call, the trigger has no catch and does not retry, so
// that document is never indexed again and nobody is told — AND the rate-limit
// token is spent BEFORE the embed, so every later write to it burns a token
// from the bucket every other element in the workspace shares. One long thread
// would degrade indexing workspace-wide, invisibly.

describe("truncateForEmbedding", () => {
  it("leaves ordinary text alone", () => {
    expect(truncateForEmbedding("a short note")).toBe("a short note");
  });

  it("leaves text exactly at the bound alone", () => {
    const exact = "x".repeat(MAX_EMBEDDING_INPUT_CHARS);
    expect(truncateForEmbedding(exact)).toBe(exact);
  });

  it("cuts anything longer to the bound", () => {
    const over = "x".repeat(MAX_EMBEDDING_INPUT_CHARS + 5000);
    expect(truncateForEmbedding(over)).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);
  });

  it("stays under the model's token ceiling even at one token per character", () => {
    // The bound is in CHARACTERS but the model's limit is in TOKENS (8,191).
    // English runs ~4 chars/token, but CJK and several other scripts approach
    // 1, so the only safe choice is one that holds at that worst ratio — a
    // bound tuned to the English average would still throw on a Chinese board.
    expect(MAX_EMBEDDING_INPUT_CHARS).toBeLessThan(8191);
  });
});

describe("embedElement — input length", () => {
  it("never sends the provider more than the model accepts", async () => {
    const { db } = makeFakeDb();
    const provider = makeProvider();
    const huge = "y".repeat(MAX_EMBEDDING_INPUT_CHARS * 3);

    await embedElement(db, "b1", { id: "c1", elementType: "comment", text: huge }, provider, 1);

    const sent = (provider.embed as jest.Mock).mock.calls[0][0] as string;
    expect(sent).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);
  });

  it("stores the text the vector was actually made from, not the original", async () => {
    // The retrieval path hands this field to the model as the chunk this vector
    // matched. Storing text the vector never saw would quote content the match
    // was not made on.
    const { db, store } = makeFakeDb();
    const huge = "y".repeat(MAX_EMBEDDING_INPUT_CHARS * 3);

    await embedElement(db, "b1", { id: "c1", elementType: "comment", text: huge }, makeProvider(), 1);

    const stored = store.get("boards/b1/embeddings/c1") as { text: string };
    expect(stored.text).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);
  });

  it("still re-embeds when the text changes ONLY past the truncation point", async () => {
    // The subtle one, and the reason the hash is taken over the FULL text while
    // the provider sees the prefix. Hashing the truncated input instead would
    // make every edit beyond the bound a silent no-op: the memoization would
    // report "unchanged" for a document that changed, and a thread past the cap
    // would freeze at whatever it said the day it crossed it.
    const { db } = makeFakeDb();
    const provider = makeProvider();
    const head = "y".repeat(MAX_EMBEDDING_INPUT_CHARS);

    await embedElement(db, "b1", { id: "c1", elementType: "comment", text: `${head}first tail` }, provider, 1);
    expect(provider.embed).toHaveBeenCalledTimes(1);

    const second = await embedElement(
      db,
      "b1",
      { id: "c1", elementType: "comment", text: `${head}second tail` },
      provider,
      2
    );

    expect(second.embedded).toBe(true);
    expect(provider.embed).toHaveBeenCalledTimes(2);
  });

  it("still hash-skips when an over-long text is unchanged", async () => {
    // The positive control for the case above: re-embedding on every write to
    // any long document would satisfy that test just as well, and would be its
    // own cost bug.
    const { db } = makeFakeDb();
    const provider = makeProvider();
    const huge = "y".repeat(MAX_EMBEDDING_INPUT_CHARS * 2);
    const el: BoardElementInput = { id: "c1", elementType: "comment", text: huge };

    await embedElement(db, "b1", el, provider, 1);
    const second = await embedElement(db, "b1", el, provider, 2);

    expect(second.embedded).toBe(false);
    expect(provider.embed).toHaveBeenCalledTimes(1);
  });
});
