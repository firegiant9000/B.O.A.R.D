import { rdpSimplify } from "../simplify";

describe("rdpSimplify", () => {
  it("returns inputs of length <= 2 unchanged", () => {
    expect(rdpSimplify([])).toEqual([]);
    const one = [{ x: 1, y: 1 }];
    expect(rdpSimplify(one)).toBe(one);
    const two = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ];
    expect(rdpSimplify(two)).toBe(two);
  });

  it("collapses near-collinear points within tolerance to the endpoints", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0.1 },
      { x: 2, y: -0.1 },
      { x: 3, y: 0.05 },
      { x: 4, y: 0 },
    ];
    const result = rdpSimplify(points, 2.5);
    expect(result).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]);
  });

  it("keeps a vertex that exceeds the tolerance", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 10 }, // far off the chord — must survive
      { x: 10, y: 0 },
    ];
    const result = rdpSimplify(points, 2.5);
    expect(result).toEqual(points);
  });

  it("never drops the first or last point", () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
    const result = rdpSimplify(points, 2.5);
    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1]).toEqual(points[points.length - 1]);
    expect(result.length).toBeLessThan(points.length);
  });
});
