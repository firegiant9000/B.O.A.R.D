import {
  renderParamsFor,
  calligraphyWidthRange,
  persistedStyleFields,
  DEFAULT_ALPHA_FOR_STYLE,
  PEN_STYLES,
} from "../penStyles";

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

describe("persistedStyleFields", () => {
  it("omits both fields for a plain pen at full opacity (the pre-Month-5 doc shape)", () => {
    expect(persistedStyleFields(undefined, undefined)).toEqual({});
    expect(persistedStyleFields("pen", 1)).toEqual({});
  });

  it("omits opacity when it already equals the style's own default", () => {
    expect(persistedStyleFields("highlighter", DEFAULT_ALPHA_FOR_STYLE.highlighter)).toEqual({
      penStyle: "highlighter",
    });
  });

  // Fix round 1: the previous implementation compared `opacity` to a
  // hardcoded `1` instead of this style's own default, so a highlighter
  // saved at FULL opacity had that opacity silently omitted (1 is not
  // `< 1`) — renderParamsFor then read the absent field back as the
  // highlighter's own 0.35 default. This is the round trip that regressed.
  it("persists opacity when it diverges from the style's default, even at 1 (regression)", () => {
    const persisted = persistedStyleFields("highlighter", 1);
    expect(persisted).toEqual({ penStyle: "highlighter", opacity: 1 });

    const rendered = renderParamsFor(persisted.penStyle, 5, persisted.opacity);
    expect(rendered.opacity).toBe(1);
  });

  it("always persists a non-pen penStyle, regardless of opacity", () => {
    expect(persistedStyleFields("marker", undefined)).toEqual({ penStyle: "marker" });
    expect(persistedStyleFields("calligraphy", 1)).toEqual({ penStyle: "calligraphy" });
  });

  it("never persists penStyle: 'pen' explicitly", () => {
    expect(persistedStyleFields("pen", 0.5)).toEqual({ opacity: 0.5 });
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
