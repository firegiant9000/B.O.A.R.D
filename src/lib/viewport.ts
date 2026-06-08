/**
 * Board-space coordinate model.
 *
 * Every element (path point, text element, note) is stored in *board-space*.
 * The viewport maps board-space onto the screen at paint time:
 *
 *   screen = viewport.x + boardPoint * viewport.scale
 *   board  = (screenPoint - viewport.x) / viewport.scale
 *
 * `x`/`y` are a screen-space pixel offset (the board origin's on-screen
 * position); `scale` is the zoom factor. The identity viewport {0,0,1} makes
 * board-space === screen-space, so content authored before this model (raw
 * locationX/Y) renders unchanged at the default zoom — no migration needed.
 */

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_SCALE = 0.1; // 10%
export const MAX_SCALE = 8; // 800%

export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Convert a screen-space point to board-space under the given viewport. */
export function screenToBoard(vp: Viewport, p: Point): Point {
  return {
    x: (p.x - vp.x) / vp.scale,
    y: (p.y - vp.y) / vp.scale,
  };
}

/** Convert a board-space point to screen-space under the given viewport. */
export function boardToScreen(vp: Viewport, p: Point): Point {
  return {
    x: p.x * vp.scale + vp.x,
    y: p.y * vp.scale + vp.y,
  };
}

/** Translate the viewport by a screen-space delta. */
export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, x: vp.x + dx, y: vp.y + dy };
}

/**
 * Zoom toward a screen-space focal point (cursor / pinch center), keeping the
 * board point under the focal fixed. `factor` multiplies the current scale.
 */
export function zoomAtPoint(vp: Viewport, factor: number, focal: Point): Viewport {
  const nextScale = clampScale(vp.scale * factor);
  if (nextScale === vp.scale) return vp;
  // Board point currently under the focal must stay under the focal.
  const board = screenToBoard(vp, focal);
  return {
    scale: nextScale,
    x: focal.x - board.x * nextScale,
    y: focal.y - board.y * nextScale,
  };
}

/** Set an absolute scale while keeping the given screen focal point fixed. */
export function zoomToScale(vp: Viewport, nextScaleRaw: number, focal: Point): Viewport {
  const nextScale = clampScale(nextScaleRaw);
  if (nextScale === vp.scale) return vp;
  const board = screenToBoard(vp, focal);
  return {
    scale: nextScale,
    x: focal.x - board.x * nextScale,
    y: focal.y - board.y * nextScale,
  };
}

/** Axis-aligned bounds of a set of board-space points; null if empty. */
export function boundsOfPoints(points: Point[]): Bounds | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Grow bounds outward by `pad` on every side (e.g. half a stroke width). */
export function inflateBounds(b: Bounds, pad: number): Bounds {
  return {
    minX: b.minX - pad,
    minY: b.minY - pad,
    maxX: b.maxX + pad,
    maxY: b.maxY + pad,
  };
}

/** Union of several bounds; null if all inputs are null. */
export function unionBounds(all: (Bounds | null)[]): Bounds | null {
  let acc: Bounds | null = null;
  for (const b of all) {
    if (!b) continue;
    acc = acc
      ? {
          minX: Math.min(acc.minX, b.minX),
          minY: Math.min(acc.minY, b.minY),
          maxX: Math.max(acc.maxX, b.maxX),
          maxY: Math.max(acc.maxY, b.maxY),
        }
      : b;
  }
  return acc;
}

/**
 * Compute a viewport that fits `content` bounds into a viewport of `size`
 * (screen px) with padding, centered. Returns the identity viewport when the
 * content is empty or degenerate.
 */
export function fitToBounds(
  content: Bounds | null,
  size: { width: number; height: number },
  padding = 40
): Viewport {
  if (!content || size.width <= 0 || size.height <= 0) return IDENTITY_VIEWPORT;
  const contentW = content.maxX - content.minX;
  const contentH = content.maxY - content.minY;
  if (contentW <= 0 && contentH <= 0) {
    // Single point — center it at 100%.
    return { scale: 1, x: size.width / 2 - content.minX, y: size.height / 2 - content.minY };
  }
  const availW = Math.max(1, size.width - padding * 2);
  const availH = Math.max(1, size.height - padding * 2);
  const scale = clampScale(
    Math.min(availW / Math.max(contentW, 1), availH / Math.max(contentH, 1))
  );
  // Center the content box in the viewport.
  const centerX = (content.minX + content.maxX) / 2;
  const centerY = (content.minY + content.maxY) / 2;
  return {
    scale,
    x: size.width / 2 - centerX * scale,
    y: size.height / 2 - centerY * scale,
  };
}
