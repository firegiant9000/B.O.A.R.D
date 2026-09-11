import { fromHex8, toHex8, toCssRgba, clampAlpha, isValidHex, hasAlphaByte } from "../color";

/**
 * color.ts — Month 5 (ROADMAP item 12, colour + stroke polish). The three
 * tests in this first block are verbatim from the task brief (Step 1) —
 * written and run RED before `src/lib/color.ts` existed.
 */

it("round-trips hex+alpha", () => {
  expect(toHex8(fromHex8("#3366ffcc")!)).toBe("#3366ffcc");
});

it("clamps alpha out of range", () => {
  expect(fromHex8("#3366ff")!.a).toBe(1);
});

it("rejects malformed input without throwing", () => {
  expect(fromHex8("nonsense")).toBeNull();
});

describe("fromHex8 — additional cases", () => {
  it("accepts a bare 6-digit hex without a leading #", () => {
    expect(fromHex8("3366ff")).toEqual({ r: 0x33, g: 0x66, b: 0xff, a: 1 });
  });

  it("accepts a bare 8-digit hex without a leading #", () => {
    expect(fromHex8("3366ffcc")).toEqual({
      r: 0x33,
      g: 0x66,
      b: 0xff,
      a: Math.round((0xcc / 255) * 1000) / 1000,
    });
  });

  it("is case-insensitive", () => {
    expect(fromHex8("#3366FFCC")).toEqual(fromHex8("#3366ffcc"));
  });

  it("rejects the empty string", () => {
    expect(fromHex8("")).toBeNull();
  });

  it("rejects a 3-digit shorthand (not a hex8 shape)", () => {
    expect(fromHex8("#fff")).toBeNull();
  });

  it("never throws on garbage input", () => {
    expect(() => fromHex8("#gggggg")).not.toThrow();
    expect(fromHex8("#gggggg")).toBeNull();
  });

  it("clamps an alpha byte of 0 to 0, not falsy-default to 1", () => {
    expect(fromHex8("#00000000")!.a).toBe(0);
  });
});

describe("toHex8", () => {
  it("formats full opacity as an ff alpha byte", () => {
    expect(toHex8({ r: 0, g: 0, b: 0, a: 1 })).toBe("#000000ff");
  });

  it("formats zero alpha as a 00 alpha byte", () => {
    expect(toHex8({ r: 255, g: 255, b: 255, a: 0 })).toBe("#ffffff00");
  });

  it("clamps out-of-range channel values instead of emitting invalid hex", () => {
    expect(toHex8({ r: 300, g: -10, b: 128, a: 1 })).toBe("#ff0080ff");
  });

  it("always lowercases the output", () => {
    expect(toHex8({ r: 0xab, g: 0xcd, b: 0xef, a: 1 })).toBe("#abcdefff");
  });
});

describe("clampAlpha", () => {
  it("clamps below 0 up to 0", () => {
    expect(clampAlpha(-0.5)).toBe(0);
  });

  it("clamps above 1 down to 1", () => {
    expect(clampAlpha(1.5)).toBe(1);
  });

  it("passes an in-range value through unchanged", () => {
    expect(clampAlpha(0.42)).toBe(0.42);
  });

  it("treats NaN as fully opaque rather than propagating NaN", () => {
    expect(clampAlpha(NaN)).toBe(1);
  });
});

describe("toCssRgba", () => {
  it("formats an RN/CSS-consumable rgba() string", () => {
    expect(toCssRgba({ r: 51, g: 102, b: 255, a: 0.5 })).toBe("rgba(51, 102, 255, 0.5)");
  });
});

describe("isValidHex", () => {
  it("accepts 6- and 8-digit hex with or without a leading #", () => {
    expect(isValidHex("#3366ff")).toBe(true);
    expect(isValidHex("3366ff")).toBe(true);
    expect(isValidHex("#3366ffcc")).toBe(true);
  });

  it("rejects anything else without throwing", () => {
    expect(isValidHex("nonsense")).toBe(false);
    expect(isValidHex("")).toBe(false);
    expect(isValidHex("#fff")).toBe(false);
  });
});

// Fix round 2 — the regression this predicate exists to prevent: a caller
// reading `fromHex8(text)!.a` unconditionally cannot tell "the text really
// carried an alpha byte" from "fromHex8 defaulted one for a 6-digit hex",
// since both produce `a: 1` for a plain `#rrggbb`. See ColorPickerModal.tsx's
// `commitHex` for the real call site this backs.
describe("hasAlphaByte", () => {
  it("is true only for a genuine 8-digit hex, with or without a leading #", () => {
    expect(hasAlphaByte("#3366ffcc")).toBe(true);
    expect(hasAlphaByte("3366ffcc")).toBe(true);
  });

  it("is false for a 6-digit hex — it carries no alpha byte to report", () => {
    expect(hasAlphaByte("#3366ff")).toBe(false);
    expect(hasAlphaByte("3366ff")).toBe(false);
  });

  it("is false for malformed input, without throwing", () => {
    expect(hasAlphaByte("nonsense")).toBe(false);
    expect(hasAlphaByte("")).toBe(false);
  });
});
