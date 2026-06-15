import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

// OCR memoization (Month 4, Phase 10 — Appendix B.3 caching). Re-running OCR on
// the same selection must be free: the result is keyed by a hash of the selected
// path ids and stored at `boards/{boardId}/ocrCache/{hash}`. Editing/erasing a
// stroke changes its id, so a changed selection misses the cache naturally — no
// invalidation logic needed. Written via the Admin SDK; rules deny client writes.

/** Stable cache key for a selection: sorted path ids, hashed. Order-independent
 *  so the same set of strokes always hits, regardless of selection order. */
export function ocrCacheKey(pathIds: string[]): string {
  const canonical = [...pathIds].sort().join(",");
  return createHash("sha1").update(canonical).digest("hex");
}

/** The cached OCR result. `confidence`/`source`/`model` are carried so a cache
 *  hit reproduces the same low-confidence badge the live call would have shown. */
export interface CachedOcr {
  text: string;
  confidence: number;
  source: "vision" | "gpt";
  model: string;
  createdAt: number;
}

export async function getCachedOcr(
  db: Firestore,
  boardId: string,
  key: string
): Promise<CachedOcr | null> {
  const snap = await db.doc(`boards/${boardId}/ocrCache/${key}`).get();
  return snap.exists ? (snap.data() as CachedOcr) : null;
}

export async function putCachedOcr(
  db: Firestore,
  boardId: string,
  key: string,
  value: CachedOcr
): Promise<void> {
  await db.doc(`boards/${boardId}/ocrCache/${key}`).set(value);
}
