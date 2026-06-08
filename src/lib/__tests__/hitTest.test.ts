import {
  distanceToSegment,
  distanceToPolyline,
  pointNearPolyline,
  boundsContainPoint,
} from "../hitTest";

describe("distanceToSegment", () => {
  it("returns the perpendicular distance for a point beside the segment", () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
  });

  it("clamps to the nearer endpoint when the projection falls outside [a,b]", () => {
    expect(distanceToSegment({ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(4);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it("handles a degenerate (zero-length) segment as a point distance", () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe("distanceToPolyline", () => {
  it("is Infinity for an empty polyline", () => {
    expect(distanceToPolyline([], { x: 0, y: 0 })).toBe(Infinity);
  });

  it("treats a single point as a point distance", () => {
    expect(distanceToPolyline([{ x: 0, y: 0 }], { x: 6, y: 8 })).toBe(10);
  });

  it("returns the minimum distance across all segments", () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    // Closest to the vertical segment x=10.
    expect(distanceToPolyline(poly, { x: 8, y: 5 })).toBe(2);
  });
});

describe("pointNearPolyline", () => {
  const poly = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ];
  it("is true when within maxDist and false beyond it", () => {
    expect(pointNearPolyline(poly, { x: 5, y: 2 }, 3)).toBe(true);
    expect(pointNearPolyline(poly, { x: 5, y: 4 }, 3)).toBe(false);
  });
  it("is inclusive at exactly maxDist", () => {
    expect(pointNearPolyline(poly, { x: 5, y: 3 }, 3)).toBe(true);
  });
});

describe("boundsContainPoint", () => {
  const b = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  it("respects the box edges", () => {
    expect(boundsContainPoint(b, { x: 5, y: 5 })).toBe(true);
    expect(boundsContainPoint(b, { x: 11, y: 5 })).toBe(false);
  });
  it("grows the box by pad on every side", () => {
    expect(boundsContainPoint(b, { x: 12, y: 5 }, 3)).toBe(true);
    expect(boundsContainPoint(b, { x: 12, y: 5 }, 1)).toBe(false);
  });
});
