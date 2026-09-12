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
// (outside this file's scope; see the note below) keeps in sync with the
// element's current content.
//
// SCOPE NOTE: this file is the memoized write itself — `embedElement` is
// deliberately safe to call as often as a caller likes, since an unchanged
// hash is a no-op. The trigger that watches canvas-content writes and calls
// this on a settled edit, and the debounce window that coalesces a burst of
// rapid edits into one call, are production wiring around this contract, not
// something the contract itself needs in order to be correct or testable.
// No such trigger is registered yet — see this task's report.
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

/** The provider seam for turning text into a vector — mirrors `AIProvider`'s
 *  role in provider.ts, kept as its own narrow interface here since
 *  embedding is a different API shape (text in, vector out) than chat. */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/** The minimal shape `embedElement` needs from a canvas-content element —
 *  callers (paths/notes/textElements/shapes) adapt their own richer element
 *  types down to this before calling in. */
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
 * changes. That is an accepted, narrow metadata staleness (the id and text
 * stay correct, so retrieval still finds and cites the right content) rather
 * than a second write path that bypasses the hash-skip and undoes the exact
 * cost control this function exists to provide.
 */
export async function embedElement(
  db: Firestore,
  boardId: string,
  element: BoardElementInput,
  provider: EmbeddingProvider,
  now: number = Date.now()
): Promise<void> {
  const ref = db.doc(`boards/${boardId}/embeddings/${element.id}`);
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data() as Partial<StoredEmbedding> | undefined) : undefined;
  const hash = contentHashFor(element.text);

  if (existing?.contentHash === hash) {
    return; // skip: unchanged content — no provider call, no write.
  }

  const vector = await provider.embed(element.text);
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
    // Fail loud rather than silently writing a vector Firestore's KNN index
    // can't use (or, past the 2048 cap, can't even store) — a wrong-length
    // vector here means the provider or model config drifted from
    // text-embedding-3-small, which the retrieval path assumes throughout.
    throw new Error(
      `embedElement: provider returned ${
        Array.isArray(vector) ? vector.length : typeof vector
      }-dimension vector, expected ${EMBEDDING_DIMENSIONS}`
    );
  }

  const doc: StoredEmbedding = {
    vector: FieldValue.vector(vector),
    text: element.text,
    elementType: element.elementType,
    contentHash: hash,
    updatedAt: now,
    schemaVersion: 1,
  };

  await ref.set(doc);
}
