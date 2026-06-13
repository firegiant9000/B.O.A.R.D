/**
 * Phase 12 (roadmap item 11) — background templates.
 *
 * Pure, board-space geometry for the non-interactive background layer that
 * renders *behind* every element (Appendix A.4 step 6). Each template is
 * expressed as a single repeating tile (`PatternSpec`) so the renderer can paint
 * it with one SVG `<Pattern>` + a cover rect — cheap at any zoom, no per-cell
 * element explosion. The coordinate plane additionally emphasizes the x = 0 /
 * y = 0 axes, drawn over the grid by the renderer (not part of the tile).
 *
 * Everything here is deterministic and unit-tested; nothing touches React or
 * react-native-svg.
 */
import { Viewport, Bounds, screenToBoard } from "./viewport";
import { BackgroundTemplate } from "../types";

export type { BackgroundTemplate };

/** Selectable templates, in picker display order (blank first). */
export const BACKGROUND_TEMPLATES: BackgroundTemplate[] = [
  "blank",
  "grid",
  "dots",
  "lined",
  "isometric",
  "coordinate",
];

export const DEFAULT_BACKGROUND: BackgroundTemplate = "blank";

// Board-space spacings. An 8 mm grid is ≈ 30 px at 96 dpi (1 mm ≈ 3.7795 px),
// which is the roadmap's named cell size; the others are tuned to read well next
// to it. These are board units, so they scale with zoom like every element.
export const GRID_SPACING = 30; // grid / dots / coordinate cell (8 mm)
export const LINE_SPACING = 32; // notebook rule height
export const ISO_SPACING = 32; // isometric horizontal period

export const GRID_COLOR = "#D8DEE9";
export const LINE_COLOR = "#DCE3EC";
export const AXIS_COLOR = "#94A3B8";

/** tan(30°) — the isometric rise/run; a tile of this aspect ratio tiles cleanly. */
export const ISO_TAN = Math.tan(Math.PI / 6);

export interface PatternLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PatternDot {
  cx: number;
  cy: number;
}

/**
 * One repeating tile, in board units, anchored at the tile origin (0,0). The
 * renderer maps this to an SVG `<Pattern patternUnits="userSpaceOnUse">` of
 * `width`×`height`; tiling from board origin keeps the grid aligned to (0,0) so
 * the coordinate-plane axes land on grid lines.
 */
export interface PatternSpec {
  width: number;
  height: number;
  lines: PatternLine[];
  dots: PatternDot[];
}

export function isBackgroundTemplate(v: unknown): v is BackgroundTemplate {
  return (
    typeof v === "string" &&
    (BACKGROUND_TEMPLATES as string[]).includes(v)
  );
}

/** Does this template draw a grid (used by the coordinate plane to add axes)? */
export function hasAxes(t: BackgroundTemplate): boolean {
  return t === "coordinate";
}

/**
 * The repeating tile for a template, or `null` when nothing should be painted
 * ("blank"). "coordinate" returns the same grid tile as "grid"; its axes are an
 * overlay the renderer adds on top, not part of the tile.
 */
export function patternSpec(t: BackgroundTemplate): PatternSpec | null {
  switch (t) {
    case "blank":
      return null;
    case "grid":
    case "coordinate": {
      const g = GRID_SPACING;
      return {
        width: g,
        height: g,
        // Left + top edge of each cell; tiling fills out the full grid.
        lines: [
          { x1: 0, y1: 0, x2: 0, y2: g },
          { x1: 0, y1: 0, x2: g, y2: 0 },
        ],
        dots: [],
      };
    }
    case "dots": {
      const g = GRID_SPACING;
      // A single dot per lattice point; tiling repeats it across the plane.
      return { width: g, height: g, lines: [], dots: [{ cx: 0, cy: 0 }] };
    }
    case "lined": {
      // Horizontal rules only; width is arbitrary (the line spans the tile).
      return {
        width: LINE_SPACING,
        height: LINE_SPACING,
        lines: [{ x1: 0, y1: 0, x2: LINE_SPACING, y2: 0 }],
        dots: [],
      };
    }
    case "isometric": {
      // A tile of height = width·tan30° makes the ±30° diagonals continue
      // seamlessly across tile seams (the diagonal's rise over one period equals
      // exactly one tile height). Verticals come from the left-edge line.
      const w = ISO_SPACING;
      const h = w * ISO_TAN;
      return {
        width: w,
        height: h,
        lines: [
          { x1: 0, y1: 0, x2: 0, y2: h }, // vertical
          { x1: 0, y1: 0, x2: w, y2: h }, // +30° diagonal
          { x1: 0, y1: h, x2: w, y2: 0 }, // −30° diagonal
        ],
        dots: [],
      };
    }
    default:
      return null;
  }
}

/**
 * Board-space rectangle currently visible through `vp` on a `width`×`height`
 * screen, optionally grown by `pad` screen px on every side so a pan never
 * exposes an unpainted edge before the next frame.
 */
export function visibleBoardBounds(
  vp: Viewport,
  width: number,
  height: number,
  pad = 0
): Bounds {
  const tl = screenToBoard(vp, { x: -pad, y: -pad });
  const br = screenToBoard(vp, { x: width + pad, y: height + pad });
  return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y };
}
