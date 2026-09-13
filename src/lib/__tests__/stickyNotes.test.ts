import {
  STICKY_COLORS,
  DEFAULT_STICKY_COLOR,
  sanitizeStickyColor,
  STICKY_SIZE_METRICS,
  STICKY_FONT_SIZES,
  DEFAULT_STICKY_SIZE,
  sanitizeStickySize,
  stickySizeMetrics,
} from "../stickyNotes";

describe("sanitizeStickyColor (corrupt-stored-value guard)", () => {
  it("passes through every one of the 8 known colour names unchanged", () => {
    for (const name of Object.keys(STICKY_COLORS)) {
      expect(sanitizeStickyColor(name)).toBe(name);
    }
  });

  it("falls back to the default for an unknown string", () => {
    expect(sanitizeStickyColor("chartreuse")).toBe(DEFAULT_STICKY_COLOR);
  });

  it("falls back to the default for a non-string value (wrong type reaching a style prop)", () => {
    expect(sanitizeStickyColor(42)).toBe(DEFAULT_STICKY_COLOR);
    expect(sanitizeStickyColor(null)).toBe(DEFAULT_STICKY_COLOR);
    expect(sanitizeStickyColor(undefined)).toBe(DEFAULT_STICKY_COLOR);
    expect(sanitizeStickyColor({ hex: "#fff" })).toBe(DEFAULT_STICKY_COLOR);
  });

  it("default resolves to the note's original pre-feature colour, #FFF9C4", () => {
    expect(STICKY_COLORS[DEFAULT_STICKY_COLOR]).toBe("#FFF9C4");
  });
});

describe("sanitizeStickySize (corrupt-stored-value guard)", () => {
  it("passes through every one of the known sizes unchanged", () => {
    for (const size of STICKY_FONT_SIZES) {
      expect(sanitizeStickySize(size)).toBe(size);
    }
  });

  // NOTE on falsifiability: this passes even with the whole first-line guard
  // (`typeof`/`Number.isFinite`) removed — `STICKY_FONT_SIZES.includes(NaN)`
  // is already false, so the membership check alone catches this input; see
  // `sanitizeStickySize`'s own comment for why the guard is kept anyway.
  it("falls back to the default for NaN — typeof NaN === 'number' is the named trap", () => {
    expect(sanitizeStickySize(NaN)).toBe(DEFAULT_STICKY_SIZE);
  });

  it("falls back to the default for an in-range-looking but unknown number", () => {
    expect(sanitizeStickySize(15)).toBe(DEFAULT_STICKY_SIZE);
    expect(sanitizeStickySize(999)).toBe(DEFAULT_STICKY_SIZE);
    expect(sanitizeStickySize(-14)).toBe(DEFAULT_STICKY_SIZE);
  });

  it("falls back to the default for a non-number value", () => {
    expect(sanitizeStickySize("14")).toBe(DEFAULT_STICKY_SIZE);
    expect(sanitizeStickySize(null)).toBe(DEFAULT_STICKY_SIZE);
    expect(sanitizeStickySize(undefined)).toBe(DEFAULT_STICKY_SIZE);
  });

  it("default resolves to the note's original pre-feature layout (200 wide / 14px)", () => {
    expect(STICKY_SIZE_METRICS[DEFAULT_STICKY_SIZE]).toEqual({
      width: 200,
      fontSize: 14,
      minHeight: 70,
    });
  });
});

describe("stickySizeMetrics", () => {
  it("resolves metrics for a valid stored size", () => {
    expect(stickySizeMetrics(18)).toEqual(STICKY_SIZE_METRICS[18]);
  });

  it("resolves default metrics for a corrupt stored size", () => {
    expect(stickySizeMetrics(NaN)).toEqual(STICKY_SIZE_METRICS[DEFAULT_STICKY_SIZE]);
    expect(stickySizeMetrics("bogus")).toEqual(STICKY_SIZE_METRICS[DEFAULT_STICKY_SIZE]);
  });
});
