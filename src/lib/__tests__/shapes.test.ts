import {
  snapValue,
  snapPoint,
  rectFromPoints,
  constrainDraft,
  shapeBbox,
  trianglePoints,
  arrowheadPoints,
  computeGuides,
  hexToRgba,
  ShapeGeometry,
} from "../shapes";

describe("snapValue / snapPoint", () => {
  it("rounds to the nearest grid multiple", () => {
    expect(snapValue(11, 8)).toBe(8);
    expect(snapValue(13, 8)).toBe(16);
    expect(snapValue(-5, 8)).toBe(-8);
  });
  it("is identity when the grid is off (<=0)", () => {
    expect(snapValue(13, 0)).toBe(13);
    expect(snapPoint({ x: 13, y: 27 }, 0)).toEqual({ x: 13, y: 27 });
  });
  it("snaps both axes", () => {
    expect(snapPoint({ x: 13, y: 27 }, 8)).toEqual({ x: 16, y: 24 });
  });
});

describe("rectFromPoints", () => {
  it("normalizes to a positive-extent box regardless of drag direction", () => {
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 4, y: 30 })).toEqual({
      x: 4,
      y: 10,
      width: 6,
      height: 20,
    });
  });
});

describe("constrainDraft", () => {
  it("makes rect-like shapes square, preserving drag direction", () => {
    expect(constrainDraft("rect", { x: 0, y: 0 }, { x: 30, y: 10 })).toEqual({ x: 30, y: 30 });
    expect(constrainDraft("rect", { x: 0, y: 0 }, { x: -30, y: 10 })).toEqual({ x: -30, y: 30 });
  });
  it("snaps line/arrow to the nearest 45° while keeping length", () => {
    // ~10° drag of length ~10 snaps to horizontal.
    const r = constrainDraft("line", { x: 0, y: 0 }, { x: 10, y: 2 });
    expect(r.x).toBeCloseTo(Math.hypot(10, 2));
    expect(r.y).toBeCloseTo(0);
  });
  it("snaps a near-diagonal drag to exactly 45°", () => {
    const r = constrainDraft("arrow", { x: 0, y: 0 }, { x: 10, y: 9 });
    expect(r.x).toBeCloseTo(r.y);
  });
});

describe("shapeBbox", () => {
  const base = {
    rotation: 0,
    strokeWidth: 4,
    arrowheadStart: "none" as const,
    arrowheadEnd: "none" as const,
  };
  it("inflates a rect by half the stroke width", () => {
    const s: ShapeGeometry = { shape: "rect", x: 10, y: 20, width: 40, height: 30, ...base };
    expect(shapeBbox(s)).toEqual({ minX: 8, minY: 18, maxX: 52, maxY: 52 });
  });
  it("handles a line drawn up-and-left (negative width/height)", () => {
    const s: ShapeGeometry = { shape: "line", x: 50, y: 50, width: -40, height: -30, ...base };
    expect(shapeBbox(s)).toEqual({ minX: 8, minY: 18, maxX: 52, maxY: 52 });
  });
  it("reserves extra room for an arrowhead", () => {
    const s: ShapeGeometry = {
      shape: "arrow",
      x: 0,
      y: 0,
      width: 40,
      height: 0,
      rotation: 0,
      strokeWidth: 4,
      arrowheadStart: "none",
      arrowheadEnd: "classic",
    };
    const b = shapeBbox(s);
    // pad = max(strokeWidth/2=2, arrowheadSize=18) = 18
    expect(b.minX).toBe(-18);
    expect(b.maxX).toBe(58);
  });
  it("takes the AABB of rotated corners", () => {
    const s: ShapeGeometry = { shape: "rect", x: -10, y: -10, width: 20, height: 20, ...base, rotation: 45, strokeWidth: 0 };
    const b = shapeBbox(s);
    const half = Math.sqrt(2) * 10;
    expect(b.maxX).toBeCloseTo(half);
    expect(b.minX).toBeCloseTo(-half);
  });
});

describe("trianglePoints", () => {
  it("places the apex at top-center and the base along the bottom", () => {
    expect(trianglePoints(0, 0, 10, 20)).toEqual([
      { x: 5, y: 0 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ]);
  });
});

describe("arrowheadPoints", () => {
  it("returns the tip plus two barbs swept back along the angle", () => {
    const pts = arrowheadPoints({ x: 10, y: 0 }, 0, 10);
    expect(pts[0]).toEqual({ x: 10, y: 0 });
    // Both barbs sit behind the tip (smaller x) and straddle the axis.
    expect(pts[1].x).toBeLessThan(10);
    expect(pts[2].x).toBeLessThan(10);
    expect(pts[1].y).toBeCloseTo(-pts[2].y);
  });
});

describe("computeGuides", () => {
  const target = { minX: 100, minY: 100, maxX: 200, maxY: 200 };
  it("finds an edge alignment within tolerance and returns the nudge", () => {
    // Box sits below the target, only its left edge (104) is near a target line.
    const moving = { minX: 104, minY: 300, maxX: 120, maxY: 330 };
    const r = computeGuides(moving, [target], 8);
    // left edges: 100 vs 104 → dx -4, guide at x=100.
    expect(r.dx).toBe(-4);
    expect(r.guides).toContainEqual({ axis: "x", position: 100 });
  });
  it("returns no offset and no guides when nothing is within tolerance", () => {
    const moving = { minX: 500, minY: 500, maxX: 540, maxY: 540 };
    expect(computeGuides(moving, [target], 8)).toEqual({ dx: 0, dy: 0, guides: [] });
  });
  it("prefers the closest candidate per axis", () => {
    // left edge 106→100 is -6; centerX 148→150 is +2 — the center wins.
    const moving = { minX: 106, minY: 300, maxX: 190, maxY: 320 };
    const r = computeGuides(moving, [target], 8);
    expect(r.dx).toBe(2);
    expect(r.guides).toContainEqual({ axis: "x", position: 150 });
  });
});

describe("hexToRgba", () => {
  it("expands shorthand and applies alpha", () => {
    expect(hexToRgba("#f00", 0.2)).toBe("rgba(255, 0, 0, 0.2)");
  });
  it("parses full hex", () => {
    expect(hexToRgba("#2563eb", 0.25)).toBe("rgba(37, 99, 235, 0.25)");
  });
});
