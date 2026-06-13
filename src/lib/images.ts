/**
 * Image geometry + downscale math (Phase 9).
 *
 * Pure, side-effect-free board-space helpers shared by the image service, the
 * SVG renderer, hit-testing, and the platform picker/manipulator adapter. Kept
 * out of the components/services so the sizing + bbox math is unit-testable in
 * isolation (no Firebase, no native module, no DOM). Operates in board-space per
 * the Appendix A.1/A.3 rule — callers convert at paint time only.
 */

import { Bounds, Point, inflateBounds } from "./viewport";
import { ImageElement } from "../types";

// Long-edge ceilings (px). Originals are downscaled to MAX_IMAGE_DIM before
// upload (roadmap: ≤ 2048px long edge); thumbnails to THUMBNAIL_DIM.
export const MAX_IMAGE_DIM = 2048;
export const THUMBNAIL_DIM = 256;
// Default long-edge of a freshly-inserted image in board units, so a large
// photo lands at a sane on-canvas size rather than thousands of units wide.
export const DEFAULT_PLACED_LONG_EDGE = 360;

/** The geometric subset of an image needed for bbox math. */
export type ImageGeometry = Pick<
  ImageElement,
  "x" | "y" | "width" | "height" | "rotation"
>;

/** Blob + its pixel dimensions, as produced by the platform prepare step. */
export interface PreparedAsset {
  blob: Blob;
  width: number;
  height: number;
}

/** A picked-and-downscaled image ready to upload: full-size + thumbnail + the
 *  source's natural pixel dimensions (for aspect-preserving placement). */
export interface PreparedImage {
  full: PreparedAsset;
  thumbnail: PreparedAsset;
  naturalWidth: number;
  naturalHeight: number;
  alt: string;
}

/**
 * Scale (w,h) down so its long edge is ≤ `maxEdge`, preserving aspect ratio.
 * Never upscales (factor is clamped to ≤ 1). Returns integer pixel dimensions.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / longest);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Board-space box (positive width/height) for a freshly-inserted image: the
 * source aspect fitted into `longEdge`, centered on the given board-space point.
 */
export function placementBox(
  naturalWidth: number,
  naturalHeight: number,
  center: Point,
  longEdge: number = DEFAULT_PLACED_LONG_EDGE
): { x: number; y: number; width: number; height: number } {
  const { width, height } = fitWithin(naturalWidth, naturalHeight, longEdge);
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}

/**
 * Axis-aligned board-space bounding box of an image. Honors `rotation` by taking
 * the AABB of the rotated corners (mirrors `shapeBbox` for box shapes, minus the
 * stroke inflation an image doesn't have).
 */
export function imageBbox(img: ImageGeometry): Bounds {
  const w = Math.abs(img.width);
  const h = Math.abs(img.height);
  const x = Math.min(img.x, img.x + img.width);
  const y = Math.min(img.y, img.y + img.height);
  let corners: Point[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  if (img.rotation) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rad = (img.rotation * Math.PI) / 180;
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
  return inflateBounds({ minX, minY, maxX, maxY }, 0);
}
