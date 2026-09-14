/**
 * Month 6 — pure tiling math for multi-page board export.
 *
 * A board can be arbitrarily large; a single print/PDF page can't show it at
 * a legible scale, so a large board is split into a grid of page-sized
 * tiles, each covering one non-overlapping rectangle of the content, at the
 * SAME scale as the page itself (one content unit == one page unit). That
 * matters for reassembly: every full-size tile ends up exactly one page's
 * worth of content, so adjacent printed pages line up edge-to-edge instead
 * of each tile being independently stretched to fill its page (which would
 * make neighboring tiles disagree on scale the moment one of them is a
 * trimmed edge tile smaller than a full page).
 *
 * This module has no rendering opinion at all — it only computes rectangles.
 * The caller (`recapExport.ts#exportBoardPdf`) turns each rectangle into an
 * actual page by calling `svgExport.ts#toSvgDocument(elements, tileBounds)`,
 * exactly the way it already does for the single-page SVG export case.
 */

/** A plain width/height, with no position — used both for the page size
 *  passed in and the content size being tiled. */
export interface PageSize {
  width: number;
  height: number;
}

/** One page's rectangle, in the SAME coordinate space as the `content`
 *  argument passed to `tilePages` — i.e. relative to the content's own
 *  (0, 0) origin, not necessarily the board's absolute coordinate space. A
 *  caller tiling real board content (whose bounds don't start at the
 *  origin — see `SvgExportBounds`) translates by its own `bounds.x`/`bounds.y`
 *  when building each page's actual export bounds. */
export interface TilePage {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A4 portrait, in PDF points (72 DPI) — the same unit `expo-print`'s
 * `Print.printToFileAsync({ width, height })` takes for its own page size
 * ("in pixels", defaulting to 612x792 for US Letter at 72 PPI). Passing
 * `A4.width`/`A4.height` straight through to that call keeps the physical
 * printed page in lockstep with this module's tiling math — no separate
 * scaling step, and no distortion between a full interior tile and the
 * physical page it lands on.
 */
export const A4: PageSize = { width: 595, height: 842 };

/**
 * Splits a `content` rectangle into a row-major grid of `page`-sized tiles
 * that together cover `content` exactly once: no gaps, no overlap beyond the
 * measure-zero edges two adjacent tiles share. Every tile is exactly
 * `page.width` x `page.height` except the last column (trimmed to whatever
 * width remains after the full columns before it) and the last row (same,
 * for height) — trimmed to fit rather than clipped-and-dropped, so a content
 * size that doesn't divide evenly by the page size never leaves an uncovered
 * strip at the right or bottom edge. Content that fits within a single page
 * in both dimensions returns exactly one page sized to the content itself
 * (not padded out to a full page) — there is nothing else to tile.
 */
export function tilePages(content: PageSize, page: PageSize): TilePage[] {
  const cols = Math.max(1, Math.ceil(content.width / page.width));
  const rows = Math.max(1, Math.ceil(content.height / page.height));
  const pages: TilePage[] = [];
  for (let row = 0; row < rows; row++) {
    const y = row * page.height;
    const height = Math.min(page.height, content.height - y);
    for (let col = 0; col < cols; col++) {
      const x = col * page.width;
      const width = Math.min(page.width, content.width - x);
      pages.push({ x, y, width, height });
    }
  }
  return pages;
}
