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
  contentHashFor,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
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

function makeProvider(vector: number[] = makeVector()): EmbeddingProvider {
  return { embed: jest.fn(async () => vector) };
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
    const provider = makeProvider(vector);
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
    const provider = makeProvider([0.1, 0.2]); // deliberately wrong length
    const el: BoardElementInput = { id: "el1", elementType: "note", text: "hi" };

    await expect(embedElement(db, "b1", el, provider)).rejects.toThrow(/dimension/);
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
