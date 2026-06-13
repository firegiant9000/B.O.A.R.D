import {
  translatePoint,
  translatePoints,
  translateBounds,
  marqueeBounds,
  boundsInMarquee,
  scalePointAbout,
  rotatePointAbout,
  scaleBoundsAbout,
  resizeMatrix,
  rotateMatrix,
} from "../transform";

describe("translate helpers", () => {
  it("translates a single point", () => {
    expect(translatePoint({ x: 3, y: 4 }, 10, -2)).toEqual({ x: 13, y: 2 });
  });

  it("translates a point array without mutating the input", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ];
    const out = translatePoints(pts, 2, 3);
    expect(out).toEqual([
      { x: 2, y: 3 },
      { x: 7, y: 8 },
    ]);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
  });

  it("translates bounds on all four edges", () => {
    expect(translateBounds({ minX: 1, minY: 2, maxX: 3, maxY: 4 }, -1, 5)).toEqual({
      minX: 0,
      minY: 7,
      maxX: 2,
      maxY: 9,
    });
  });
});

describe("marqueeBounds", () => {
  it("normalizes corners regardless of drag direction", () => {
    expect(marqueeBounds({ x: 10, y: 20 }, { x: 4, y: 2 })).toEqual({
      minX: 4,
      minY: 2,
      maxX: 10,
      maxY: 20,
    });
  });
});

describe("boundsInMarquee", () => {
  const marquee = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

  it("selects an element fully inside", () => {
    expect(boundsInMarquee({ minX: 2, minY: 2, maxX: 4, maxY: 4 }, marquee)).toBe(true);
  });

  it("selects an element that merely overlaps an edge", () => {
    expect(boundsInMarquee({ minX: 8, minY: 8, maxX: 20, maxY: 20 }, marquee)).toBe(true);
  });

  it("rejects an element entirely outside", () => {
    expect(boundsInMarquee({ minX: 20, minY: 20, maxX: 30, maxY: 30 }, marquee)).toBe(false);
  });
});

describe("scalePointAbout", () => {
  it("leaves the anchor fixed", () => {
    expect(scalePointAbout({ x: 5, y: 5 }, { x: 5, y: 5 }, 3, 3)).toEqual({ x: 5, y: 5 });
  });
  it("scales distance from the anchor per axis", () => {
    expect(scalePointAbout({ x: 10, y: 10 }, { x: 0, y: 0 }, 2, 0.5)).toEqual({ x: 20, y: 5 });
  });
});

describe("rotatePointAbout", () => {
  it("rotates 90° CCW-in-math / about the origin", () => {
    const r = rotatePointAbout({ x: 1, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo(1, 6);
  });
  it("leaves the center fixed", () => {
    expect(rotatePointAbout({ x: 3, y: 7 }, { x: 3, y: 7 }, 1.234)).toEqual({ x: 3, y: 7 });
  });
});

describe("scaleBoundsAbout", () => {
  it("scales a box about its anchor and stays normalized", () => {
    expect(
      scaleBoundsAbout({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { x: 0, y: 0 }, 2, 2)
    ).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 });
  });
});

describe("matrix builders", () => {
  it("resizeMatrix maps the anchor to itself", () => {
    // matrix(sx,0,0,sy,e,f): x' = sx*x + e. At x=anchor.x → anchor.x.
    expect(resizeMatrix({ x: 4, y: 6 }, 2, 3)).toBe("matrix(2, 0, 0, 3, -4, -12)");
  });
  it("rotateMatrix is identity at theta=0", () => {
    expect(rotateMatrix({ x: 5, y: 5 }, 0)).toBe("matrix(1, 0, 0, 1, 0, 0)");
  });
});
