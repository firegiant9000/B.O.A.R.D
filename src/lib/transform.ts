/**
 * Group-transform geometry (Phase 8). Pure board-space math shared by the
 * selection-move drag, marquee hit-testing, and duplicate offset. Resize/rotate
 * transforms are deferred to the Phase 8 follow-up; this module is translation
 * only for now, kept side-effect-free so it unit-tests without React/Firestore.
 */

import { Bounds, Point } from "./viewport";
import { boundsIntersect } from "./culling";

/** Offset 16 board units down-right for duplicated elements (matches Phase 10). */
export const DUPLICATE_OFFSET = 16;

export function translatePoint(p: Point, dx: number, dy: number): Point {
  return { x: p.x + dx, y: p.y + dy };
}

export function translatePoints(points: Point[], dx: number, dy: number): Point[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function translateBounds(b: Bounds, dx: number, dy: number): Bounds {
  return {
    minX: b.minX + dx,
    minY: b.minY + dy,
    maxX: b.maxX + dx,
    maxY: b.maxY + dy,
  };
}

/** Axis-aligned box spanning two drag corners, normalized to positive extent. */
export function marqueeBounds(a: Point, b: Point): Bounds {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

/**
 * Marquee selection rule: an element is selected when its bbox *touches* the
 * marquee (intersect, not full containment) — the forgiving behavior users
 * expect from a rubber-band drag.
 */
export function boundsInMarquee(elementBox: Bounds, marquee: Bounds): boolean {
  return boundsIntersect(elementBox, marquee);
}

// --- Pass 2: resize / rotate transforms ---
//
// A handle drag is a single similarity transform (scale-about-anchor OR
// rotate-about-center, never both at once) recomputed from the pre-drag state
// each frame, so there is no accumulation drift. Scale factors are clamped to a
// small positive minimum — no flipping in this pass.

/** Floor for scale factors so a drag past the anchor can't invert/collapse an element. */
export const MIN_SCALE_FACTOR = 0.02;

export function scalePointAbout(p: Point, anchor: Point, sx: number, sy: number): Point {
  return {
    x: anchor.x + (p.x - anchor.x) * sx,
    y: anchor.y + (p.y - anchor.y) * sy,
  };
}

export function rotatePointAbout(p: Point, center: Point, theta: number): Point {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/** Scale a box about an anchor (corners scale independently, then re-normalize). */
export function scaleBoundsAbout(b: Bounds, anchor: Point, sx: number, sy: number): Bounds {
  const a = scalePointAbout({ x: b.minX, y: b.minY }, anchor, sx, sy);
  const c = scalePointAbout({ x: b.maxX, y: b.maxY }, anchor, sx, sy);
  return marqueeBounds(a, c);
}

/** SVG `matrix(...)` string for a scale about an anchor (live resize preview). */
export function resizeMatrix(anchor: Point, sx: number, sy: number): string {
  const e = anchor.x * (1 - sx);
  const f = anchor.y * (1 - sy);
  return `matrix(${sx}, 0, 0, ${sy}, ${e}, ${f})`;
}

/** SVG `matrix(...)` string for a rotation (radians) about a center (live rotate preview). */
export function rotateMatrix(center: Point, theta: number): string {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const e = center.x - center.x * cos + center.y * sin;
  const f = center.y - center.x * sin - center.y * cos;
  return `matrix(${cos}, ${sin}, ${-sin}, ${cos}, ${e}, ${f})`;
}
