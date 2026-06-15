/**
 * Client-side shape recognition / auto-perfect (Month 4, Phase 9).
 *
 * Pure board-space geometry — no model, no network, $0 (Appendix B.3). Given the
 * point list of a just-finished freehand stroke, decide whether it cleanly
 * resembles one of the four solid primitives (line / rect / ellipse / triangle)
 * and, if so, return the axis-aligned geometry to replace it with a crisp
 * `ShapeElement`. Arrow detection is intentionally out of scope for v1: a freehand
 * arrowhead is unreliable to detect and the plan's gate is "90%+ on the four
 * primitives", with the user always able to decline.
 *
 * The classifier biases toward *rejectable* false positives (Phase 9 risk row):
 * an unrecognized squiggle returns `null` rather than a wrong guess, and every
 * match carries a confidence the caller can gate on. It is deliberately kept out
 * of the components so it is unit-testable in isolation with fixture point arrays
 * (the Phase 9 test gate).
 */

import { Point, boundsOfPoints } from "./viewport";
import { rdpSimplify } from "./simplify";
import { ShapeKind } from "../types";

/** The primitives the classifier can produce. A subset of `ShapeKind` (no arrow). */
export type RecognizableKind = "line" | "rect" | "ellipse" | "triangle";

/**
 * A recognized primitive, in board-space. rect/ellipse/triangle carry a positive
 * (x,y,width,height) box (the convention `ShapeElement` and `shapes.ts` expect);
 * line carries the start at (x,y) and the vector (width,height) to its end, so its
 * width/height may be negative — matching the line/arrow storage convention.
 */
export interface RecognizedShape {
  kind: RecognizableKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0..1 — how cleanly the stroke fit the primitive. */
  confidence: number;
}

// --- Tunables (board units / dimensionless ratios) ---------------------------

// Too few points to be a deliberate shape (a tap / flick).
const MIN_POINTS = 8;
// Below this bbox diagonal a stroke is a dot/jot, not a shape worth perfecting.
const MIN_DIAGONAL = 12;
// A stroke whose endpoints are within this fraction of the bbox diagonal is
// treated as a closed loop (rect / ellipse / triangle); otherwise it's open.
const CLOSED_FRACTION = 0.3;
// Mean perpendicular deviation from the chord, over the path length, under which
// an *open* stroke reads as a straight line.
const LINE_TOLERANCE = 0.07;
// Mean normalized fit error below which a closed stroke reads as that primitive.
const ELLIPSE_TOLERANCE = 0.12;
const RECT_TOLERANCE = 0.045;
// RDP corner-extraction tolerance, as a fraction of the bbox diagonal.
const CORNER_FRACTION = 0.06;
// Reject anything the heuristics aren't reasonably sure about.
const MIN_CONFIDENCE = 0.55;

/** Euclidean distance between two points. */
function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Total arc length of a polyline. */
function pathLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

/** Perpendicular distance from `p` to the infinite line through a→b. */
function perpDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = Math.hypot(dx, dy);
  if (denom === 0) return dist(p, a);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / denom;
}

/**
 * Mean deviation of every point from the chord between the endpoints, normalized
 * by the chord length. Near 0 for a ruler-straight stroke.
 */
function straightnessError(points: Point[]): number {
  const a = points[0];
  const b = points[points.length - 1];
  const chord = dist(a, b);
  if (chord === 0) return Infinity;
  let sum = 0;
  for (const p of points) sum += perpDistance(p, a, b);
  return sum / points.length / chord;
}

/**
 * Mean radial error of the points against the bbox-inscribed ellipse. Each point
 * is mapped into the unit circle (u = (x-cx)/a, v = (y-cy)/b); the error is the
 * mean |hypot(u,v) - 1|. Dimensionless: ~0 for a clean ellipse, ~0.2 for a rect.
 */
function ellipseError(points: Point[], cx: number, cy: number, a: number, b: number): number {
  const ax = Math.max(a, 0.5);
  const by = Math.max(b, 0.5);
  let sum = 0;
  for (const p of points) {
    const u = (p.x - cx) / ax;
    const v = (p.y - cy) / by;
    sum += Math.abs(Math.hypot(u, v) - 1);
  }
  return sum / points.length;
}

/**
 * Mean distance of the points to the nearest edge of the bbox rectangle,
 * normalized by the diagonal. ~0 for a clean rectangle (every point sits on the
 * perimeter); larger for an ellipse/triangle whose interior pulls points off it.
 */
function rectError(
  points: Point[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  diag: number
): number {
  if (diag === 0) return Infinity;
  let sum = 0;
  for (const p of points) {
    const dLeft = Math.abs(p.x - minX);
    const dRight = Math.abs(p.x - maxX);
    const dTop = Math.abs(p.y - minY);
    const dBottom = Math.abs(p.y - maxY);
    sum += Math.min(dLeft, dRight, dTop, dBottom);
  }
  return sum / points.length / diag;
}

/**
 * Number of dominant corners of a (closed) stroke, via RDP simplification at a
 * tolerance scaled to the shape's size. The near-duplicate closing vertex is
 * dropped so a clean triangle reports 3, a rect 4, and a smooth ellipse ≥ 5.
 */
function cornerCount(points: Point[], tolerance: number): number {
  const s = rdpSimplify(points, tolerance);
  if (s.length > 2 && dist(s[0], s[s.length - 1]) <= tolerance) {
    return s.length - 1;
  }
  return s.length;
}

function clampConfidence(error: number, tolerance: number): number {
  // Map error 0 → 1.0 confidence, error == tolerance → ~0.5, clamped to [0,1].
  const c = 1 - error / (2 * tolerance);
  return Math.max(0, Math.min(1, c));
}

/**
 * Classify a freehand stroke. Returns the matching primitive's board-space
 * geometry + confidence, or `null` when the stroke doesn't cleanly resemble any
 * supported primitive (the common case — most strokes are real drawing).
 */
export function recognizeShape(points: Point[]): RecognizedShape | null {
  if (!points || points.length < MIN_POINTS) return null;

  const bounds = boundsOfPoints(points);
  if (!bounds) return null;
  const { minX, minY, maxX, maxY } = bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  const diag = Math.hypot(width, height);
  if (diag < MIN_DIAGONAL) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const closed = dist(first, last) <= CLOSED_FRACTION * diag;

  // --- Open stroke: only a straight line is recognizable. -------------------
  if (!closed) {
    const err = straightnessError(points);
    if (err > LINE_TOLERANCE) return null;
    const confidence = clampConfidence(err, LINE_TOLERANCE);
    if (confidence < MIN_CONFIDENCE) return null;
    return {
      kind: "line",
      x: first.x,
      y: first.y,
      width: last.x - first.x,
      height: last.y - first.y,
      confidence,
    };
  }

  // --- Closed stroke: triangle / rect / ellipse. ----------------------------
  const cx = minX + width / 2;
  const cy = minY + height / 2;
  const ellErr = ellipseError(points, cx, cy, width / 2, height / 2);
  const rectErr = rectError(points, minX, minY, maxX, maxY, diag);
  const corners = cornerCount(points, diag * CORNER_FRACTION);

  const box = { x: minX, y: minY, width, height };

  // A clean triangle resolves to exactly three dominant corners and fits neither
  // a rectangle nor an ellipse well — the corner count is the deciding signal.
  if (corners === 3 && rectErr > RECT_TOLERANCE && ellErr > ELLIPSE_TOLERANCE) {
    // Confidence from how poorly it matched the other two (i.e. how clearly it's
    // a 3-gon), capped so a v1 axis-aligned triangle stays easy to decline.
    const confidence = Math.min(0.8, 0.5 + Math.min(rectErr, ellErr));
    if (confidence < MIN_CONFIDENCE) return null;
    return { kind: "triangle", ...box, confidence };
  }

  // Ellipse vs rectangle: pick the clearly-better fit that clears its tolerance.
  if (ellErr <= ELLIPSE_TOLERANCE && ellErr <= rectErr) {
    const confidence = clampConfidence(ellErr, ELLIPSE_TOLERANCE);
    if (confidence < MIN_CONFIDENCE) return null;
    return { kind: "ellipse", ...box, confidence };
  }
  if (rectErr <= RECT_TOLERANCE) {
    const confidence = clampConfidence(rectErr, RECT_TOLERANCE);
    if (confidence < MIN_CONFIDENCE) return null;
    return { kind: "rect", ...box, confidence };
  }

  return null;
}
