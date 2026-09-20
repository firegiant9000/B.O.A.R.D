import { valueFromPosition, positionFromValue } from "../sliderMath";

describe("valueFromPosition", () => {
  it("maps the left edge to min and the right edge to max", () => {
    expect(valueFromPosition(0, 100, 0, 1)).toBe(0);
    expect(valueFromPosition(100, 100, 0, 1)).toBe(1);
  });

  it("maps the midpoint to the midpoint value", () => {
    expect(valueFromPosition(50, 100, 0, 30)).toBe(15);
  });

  it("clamps a position past the right edge", () => {
    expect(valueFromPosition(500, 100, 0, 1)).toBe(1);
  });

  it("clamps a negative position to the left edge", () => {
    expect(valueFromPosition(-50, 100, 0, 1)).toBe(0);
  });

  it("returns min instead of dividing by zero for an unmeasured (0-width) track", () => {
    expect(valueFromPosition(10, 0, 2, 30)).toBe(2);
  });
});

describe("positionFromValue", () => {
  it("is the inverse of valueFromPosition at the endpoints", () => {
    expect(positionFromValue(0, 100, 0, 1)).toBe(0);
    expect(positionFromValue(1, 100, 0, 1)).toBe(100);
  });

  it("round-trips through valueFromPosition", () => {
    const x = positionFromValue(15, 100, 0, 30);
    expect(valueFromPosition(x, 100, 0, 30)).toBe(15);
  });

  it("clamps a value outside [min, max]", () => {
    expect(positionFromValue(-5, 100, 0, 10)).toBe(0);
    expect(positionFromValue(50, 100, 0, 10)).toBe(100);
  });

  it("returns 0 for a degenerate (min === max) range instead of dividing by zero", () => {
    expect(positionFromValue(5, 100, 5, 5)).toBe(0);
  });
});
