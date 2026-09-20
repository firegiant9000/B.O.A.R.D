import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

// Flashcard-generation memoization (Month 6). Mirrors ocrCache.ts's discipline
// exactly (same reasoning, kept as a sibling module rather than a shared import
// so the two AI features stay independent of each other): re-running generation
// on the same selection must be free. The result is keyed by a hash of the
// selected path ids and stored at `boards/{boardId}/flashcardCache/{hash}`.
// Editing/erasing a stroke changes its id, so a changed selection misses the
// cache naturally — no invalidation logic needed. Written via the Admin SDK,
// which bypasses firestore.rules.
//
// UNLIKE ocrCache.ts, this collection has no explicit match block in
// firestore.rules at all — deliberately: no client ever needs to read a
// flashcard-generation cache entry (a cache hit is served back through the
// SAME callable response as a live generation, so the client never
// distinguishes them), so there is no read to grant. It is denied for both
// read and write by the file's default deny, not by a rule that names it.
// Net effect, worth knowing before adding a reader: a board member CAN read
// `ocrCache` (that one has a `allow read: if isBoardMember(boardId)` block,
// since the client surfaces a cached OCR result) but CANNOT read
// `flashcardCache`. If a future feature needs to read a cached generation
// client-side, add a match block mirroring ocrCache's read rule rather than
// assuming this default-deny grants nothing worth guarding — it already does.

/** Stable cache key for a selection: sorted path ids, hashed. Order-independent
 *  so the same set of strokes always hits, regardless of selection order.
 *  Identical construction to ocrCache.ts's `ocrCacheKey` — see that file's
 *  comment for why a selection's identity is exactly this. */
export function flashcardCacheKey(pathIds: string[]): string {
  const canonical = [...pathIds].sort().join(",");
  return createHash("sha1").update(canonical).digest("hex");
}

/** One generated front/back pair. */
export interface FlashcardPair {
  front: string;
  back: string;
}

/** The cached generation result. `model` is carried so a cache hit can still
 *  report which model produced it, mirroring CachedOcr. */
export interface CachedFlashcards {
  cards: FlashcardPair[];
  model: string;
  createdAt: number;
}

export async function getCachedFlashcards(
  db: Firestore,
  boardId: string,
  key: string
): Promise<CachedFlashcards | null> {
  const snap = await db.doc(`boards/${boardId}/flashcardCache/${key}`).get();
  return snap.exists ? (snap.data() as CachedFlashcards) : null;
}

export async function putCachedFlashcards(
  db: Firestore,
  boardId: string,
  key: string,
  value: CachedFlashcards
): Promise<void> {
  await db.doc(`boards/${boardId}/flashcardCache/${key}`).set(value);
}
