/**
 * Board-space hit-testing primitives shared by the eraser and tap-to-select.
 *
 * Everything here operates in board-space (ROADMAP Appendix A.3 hard rule:
 * never hit-test in screen-space). Callers pair a cheap broad-phase bbox reject
 * (`boundsContainPoint`) with the narrow-phase polyline distance below.
 */

import { Bounds, Point } from "./viewport";

/** Shortest distance from point `p` to the segment a→b. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // Project p onto the segment, clamped to the [a,b] range.
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Shortest distance from `p` to a polyline; Infinity for an empty path. */
export function distanceToPolyline(points: Point[], p: Point): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y);
  let min = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d = distanceToSegment(p, points[i - 1], points[i]);
    if (d < min) min = d;
  }
  return min;
}

/** True if any part of the polyline is within `maxDist` of `p`. */
export function pointNearPolyline(points: Point[], p: Point, maxDist: number): boolean {
  return distanceToPolyline(points, p) <= maxDist;
}

/** True if `p` lies inside `b`, optionally grown by `pad` on every side. */
export function boundsContainPoint(b: Bounds, p: Point, pad = 0): boolean {
  return (
    p.x >= b.minX - pad &&
    p.x <= b.maxX + pad &&
    p.y >= b.minY - pad &&
    p.y <= b.maxY + pad
  );
}
