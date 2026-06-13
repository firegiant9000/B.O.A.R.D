import {
  BACKGROUND_TEMPLATES,
  DEFAULT_BACKGROUND,
  GRID_SPACING,
  LINE_SPACING,
  ISO_SPACING,
  ISO_TAN,
  isBackgroundTemplate,
  hasAxes,
  patternSpec,
  visibleBoardBounds,
} from "../backgrounds";
import { IDENTITY_VIEWPORT } from "../viewport";

describe("isBackgroundTemplate", () => {
  it("accepts every listed template", () => {
    for (const t of BACKGROUND_TEMPLATES) expect(isBackgroundTemplate(t)).toBe(true);
  });
  it("rejects unknown / non-string values", () => {
    expect(isBackgroundTemplate("squares")).toBe(false);
    expect(isBackgroundTemplate(undefined)).toBe(false);
    expect(isBackgroundTemplate(42)).toBe(false);
    expect(isBackgroundTemplate(null)).toBe(false);
  });
  it("lists blank first as the default", () => {
    expect(BACKGROUND_TEMPLATES[0]).toBe("blank");
    expect(DEFAULT_BACKGROUND).toBe("blank");
  });
});

describe("hasAxes", () => {
  it("is true only for the coordinate plane", () => {
    expect(hasAxes("coordinate")).toBe(true);
    expect(hasAxes("grid")).toBe(false);
    expect(hasAxes("blank")).toBe(false);
  });
});

describe("patternSpec", () => {
  it("returns null for blank (nothing painted)", () => {
    expect(patternSpec("blank")).toBeNull();
  });

  it("grid is a square cell with a left + top edge line", () => {
    const s = patternSpec("grid")!;
    expect(s.width).toBe(GRID_SPACING);
    expect(s.height).toBe(GRID_SPACING);
    expect(s.lines).toHaveLength(2);
    expect(s.dots).toHaveLength(0);
  });

  it("coordinate reuses the grid tile (axes are an overlay, not the tile)", () => {
    expect(patternSpec("coordinate")).toEqual(patternSpec("grid"));
  });

  it("dots is one lattice dot per cell, no lines", () => {
    const s = patternSpec("dots")!;
    expect(s.dots).toEqual([{ cx: 0, cy: 0 }]);
    expect(s.lines).toHaveLength(0);
    expect(s.width).toBe(GRID_SPACING);
  });

  it("lined is a single horizontal rule at the rule height", () => {
    const s = patternSpec("lined")!;
    expect(s.height).toBe(LINE_SPACING);
    expect(s.lines).toHaveLength(1);
    const [l] = s.lines;
    expect(l.y1).toBe(0);
    expect(l.y2).toBe(0); // horizontal
  });

  it("isometric tile height = width*tan30 so diagonals tile seamlessly", () => {
    const s = patternSpec("isometric")!;
    expect(s.width).toBe(ISO_SPACING);
    expect(s.height).toBeCloseTo(ISO_SPACING * ISO_TAN, 6);
    expect(s.lines).toHaveLength(3); // vertical + two diagonals
    // The +30° diagonal spans exactly one tile in each axis (the tiling property).
    const diag = s.lines.find((l) => l.x1 === 0 && l.y1 === 0 && l.x2 === s.width);
    expect(diag).toBeDefined();
    expect(diag!.y2).toBeCloseTo(s.height, 6);
  });
});

describe("visibleBoardBounds", () => {
  it("maps the screen rect to board-space (identity viewport)", () => {
    const b = visibleBoardBounds(IDENTITY_VIEWPORT, 800, 600);
    expect(b.minX).toBeCloseTo(0);
    expect(b.minY).toBeCloseTo(0);
    expect(b.maxX).toBeCloseTo(800);
    expect(b.maxY).toBeCloseTo(600);
  });

  it("grows by the screen-space pad on every side", () => {
    const b = visibleBoardBounds(IDENTITY_VIEWPORT, 800, 600, 50);
    expect(b.minX).toBeCloseTo(-50);
    expect(b.minY).toBeCloseTo(-50);
    expect(b.maxX).toBeCloseTo(850);
    expect(b.maxY).toBeCloseTo(650);
  });

  it("accounts for pan + zoom", () => {
    // scale 2, panned so board origin sits at screen (100,100).
    const b = visibleBoardBounds({ x: 100, y: 100, scale: 2 }, 800, 600);
    // screenToBoard(0,0) = (-50,-50); screenToBoard(800,600) = (350,250).
    expect(b.minX).toBeCloseTo(-50);
    expect(b.minY).toBeCloseTo(-50);
    expect(b.maxX).toBeCloseTo(350);
    expect(b.maxY).toBeCloseTo(250);
  });
});
