import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

// Flashcard-generation memoization (Month 6). Mirrors ocrCache.ts's discipline
// exactly (same reasoning, kept as a sibling module rather than a shared import
// so the two AI features stay independent of each other): re-running generation
// on the same selection must be free. The result is keyed by a hash of the
// selected path ids and stored at `boards/{boardId}/flashcardCache/{hash}`.
// Editing/erasing a stroke changes its id, so a changed selection misses the
// cache naturally — no invalidation logic needed. Written via the Admin SDK;
// rules deny client writes (see firestore.rules' `flashcardCache` match block).

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
