import { tilePages, A4, TilePage } from "../pdfTiling";

/** Does `(x, y)` fall inside `page`'s rectangle? Half-open on both axes
 *  ([x, x+width), [y, y+height)) to match `tilePages`' own partition — a
 *  point exactly on a shared edge belongs to the page starting there, not
 *  both, so this doubles as the tool the "no more than intended overlap"
 *  test below uses to prove pages don't double-claim the same area. */
function pageContains(page: TilePage, x: number, y: number): boolean {
  return x >= page.x && x < page.x + page.width && y >= page.y && y < page.y + page.height;
}

function isCovered(pages: TilePage[], x: number, y: number): boolean {
  return pages.some((p) => pageContains(p, x, y));
}

/** Overlap area between two page rectangles — 0 for pages that only touch
 *  at a shared edge (measure-zero, not "overlapping" for tiling purposes). */
function overlapArea(a: TilePage, b: TilePage): number {
  const ox = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return ox * oy;
}

describe("tilePages", () => {
  it("returns one page for content smaller than a page", () => {
    const pages = tilePages({ width: 500, height: 500 }, A4);
    expect(pages).toHaveLength(1);
    // Not padded out to a full A4 page — sized to the content itself, since
    // there is nothing else to tile.
    expect(pages[0]).toEqual({ x: 0, y: 0, width: 500, height: 500 });
  });

  it("tiles a wide board across columns", () => {
    const pages = tilePages({ width: 2000, height: 500 }, A4);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => p.width <= A4.width)).toBe(true);
    // Strengthened: exact column count (ceil(2000/595) = 4), each page runs
    // the full board height (only one row is needed since 500 <= A4.height),
    // and the columns are contiguous with no gap — the last column's right
    // edge lands exactly on the board's right edge, not short of it.
    expect(pages).toHaveLength(4);
    expect(pages.every((p) => p.height === 500)).toBe(true);
    const sorted = [...pages].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].x).toBe(sorted[i - 1].x + sorted[i - 1].width);
    }
    expect(sorted[sorted.length - 1].x + sorted[sorted.length - 1].width).toBe(2000);
  });

  describe("covers the full board with no gaps (a board that does not divide evenly into pages)", () => {
    // 2000 / 595 = 3.36 columns, 1500 / 842 = 1.78 rows — neither dimension
    // divides evenly, which is exactly where an off-by-one (e.g. flooring
    // instead of ceiling the page count, or clipping the last row/column
    // instead of sizing it to what remains) leaves an uncovered strip at the
    // right or bottom edge. The brief's own version of this test only summed
    // page areas, which stays green even if pages overlap completely, sit at
    // the origin, or cover the wrong region — it can't fail on the defect
    // its own name describes. These assertions actually check coverage.
    const content = { width: 2000, height: 1500 };
    const pages = tilePages(content, A4);

    it("produces the expected 4x2 grid (ceil, not floor, on both axes)", () => {
      expect(pages).toHaveLength(8);
    });

    it("reaches exactly to the board's right and bottom edges — no missing edge strip", () => {
      const maxX = Math.max(...pages.map((p) => p.x + p.width));
      const maxY = Math.max(...pages.map((p) => p.y + p.height));
      expect(maxX).toBe(content.width);
      expect(maxY).toBe(content.height);
    });

    it("covers every sampled point of the board, including the trimmed last row/column", () => {
      // An irregular step (not a divisor of the page size) so the sample
      // grid doesn't accidentally land only on tile boundaries. Includes the
      // last pixel of each axis explicitly, since that's exactly where a
      // dropped last row/column would first go uncovered.
      const misses: Array<[number, number]> = [];
      for (let x = 0; x < content.width; x += 37) {
        for (let y = 0; y < content.height; y += 53) {
          if (!isCovered(pages, x, y)) misses.push([x, y]);
        }
      }
      if (!isCovered(pages, content.width - 1, content.height - 1)) {
        misses.push([content.width - 1, content.height - 1]);
      }
      expect(misses).toEqual([]);
    });

    it("does not overlap pages beyond their shared (measure-zero) edges", () => {
      let totalOverlap = 0;
      for (let i = 0; i < pages.length; i++) {
        for (let j = i + 1; j < pages.length; j++) {
          totalOverlap += overlapArea(pages[i], pages[j]);
        }
      }
      expect(totalOverlap).toBe(0);
    });

    it("sums to exactly the board's area (not merely >=) given zero overlap and full coverage", () => {
      // The brief's literal test asserted >= here, which a set of fully
      // overlapping or misplaced pages could also satisfy. With the no-
      // overlap and full-coverage properties both proven above, area sums to
      // exactly the board's area — a strictly stronger and more specific
      // claim than the brief's floor.
      const covered = pages.reduce((a, p) => a + p.width * p.height, 0);
      expect(covered).toBe(content.width * content.height);
    });
  });
});
