/**
 * Viewport culling (Phase 4).
 *
 * Renders only the elements whose board-space bounding box overlaps the region
 * currently on screen. The viewport (Phase 2) maps board-space to the screen and
 * every element carries a persisted board-space `bbox` (Phase 3), so culling is a
 * cheap axis-aligned box intersection test against the visible rect.
 */

import { Bounds, Viewport, screenToBoard } from "./viewport";

/**
 * Board-space rectangle currently visible under `vp` for a screen of `size`,
 * inflated by `marginPx` screen pixels on every side.
 *
 * The margin is a buffer ring: because culling is re-evaluated on a throttle
 * (not every frame), it keeps content just outside the edge mounted so a pan
 * reveals it without a one-frame pop-in. Expressing the margin in screen pixels
 * means it shrinks proportionally in board units as you zoom in — a constant
 * on-screen buffer at any zoom level.
 */
export function viewportBounds(
  vp: Viewport,
  size: { width: number; height: number },
  marginPx = 0
): Bounds {
  const topLeft = screenToBoard(vp, { x: -marginPx, y: -marginPx });
  const bottomRight = screenToBoard(vp, {
    x: size.width + marginPx,
    y: size.height + marginPx,
  });
  // `+ 0` collapses any -0 (from a zero margin at the origin) to +0 so the box
  // never carries a negative zero into comparisons or serialization.
  return {
    minX: topLeft.x + 0,
    minY: topLeft.y + 0,
    maxX: bottomRight.x + 0,
    maxY: bottomRight.y + 0,
  };
}

/** True if two axis-aligned boxes overlap. Touching edges count as overlap. */
export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY
  );
}
