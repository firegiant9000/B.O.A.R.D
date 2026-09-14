import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { RENDER_VERSION } from "./mathRender";

// Month 6 — math elements. Content-hash memoization for LaTeX → SVG path
// data, the third application of ocrCache.ts's discipline (flashcardCache.ts
// was the second): the result is keyed by a hash of the INPUT and stored at
// `boards/{boardId}/mathCache/{hash}`, so a changed input naturally misses
// and no invalidation logic is needed.
//
// TWO THINGS DIFFER FROM BOTH SIBLINGS, and both are deliberate:
//
// 1. The key hashes the LaTeX SOURCE, not a set of element ids. OCR and
//    flashcards key on WHICH strokes were selected (an id changes whenever a
//    stroke is edited, so identity is enough); an equation has no stroke ids,
//    its whole identity is its source text plus whether it was typeset in
//    display or inline mode.
//
// 2. The key also mixes in `RENDER_VERSION`. Those two cache a PROVIDER'S
//    answer, which does not change when this repo does; this one caches OUR
//    OWN rendering, which changes whenever the em size, the rounding, the
//    package list or the MathJax version changes. Without the version in the
//    key, bumping any of those would keep serving path data the current
//    renderer would no longer produce — and, because the element stores
//    `svgPath`, would keep serving it indefinitely.
//
// Scoping matches ocrCache/flashcardCache: PER BOARD, even though a rendering
// of `x^2` is identical on every board in the product. A single global
// `mathCache/{hash}` would render the same expression once for everyone, but
// it would also leak, through a `cached: true`, that somebody else on the
// platform had already typed that exact expression. Keeping the cache inside
// the tenancy boundary every other cache here respects is worth one extra
// ~1ms render per board.
//
// Written via the Admin SDK, which bypasses firestore.rules. Like
// flashcardCache — and UNLIKE ocrCache, which grants members a read — this
// collection has NO match block in firestore.rules: no client ever needs to
// read an entry, because a hit is served back through the same callable
// response as a miss and the client cannot tell them apart. It is denied for
// both read and write by the file's default deny.

/** Stable cache key for an expression: the LaTeX source, the typesetting
 *  mode, and the renderer's output version, hashed together. */
export function mathCacheKey(latex: string, displayMode: boolean): string {
  const canonical = `${RENDER_VERSION} ${displayMode ? "display" : "inline"} ${latex}`;
  return createHash("sha1").update(canonical).digest("hex");
}

/** The cached rendering. Dimensions are board units at `scale: 1`, exactly as
 *  `renderMath` returns them. */
export interface CachedMath {
  svgPath: string;
  width: number;
  height: number;
  createdAt: number;
}

export async function getCachedMath(
  db: Firestore,
  boardId: string,
  key: string
): Promise<CachedMath | null> {
  const snap = await db.doc(`boards/${boardId}/mathCache/${key}`).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<CachedMath> | undefined;
  // A stored document is data, not a promise. `typeof NaN === "number"`, so a
  // corrupt width/height would sail through a bare typeof check and reach the
  // client as a NaN-sized element; a missing/empty svgPath would render
  // nothing at all. Either way, treat the entry as a MISS and re-render —
  // failing closed here costs ~1ms, and trusting it costs a broken element.
  if (
    !data ||
    typeof data.svgPath !== "string" ||
    data.svgPath.length === 0 ||
    !Number.isFinite(data.width) ||
    !Number.isFinite(data.height) ||
    (data.width as number) <= 0 ||
    (data.height as number) <= 0
  ) {
    return null;
  }
  return {
    svgPath: data.svgPath,
    width: data.width as number,
    height: data.height as number,
    createdAt: Number.isFinite(data.createdAt) ? (data.createdAt as number) : 0,
  };
}

export async function putCachedMath(
  db: Firestore,
  boardId: string,
  key: string,
  value: CachedMath
): Promise<void> {
  await db.doc(`boards/${boardId}/mathCache/${key}`).set(value);
}
