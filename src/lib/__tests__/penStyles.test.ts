import { renderParamsFor, calligraphyWidthRange, DEFAULT_ALPHA_FOR_STYLE, PEN_STYLES } from "../penStyles";

describe("renderParamsFor", () => {
  it("defaults an undefined penStyle to plain pen params at the base width", () => {
    expect(renderParamsFor(undefined, 5, undefined)).toEqual({
      strokeWidth: 5,
      opacity: 1,
      linecap: "round",
      linejoin: "round",
      multiplyBlend: false,
    });
  });

  it("widens and dims the highlighter, and flags it for multiply blending", () => {
    const p = renderParamsFor("highlighter", 5, undefined);
    expect(p.strokeWidth).toBeGreaterThan(5);
    expect(p.opacity).toBeLessThan(1);
    expect(p.opacity).toBe(DEFAULT_ALPHA_FOR_STYLE.highlighter);
    expect(p.multiplyBlend).toBe(true);
  });

  it("an explicit opacity overrides the highlighter's own default", () => {
    expect(renderParamsFor("highlighter", 5, 0.9).opacity).toBe(0.9);
  });

  it("widens the marker with hard (butt/miter) edges and no blend", () => {
    const p = renderParamsFor("marker", 5, undefined);
    expect(p.strokeWidth).toBeGreaterThan(5);
    expect(p.linecap).toBe("butt");
    expect(p.linejoin).toBe("miter");
    expect(p.multiplyBlend).toBe(false);
    expect(p.opacity).toBe(1);
  });

  it("keeps calligraphy's fallback stroked-path params sane even though the real renderer never uses them", () => {
    const p = renderParamsFor("calligraphy", 5, undefined);
    expect(p.strokeWidth).toBe(5);
    expect(p.opacity).toBe(1);
  });

  it("every declared pen style resolves without throwing", () => {
    for (const style of PEN_STYLES) {
      expect(() => renderParamsFor(style, 5, undefined)).not.toThrow();
    }
  });
});

describe("calligraphyWidthRange", () => {
  it("returns an increasing [min, max] pair", () => {
    const [min, max] = calligraphyWidthRange(10);
    expect(min).toBeLessThan(max);
  });

  it("never returns a non-positive minimum, even for a tiny base width", () => {
    const [min] = calligraphyWidthRange(0.1);
    expect(min).toBeGreaterThan(0);
  });

  it("scales with the base width", () => {
    const [minSmall, maxSmall] = calligraphyWidthRange(5);
    const [minBig, maxBig] = calligraphyWidthRange(20);
    expect(maxBig).toBeGreaterThan(maxSmall);
    expect(minBig).toBeGreaterThanOrEqual(minSmall);
  });
});
