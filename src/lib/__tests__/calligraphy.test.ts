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

  // Fix round 1, item 5: the previous version of this test compared the
  // whole `d` STRING between two differently-angled strokes — which two
  // different (x, y) coordinates will always produce, even under a
  // constant-width implementation, so it proved nothing about width
  // specifically. This version parses the actual emitted radius (the `r` in
  // the leading cap's `A r r ...` arc command) and asserts it differs in the
  // specific way `widthForAngle`'s 45°-nib formula predicts.
  describe("width genuinely responds to direction (not just the d string differing)", () => {
    // The radius baked into the very first drawn command: for a straight
    // 2-point stroke, calligraphyPathD's leading circleD(start, startW/2)
    // is `M ${x-r} ${y} A ${r} ${r} 0 1 0 ...` — this is the same `r` for
    // both the start cap and the single segment's quad half-width.
    const capRadius = (d: string): number => {
      const m = d.match(/A ([\d.]+) /);
      if (!m) throw new Error(`no arc command found in: ${d}`);
      return parseFloat(m[1]);
    };

    const MIN_WIDTH = 2;
    const MAX_WIDTH = 10;

    it("a stroke running exactly along the 45° nib angle renders at maxWidth", () => {
      // (0,0) -> (10,10) is a 45° direction.
      const d = calligraphyPathD([{ x: 0, y: 0 }, { x: 10, y: 10 }], MIN_WIDTH, MAX_WIDTH);
      expect(capRadius(d)).toBeCloseTo(MAX_WIDTH / 2, 5);
    });

    it("a stroke running perpendicular to the nib (135°) renders at minWidth", () => {
      // (0,0) -> (-10,10) is a 135° direction, 90° from the nib angle.
      const d = calligraphyPathD([{ x: 0, y: 0 }, { x: -10, y: 10 }], MIN_WIDTH, MAX_WIDTH);
      expect(capRadius(d)).toBeCloseTo(MIN_WIDTH / 2, 5);
    });

    it("the two directions above produce genuinely different widths, end to end", () => {
      const parallel = calligraphyPathD([{ x: 0, y: 0 }, { x: 10, y: 10 }], MIN_WIDTH, MAX_WIDTH);
      const perpendicular = calligraphyPathD([{ x: 0, y: 0 }, { x: -10, y: 10 }], MIN_WIDTH, MAX_WIDTH);
      expect(capRadius(parallel)).toBeGreaterThan(capRadius(perpendicular));
    });
  });
});
