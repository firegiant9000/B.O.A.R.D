import { createHash } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

// Board Q&A embedding write path (Month 6 — board Q&A / chat with your
// board). Firestore KNN vector search is GA (`findNearest`, COSINE /
// EUCLIDEAN / DOT_PRODUCT, combinable with `where()`, capped at 2048
// dimensions) — no external vector store. `text-embedding-3-small` is 1536
// dimensions, comfortably inside that cap.
//
// Contract this file owns: `boards/{boardId}/embeddings/{elementId}` =
// `{ vector: FieldValue.vector([...]), text, elementType, contentHash,
// updatedAt, schemaVersion }`. The retrieval path that queries this
// collection (`findNearest` filtered by board, top-k into gpt-4o-mini) is a
// separate piece of work built on top of this contract, not this file's job.
//
// Mirrors `ocrCache.ts`'s memoization discipline exactly (that file's header
// is the fuller explanation): re-embedding text that hasn't changed is pure
// waste, so the result is keyed by a hash of the element's own extracted
// text and skipped whenever that hash is unchanged. UNLIKE ocrCache.ts, this
// is not a request/response cache keyed by an arbitrary selection — it is a
// standing per-element document that a debounced, write-triggered caller
// keeps in sync with the element's current content.
//
// SCOPE NOTE: this file is the memoized write itself — `embedElement` is
// deliberately safe to call as often as a caller likes, since an unchanged
// hash is a no-op. ROADMAP.md:1048 requires this be driven "via Cloud
// Function trigger" — that trigger (five explicit bindings, one per canvas-
// content subcollection), its own debounce window on top of this file's
// hash-skip, and the rate-limit/plan-quota metering around each real embed
// all live in `functions/src/triggers/embeddings.ts`, which wraps this file's
// `embedElement` rather than folding any of that in here. This file stays
// ignorant of debouncing, metering, and which collections exist — it only
// knows how to memoize one element's embed.
//
// RULES NOTE: this collection has NO match block in firestore.rules at all —
// mirroring flashcardCache.ts's precedent, not ocrCache.ts's. No client
// surface ever reads a raw embedding vector: retrieval happens entirely
// server-side (the Cloud Function that runs `findNearest` hands back an
// answer plus cited element ids, never the vectors), so there is no read to
// grant. Denied for read, write AND list by firestore.rules' file-level
// default deny — see firestore-tests/firestore.rules.test.js's "board Q&A
// embeddings" suite for the rules test proving that (with positive controls,
// so a rule that denied everyone everywhere couldn't slip through as a false
// pass).

/** One real embed call's result. `model`/`usage` are NOT persisted (the
 *  Firestore contract below has no room for them) — they exist purely so a
 *  caller can meter the call (`functions/src/triggers/embeddings.ts` records
 *  them via `recordAiUsage`), mirroring `ChatResult`'s role in provider.ts. */
export interface EmbedResult {
  vector: number[];
  model: string;
  usage: { promptTokens: number; totalTokens: number };
}

/** The provider seam for turning text into a vector — mirrors `AIProvider`'s
 *  role in provider.ts, kept as its own narrow interface here since
 *  embedding is a different API shape (text in, vector+usage out) than chat. */
export interface EmbeddingProvider {
  embed(text: string): Promise<EmbedResult>;
}

/** The minimal shape `embedElement` needs from a canvas-content element —
 *  callers (the trigger's per-collection extractors) adapt their own richer
 *  element types down to this before calling in. */
export interface BoardElementInput {
  id: string;
  elementType: string;
  text: string;
}

/** `text-embedding-3-small`'s dimension. Firestore's vector cap is 2048. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Stable content-addressed key for a piece of text, hashed. Same
 *  construction as `ocrCacheKey`/`flashcardCacheKey` — see those files'
 *  comments for why a hash (not a version counter) needs no invalidation
 *  logic: a changed text naturally produces a different hash and misses. */
export function contentHashFor(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** The document shape at `boards/{boardId}/embeddings/{elementId}`. `vector`
 *  is typed `unknown` here (it is a Firestore `VectorValue`, not a plain
 *  array, once round-tripped through `FieldValue.vector`) — readers on the
 *  retrieval path consume it via `findNearest`, never by reading this field
 *  back as a JS array. */
export interface StoredEmbedding {
  vector: unknown;
  text: string;
  elementType: string;
  contentHash: string;
  updatedAt: number;
  schemaVersion: 1;
}

function embeddingRef(db: Firestore, boardId: string, elementId: string) {
  return db.doc(`boards/${boardId}/embeddings/${elementId}`);
}

/** Reads back the stored embedding doc, or `null` if none exists yet. Shared
 *  by `embedElement`'s own hash-check below and by the trigger's debounce
 *  gate (`shouldSkipEmbedAttempt` in triggers/embeddings.ts), which needs the
 *  same `contentHash`/`updatedAt` pair BEFORE deciding whether metering a
 *  real provider call is even on the table — so both read through this one
 *  implementation rather than each constructing the doc path separately. */
export async function getStoredEmbedding(
  db: Firestore,
  boardId: string,
  elementId: string
): Promise<StoredEmbedding | null> {
  const snap = await embeddingRef(db, boardId, elementId).get();
  return snap.exists ? (snap.data() as StoredEmbedding) : null;
}

/** What happened on one `embedElement` call — `embedded: false` for a
 *  hash-skip (no provider call, nothing to meter); `embedded: true` with the
 *  model/usage a caller needs to record cost telemetry for the real call
 *  that just happened. */
export interface EmbedOutcome {
  embedded: boolean;
  model?: string;
  usage?: { promptTokens: number; totalTokens: number };
}

/**
 * Embeds one board element's text and stores it, skipping the (paid)
 * provider call entirely when the content hash is unchanged from what's
 * already stored — the whole point of this memoization, mirroring
 * `ocrCache.ts`'s discipline. This is what makes calling it on every settled
 * edit affordable: a caller can invoke this as often as it likes and only
 * pays for a real embed when the text actually changed.
 *
 * `now` defaults to `Date.now()` but is accepted as a parameter (like the
 * `handleX(req, deps, now)` split used elsewhere in this package) so callers
 * — and tests — can pin it for a deterministic `updatedAt`.
 *
 * Deliberately does NOT special-case an elementType change with an unchanged
 * text hash: the stored `elementType` would go stale until the text next
 * changes. In the CURRENT schema this is unreachable, not just narrow: a
 * `TextNote`/`TextElement` each carry only their own text (nothing else to
 * change independently of it), a `ShapeElement` has no text field at all to
 * begin with, and moving an element between kinds means a NEW document in a
 * DIFFERENT subcollection — a new id, which is the deletion-cleanup trigger's
 * territory (the old id's embedding gets deleted, not left stale), not a
 * staleness case. The comment stays because the property is real: a future
 * element kind that pairs a stable id + mutable type + unchanged text would
 * hit it, and the answer would still be "accepted narrow staleness," not a
 * bug — but nothing in today's schema can reach it.
 */
export async function embedElement(
  db: Firestore,
  boardId: string,
  element: BoardElementInput,
  provider: EmbeddingProvider,
  now: number = Date.now()
): Promise<EmbedOutcome> {
  const existing = await getStoredEmbedding(db, boardId, element.id);
  const hash = contentHashFor(element.text);

  if (existing?.contentHash === hash) {
    return { embedded: false }; // skip: unchanged content — no provider call, no write.
  }

  const result = await provider.embed(element.text);
  if (!Array.isArray(result.vector) || result.vector.length !== EMBEDDING_DIMENSIONS) {
    // Fail loud rather than silently writing a vector Firestore's KNN index
    // can't use (or, past the 2048 cap, can't even store) — a wrong-length
    // vector here means the provider or model config drifted from
    // text-embedding-3-small, which the retrieval path assumes throughout.
    throw new Error(
      `embedElement: provider returned ${
        Array.isArray(result.vector) ? result.vector.length : typeof result.vector
      }-dimension vector, expected ${EMBEDDING_DIMENSIONS}`
    );
  }

  const doc: StoredEmbedding = {
    vector: FieldValue.vector(result.vector),
    text: element.text,
    elementType: element.elementType,
    contentHash: hash,
    updatedAt: now,
    schemaVersion: 1,
  };

  await embeddingRef(db, boardId, element.id).set(doc);

  return { embedded: true, model: result.model, usage: result.usage };
}
