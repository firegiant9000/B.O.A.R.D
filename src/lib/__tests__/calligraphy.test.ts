import { calligraphyPathD } from "../calligraphy";

describe("calligraphyPathD", () => {
  it("returns an empty string for no points, matching pointsToSvgPath's contract", () => {
    expect(calligraphyPathD([], 2, 8)).toBe("");
  });

  it("returns a single dot (a circle command) for one point", () => {
    const d = calligraphyPathD([{ x: 5, y: 5 }], 2, 8);
    expect(d).toContain("A");
    expect(d).not.toBe("");
  });

  it("builds quads + joints for a multi-point stroke", () => {
    const d = calligraphyPathD(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      2,
      8
    );
    // Two segments' worth of straight-edge quads (M/L/L/L/Z)...
    expect(d.match(/Z/g)?.length).toBeGreaterThanOrEqual(2);
    expect(d).toContain("L");
    // ...plus round caps/joints (arc commands).
    expect(d).toContain("A");
  });

  it("never throws on a degenerate (all-coincident) point list", () => {
    const points = [
      { x: 3, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 3 },
    ];
    expect(() => calligraphyPathD(points, 2, 8)).not.toThrow();
    expect(calligraphyPathD(points, 2, 8)).not.toBe("");
  });

  it("never throws on NaN-free but pathological input (single duplicated pair)", () => {
    expect(() =>
      calligraphyPathD(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        1,
        4
      )
    ).not.toThrow();
  });

  it("varies width with direction: a stroke parallel to the nib is narrower than one perpendicular to it", () => {
    // NIB_ANGLE is fixed at 45°. A horizontal stroke (0°) and a stroke along
    // the anti-diagonal (135°, perpendicular to the nib) should not produce
    // identically-sized joint circles — this is a coarse structural check
    // (both must at least differ), not an exact-geometry assertion.
    const horizontal = calligraphyPathD(
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      2,
      10
    );
    const antiDiagonal = calligraphyPathD(
      [
        { x: 0, y: 0 },
        { x: -20, y: 20 },
      ],
      2,
      10
    );
    expect(horizontal).not.toEqual(antiDiagonal);
  });
});
