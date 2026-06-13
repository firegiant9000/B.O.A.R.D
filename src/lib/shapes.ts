/**
 * Shape geometry primitives (Phase 7).
 *
 * Pure, side-effect-free board-space math shared by the shape-creation gesture,
 * the SVG renderer, and hit-testing. Everything operates in board-space per the
 * Appendix A.1/A.3 hard rule — callers convert at paint time only. Kept out of
 * the components so it is unit-testable in isolation (snap / guide / constrain
 * math is the Phase 7 test gate).
 */

import { Bounds, Point, inflateBounds } from "./viewport";
import { ArrowheadStyle, ShapeElement, ShapeKind } from "../types";

// Snap-to-grid sizes offered in the toolbar (board units). 0 = snapping off.
export const GRID_SIZES = [8, 16, 24] as const;
// Smart-guide edge-alignment tolerance (board units) — roadmap item 7.
export const GUIDE_TOLERANCE = 8;
// Minimum board-space extent of a creation drag before it persists as a shape.
// Below this a drag is treated as a stray tap and discarded.
export const MIN_SHAPE_SIZE = 4;

/** The geometric subset of a shape needed for bbox / rendering math. */
export type ShapeGeometry = Pick<
  ShapeElement,
  | "shape"
  | "x"
  | "y"
  | "width"
  | "height"
  | "rotation"
  | "strokeWidth"
  | "arrowheadStart"
  | "arrowheadEnd"
>;

/** Visual styling fields of a shape. */
export type ShapeStyle = Pick<
  ShapeElement,
  "fill" | "stroke" | "strokeWidth" | "dashed" | "arrowheadStart" | "arrowheadEnd"
>;

/** An in-progress (not-yet-persisted) shape: everything needed to render it. */
export type ShapeDraft = ShapeGeometry & ShapeStyle;

/** Snap a single value to the nearest multiple of `grid`; identity when grid<=0. */
export function snapValue(v: number, grid: number): number {
  return grid > 0 ? Math.round(v / grid) * grid : v;
}

/** Snap a point to the grid (both axes). */
export function snapPoint(p: Point, grid: number): Point {
  return { x: snapValue(p.x, grid), y: snapValue(p.y, grid) };
}

/** Axis-aligned box (positive width/height) spanning two points — for rect/ellipse/triangle. */
export function rectFromPoints(
  start: Point,
  end: Point
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/**
 * Apply a shift-constrain to a creation drag: rect/ellipse/triangle become a
 * perfect square (preserving drag direction); line/arrow snap to the nearest 45°
 * while keeping their length. Returns the adjusted end point.
 */
export function constrainDraft(kind: ShapeKind, start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (kind === "line" || kind === "arrow") {
    const len = Math.hypot(dx, dy);
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: start.x + len * Math.cos(angle), y: start.y + len * Math.sin(angle) };
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: start.x + (dx < 0 ? -side : side),
    y: start.y + (dy < 0 ? -side : side),
  };
}

/** The corner/endpoint set of a shape, before rotation. */
export function shapeCorners(s: ShapeGeometry): Point[] {
  if (s.shape === "line" || s.shape === "arrow") {
    return [
      { x: s.x, y: s.y },
      { x: s.x + s.width, y: s.y + s.height },
    ];
  }
  return [
    { x: s.x, y: s.y },
    { x: s.x + s.width, y: s.y },
    { x: s.x + s.width, y: s.y + s.height },
    { x: s.x, y: s.y + s.height },
  ];
}

/** Board-space length added by an arrowhead at the given stroke width. */
export function arrowheadSize(strokeWidth: number): number {
  return strokeWidth * 3 + 6;
}

/**
 * Three points of the isosceles triangle inscribed in a shape's box: apex at
 * top-center, base spanning the bottom edge. Accepts negative width/height.
 */
export function trianglePoints(
  x: number,
  y: number,
  width: number,
  height: number
): Point[] {
  return [
    { x: x + width / 2, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

/**
 * Arrowhead barbs as a 3-point polygon: the tip plus two base points swept back
 * along `angle` (the direction the line points *toward* the tip).
 */
export function arrowheadPoints(tip: Point, angle: number, size: number): Point[] {
  const spread = Math.PI / 7;
  return [
    tip,
    {
      x: tip.x - size * Math.cos(angle - spread),
      y: tip.y - size * Math.sin(angle - spread),
    },
    {
      x: tip.x - size * Math.cos(angle + spread),
      y: tip.y - size * Math.sin(angle + spread),
    },
  ];
}

/**
 * Axis-aligned board-space bounding box of a shape, inflated by half the stroke
 * width (and by an arrowhead's reach when one is present). Honors `rotation` by
 * taking the AABB of the rotated corners, so the box stays valid once Phase 8
 * adds rotation.
 */
export function shapeBbox(s: ShapeGeometry): Bounds {
  let corners = shapeCorners(s);
  if (s.rotation) {
    const cx = s.x + s.width / 2;
    const cy = s.y + s.height / 2;
    const rad = (s.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    corners = corners.map((p) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    });
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of corners) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  let pad = s.strokeWidth / 2;
  const hasHead =
    s.shape === "arrow" &&
    (s.arrowheadStart !== "none" || s.arrowheadEnd !== "none");
  if (hasHead) pad = Math.max(pad, arrowheadSize(s.strokeWidth));
  return inflateBounds({ minX, minY, maxX, maxY }, pad);
}

export interface Guide {
  axis: "x" | "y";
  position: number;
}

export interface SnapResult {
  /** Offset to nudge the moving box by so an edge/center aligns; 0 when none. */
  dx: number;
  dy: number;
  guides: Guide[];
}

/**
 * Smart guides: find the closest edge/center alignment (left/centerX/right and
 * top/centerY/bottom) between the moving box and any target box within
 * `tolerance`. Returns the nudge that lands the alignment plus the guide lines to
 * draw. The nearest candidate per axis wins; no match → zero offset, no guides.
 */
export function computeGuides(
  moving: Bounds,
  targets: Bounds[],
  tolerance: number = GUIDE_TOLERANCE
): SnapResult {
  const movX = [moving.minX, (moving.minX + moving.maxX) / 2, moving.maxX];
  const movY = [moving.minY, (moving.minY + moving.maxY) / 2, moving.maxY];

  let bestX: { delta: number; position: number } | null = null;
  let bestY: { delta: number; position: number } | null = null;

  for (const t of targets) {
    const tX = [t.minX, (t.minX + t.maxX) / 2, t.maxX];
    const tY = [t.minY, (t.minY + t.maxY) / 2, t.maxY];
    for (const m of movX) {
      for (const tx of tX) {
        const d = tx - m;
        if (Math.abs(d) <= tolerance && (!bestX || Math.abs(d) < Math.abs(bestX.delta))) {
          bestX = { delta: d, position: tx };
        }
      }
    }
    for (const m of movY) {
      for (const ty of tY) {
        const d = ty - m;
        if (Math.abs(d) <= tolerance && (!bestY || Math.abs(d) < Math.abs(bestY.delta))) {
          bestY = { delta: d, position: ty };
        }
      }
    }
  }

  const guides: Guide[] = [];
  if (bestX) guides.push({ axis: "x", position: bestX.position });
  if (bestY) guides.push({ axis: "y", position: bestY.position });
  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides };
}

/** Parse `#RGB`/`#RRGGBB` into an `rgba()` string at the given alpha. */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
