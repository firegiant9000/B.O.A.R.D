/**
 * Ramer–Douglas–Peucker polyline simplification.
 *
 * Reduces the number of points in a freehand stroke while preserving its shape,
 * dropping points that lie within `epsilon` of the line between their retained
 * neighbours. Applied in board-space *before* the Firestore write so the network
 * and storage cost — and downstream render cost — scale with stroke complexity
 * rather than gesture frame rate.
 *
 * `epsilon` is in board units (≈ screen px at 100% zoom). At higher zoom the same
 * tolerance preserves more detail (board units are smaller per screen px), which
 * is the desired behaviour.
 */

import { Point } from "./viewport";

/** Perpendicular distance from `p` to the segment a→b. */
function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  // Distance from point to the infinite line through a,b.
  const num = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x);
  return num / Math.hypot(dx, dy);
}

export function rdpSimplify(points: Point[], epsilon: number = 2.5): Point[] {
  if (points.length <= 2 || epsilon <= 0) return points;

  // Find the point farthest from the chord between the endpoints.
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }

  if (maxDist <= epsilon) {
    // Whole run is within tolerance — collapse to its endpoints.
    return [first, last];
  }

  // Keep the farthest point and recurse on each half.
  const left = rdpSimplify(points.slice(0, index + 1), epsilon);
  const right = rdpSimplify(points.slice(index), epsilon);
  // `index` is shared between halves — drop the duplicate.
  return [...left.slice(0, -1), ...right];
}
