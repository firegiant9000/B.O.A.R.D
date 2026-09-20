// Month 6 — math elements. Tests for the PURE renderer: real MathJax, no
// Firestore, no mocks. These exercise the three properties the feature stands
// on — byte-identical output for identical input, a structured error instead
// of a throw for bad input, and geometry that lands where MathJax laid it out
// — plus the path/transform primitives underneath.
//
// Nothing here is mocked on purpose: a determinism test against a fake
// renderer would assert that a stub returns the same constant twice, which is
// true of every stub ever written and proves nothing about MathJax.

import {
  renderMath,
  resetEngineForTests,
  MATH_EM_BOARD_UNITS,
  MAX_LATEX_LENGTH,
  TEX_PACKAGES,
} from "../math/mathRender";
import {
  IDENTITY,
  boxPathData,
  boxWithin,
  intersectBoxes,
  multiply,
  parseTransform,
  rectPathData,
  scaling,
  transformPathData,
  translation,
} from "../math/svgPath";

/** Every coordinate in a flattened path, as an (x, y) bounding box. Used to
 *  prove the ink lands inside the box the callable reports — the check that
 *  would catch a dropped transform or a mishandled clip. */
function inkBox(d: string) {
  const nums = (d.match(/-?[\d.]+/g) ?? []).map(Number);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i]);
    maxX = Math.max(maxX, nums[i]);
    minY = Math.min(minY, nums[i + 1]);
    maxY = Math.max(maxY, nums[i + 1]);
  }
  return { minX, minY, maxX, maxY };
}

describe("renderMath — determinism (Month 6)", () => {
  // The brief's first test, plus the two assertions that make it falsifiable.
  //
  // On its own, `a.svgPath === b.svgPath` is NOT a determinism test: it also
  // passes when both are "". That is not hypothetical — it was checked. Drop
  // `fontCache: "none"` from mathRender.ts and MathJax emits `<defs>`/`<use>`
  // with per-document counter ids (MJX-1-…, MJX-2-…), which the flattener
  // refuses as unsupported elements, so BOTH calls return an error with an
  // empty `svgPath` and the bare equality above stays green while the
  // property it names is broken. The error and length assertions are what
  // turn it red.
  it("renders the same path data for the same latex", async () => {
    const a = await renderMath("x^2");
    const b = await renderMath("x^2");
    expect(a.error).toBeUndefined();
    expect(a.svgPath.length).toBeGreaterThan(100);
    expect(a.svgPath).toBe(b.svgPath);
  });

  it("is still byte-identical after other expressions have been rendered through the shared document", async () => {
    const first = await renderMath("\\frac{a}{b}");
    await renderMath("\\int_0^\\infty e^{-x^2}\\,dx");
    await renderMath("\\sum_{i=1}^{n} i");
    const second = await renderMath("\\frac{a}{b}");
    expect(first.error).toBeUndefined();
    expect(first.svgPath.length).toBeGreaterThan(100);
    expect(second.svgPath).toBe(first.svgPath);
    expect(second.width).toBe(first.width);
    expect(second.height).toBe(first.height);
  });

  it("is still byte-identical across a fresh MathJax document, not only within the shared one", async () => {
    // The two tests above share one process-lifetime document (see
    // mathRender.ts's DETERMINISM note) and would stay green even if a
    // SECOND document rendered the same LaTeX differently.
    // `resetEngineForTests` forces the next call to build a genuinely new
    // adaptor/TeX/SVG/document, closing that half of the claim.
    const first = await renderMath("x^2");
    resetEngineForTests();
    const second = await renderMath("x^2");
    expect(first.error).toBeUndefined();
    expect(first.svgPath.length).toBeGreaterThan(100);
    expect(second.svgPath).toBe(first.svgPath);
    expect(second.width).toBe(first.width);
    expect(second.height).toBe(first.height);
  });

  it("produces DIFFERENT path data for different latex", async () => {
    // The falsifier for the two above: if renderMath returned a constant,
    // every determinism assertion here would pass and mean nothing.
    const a = await renderMath("x^2");
    const b = await renderMath("x^3");
    expect(a.svgPath).not.toBe(b.svgPath);
    expect(a.svgPath.length).toBeGreaterThan(100);
  });

  it("typesets display and inline mode differently", async () => {
    const display = await renderMath("\\sum_{i=1}^{n} i", true);
    const inline = await renderMath("\\sum_{i=1}^{n} i", false);
    expect(display.error).toBeUndefined();
    expect(inline.error).toBeUndefined();
    // Limits sit above/below the sum in display mode and beside it inline, so
    // the two are genuinely different renderings — which is why the cache key
    // in mathCache.ts has to include the mode.
    expect(display.svgPath).not.toBe(inline.svgPath);
  });
});

describe("renderMath — structured errors, never a throw (Month 6)", () => {
  // The brief's third test, literally. A throw here would surface as a crash
  // on a user typo — `\frac{` is what every fraction looks like halfway
  // through being typed.
  it("returns a structured error for malformed latex rather than throwing", async () => {
    await expect(renderMath("\\frac{")).resolves.toMatchObject({ error: expect.any(String) });
  });

  it("surfaces TeX's own message so the user can see what they mistyped", async () => {
    // Pinned because it is load-bearing AND fragile: MathJax's TexError does
    // not extend Error, so an `err instanceof Error` guard silently replaces
    // every message below with a generic one. See `messageFor`.
    await expect(renderMath("\\frac{")).resolves.toMatchObject({ error: "Missing close brace" });
    await expect(renderMath("\\nosuchmacro")).resolves.toMatchObject({
      error: "Undefined control sequence \\nosuchmacro",
    });
    await expect(renderMath("\\begin{nope}x\\end{nope}")).resolves.toMatchObject({
      error: "Unknown environment 'nope'",
    });
  });

  it("zeroes the geometry on an error so no caller can render a broken element", async () => {
    const result = await renderMath("\\frac{");
    expect(result.svgPath).toBe("");
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it("rejects an empty or whitespace-only expression", async () => {
    await expect(renderMath("")).resolves.toMatchObject({ error: "Enter an equation." });
    await expect(renderMath("   ")).resolves.toMatchObject({ error: "Enter an equation." });
  });

  it("rejects latex over the length cap, but renders a long expression under it", async () => {
    const result = await renderMath("x".repeat(MAX_LATEX_LENGTH + 1));
    expect(result.error).toContain("too long");
    // Comfortably under the cap still renders — the cap is the cap, not an
    // always-on refusal.
    const ok = await renderMath("x + ".repeat(60) + "y");
    expect(ok.error).toBeUndefined();
  });

  it("refuses an expression whose flattened outline would be too large to store", async () => {
    // The second, independent cap: MAX_LATEX_LENGTH characters of LaTeX can
    // still expand to hundreds of kilobytes of glyph outlines, and `svgPath`
    // is stored ON the element, inside Firestore's 1 MiB document limit. A
    // thousand glyphs is under the length cap and over the size cap.
    const result = await renderMath("x".repeat(MAX_LATEX_LENGTH - 1));
    expect(result.error).toContain("too complex");
    expect(result.svgPath).toBe("");
  });

  it("bounds a recursive macro bomb instead of spinning", async () => {
    // `maxMacros` in mathRender.ts. Without it this expression expands until
    // the platform kills the instance.
    const result = await renderMath("\\def\\x{\\x\\x}\\x");
    expect(result.error).toContain("macro");
  });

  it("refuses characters the maths font has no glyph for, rather than dropping them", async () => {
    // MathJax renders these as an SVG `<text>` in a system font — there is no
    // outline to flatten, and emitting the equation without them would be
    // silently wrong.
    const result = await renderMath("\\text{日本語}");
    expect(result.error).toContain("no glyph for");
    expect(result.svgPath).toBe("");
  });

  it("refuses a package the curated list excludes, with TeX's own message", async () => {
    // `color` would set a second fill that one monochrome <Path> cannot
    // express; `cancel` emits a stroked <line>. Both are excluded in
    // TEX_PACKAGES, so they surface as ordinary undefined-macro errors.
    expect(TEX_PACKAGES).not.toContain("color");
    expect(TEX_PACKAGES).not.toContain("cancel");
    expect(TEX_PACKAGES).not.toContain("noerrors");
    expect(TEX_PACKAGES).not.toContain("noundefined");
    await expect(renderMath("\\color{red}{x}")).resolves.toMatchObject({
      error: "Undefined control sequence \\color",
    });
  });
});

describe("renderMath — geometry (Month 6)", () => {
  it("emits path data with no transforms, ids, or element markup left in it", async () => {
    const { svgPath } = await renderMath("\\frac{a}{b}");
    // The whole point of flattening: what comes back must be usable as a
    // single <Path d=...> with nothing else around it.
    expect(svgPath).not.toMatch(/</);
    expect(svgPath).not.toMatch(/translate|scale|matrix|rotate/);
    expect(svgPath).not.toMatch(/NaN|Infinity|undefined/);
    expect(svgPath).toMatch(/^M /);
    // Only absolute commands, and no elliptical arcs.
    expect(svgPath.replace(/[-\d.\s]/g, "").split("")).toEqual(
      expect.arrayContaining(["M"])
    );
    expect(svgPath).not.toMatch(/[a-z]/);
  });

  it("scales to board units — one em is MATH_EM_BOARD_UNITS tall", async () => {
    // `x` has no ascender or descender, so its typeset box is close to one
    // em. A wrong unit conversion (MathJax's raw 1000-per-em, say) would put
    // this three orders of magnitude out.
    const { width, height } = await renderMath("x");
    expect(height).toBeGreaterThan(MATH_EM_BOARD_UNITS * 0.3);
    expect(height).toBeLessThan(MATH_EM_BOARD_UNITS * 2);
    expect(width).toBeGreaterThan(0);
  });

  it.each([
    ["x^2", "a superscript"],
    ["\\frac{a}{b}", "a fraction rule (a <rect>)"],
    ["\\sqrt[3]{x+1}", "a radical"],
    ["\\overline{A+B+C+D+E}", "a stretched rule inside a clipping nested <svg>"],
    ["\\underline{x}", "a stretched rule below the baseline"],
    ["\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", "stretchy delimiters"],
    ["\\int_0^\\infty e^{-x^2}\\,dx", "limits on a large operator"],
    ["\\left(\\frac{1}{2}\\right)^{n}", "nested scaling"],
  ])("lands every coordinate inside the reported box: %s (%s)", async (latex) => {
    const result = await renderMath(latex);
    expect(result.error).toBeUndefined();
    const ink = inkBox(result.svgPath);
    // The real assertion. A dropped `translate` would park a glyph at the
    // origin; a mishandled nested-<svg> clip would run `\overline`'s rule
    // 50% past the end of the expression. Glyph overhang (italic side
    // bearings, brace shoulders) is real but small, so the tolerance is a
    // fraction of the box rather than zero.
    const padX = result.width * 0.1 + 1;
    const padY = result.height * 0.1 + 1;
    expect(ink.minX).toBeGreaterThanOrEqual(-padX);
    expect(ink.minY).toBeGreaterThanOrEqual(-padY);
    expect(ink.maxX).toBeLessThanOrEqual(result.width + padX);
    expect(ink.maxY).toBeLessThanOrEqual(result.height + padY);
  });

  it("clips a stretched rule to exactly the width of what it covers", async () => {
    // `\overline{...}`'s bar is drawn as a deliberately over-long rectangle
    // inside a clipping nested <svg>. If the clip were ignored, the ink would
    // extend well past `width`; if the construct were refused, there would be
    // no result at all. Both failure modes are excluded here.
    const short = await renderMath("\\overline{x}");
    const long = await renderMath("\\overline{A+B+C+D+E}");
    expect(short.error).toBeUndefined();
    expect(long.error).toBeUndefined();
    expect(inkBox(short.svgPath).maxX).toBeLessThanOrEqual(short.width + 0.5);
    expect(inkBox(long.svgPath).maxX).toBeLessThanOrEqual(long.width + 0.5);
    // And the bar really did get longer — the clip is doing work, not just
    // passing everything through.
    expect(long.width).toBeGreaterThan(short.width * 3);
  });

  it("keeps curves as curves — a clipped construct is not flattened to boxes", async () => {
    // The rectangle-clipping fallback must never swallow a curved glyph. A
    // brace is all curves; if it came back with no Q commands, the clip path
    // had replaced it with rectangles.
    const { svgPath, error } = await renderMath("\\underbrace{x+y}_{z}");
    expect(error).toBeUndefined();
    expect((svgPath.match(/Q/g) ?? []).length).toBeGreaterThan(20);
  });
});

describe("svgPath — transform parsing (Month 6)", () => {
  it("parses every transform form MathJax emits, including chains", () => {
    expect(parseTransform("scale(1,-1)")).toEqual({ a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 });
    expect(parseTransform("translate(605,413)")).toEqual({ ...IDENTITY, e: 605, f: 413 });
    // Space-separated arguments — MathJax emits both spellings.
    expect(parseTransform("translate(10 20)")).toEqual({ ...IDENTITY, e: 10, f: 20 });
    expect(parseTransform("translate(10, 20)")).toEqual({ ...IDENTITY, e: 10, f: 20 });
    // Chained: the RIGHTMOST applies first, per SVG.
    const chained = parseTransform("translate(100,0) scale(2)");
    expect(chained).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 100, f: 0 });
    expect(parseTransform("")).toEqual(IDENTITY);
  });

  it("fails closed on anything it does not fully understand", () => {
    // A silently-ignored transform misplaces geometry with no error anywhere.
    expect(parseTransform("skewX(20)")).toBeNull();
    expect(parseTransform("translate(1,2,3)")).toBeNull();
    expect(parseTransform("scale()")).toBeNull();
    expect(parseTransform("translate(abc,2)")).toBeNull();
    expect(parseTransform("translate(10,20) garbage")).toBeNull();
  });

  it("composes rotate about a point correctly", () => {
    const m = parseTransform("rotate(90, 10, 10)");
    expect(m).not.toBeNull();
    // (10,10) is the pivot and must not move; (20,10) swings to (10,20).
    const at = (x: number, y: number) => ({
      x: Math.round(m!.a * x + m!.c * y + m!.e),
      y: Math.round(m!.b * x + m!.d * y + m!.f),
    });
    expect(at(10, 10)).toEqual({ x: 10, y: 10 });
    expect(at(20, 10)).toEqual({ x: 10, y: 20 });
  });
});

describe("svgPath — path rewriting (Month 6)", () => {
  it("bakes a matrix into absolute commands and reports the box", () => {
    const out = transformPathData("M 0 0 L 10 0 L 10 10 Z", translation(5, 7), 3);
    expect(out).not.toBeNull();
    expect(out!.d).toBe("M 5 7 L 15 7 L 15 17 Z");
    expect(out!.box).toEqual({ minX: 5, minY: 7, maxX: 15, maxY: 17 });
  });

  it("converts H/V to L, because a horizontal segment is not horizontal after a rotation", () => {
    const out = transformPathData("M 0 0 H 10 V 10 Z", IDENTITY, 3);
    expect(out!.d).toBe("M 0 0 L 10 0 L 10 10 Z");
  });

  it("resolves relative commands against the running point and emits them absolute", () => {
    const out = transformPathData("m 1 1 l 2 0 l 0 2 z", IDENTITY, 3);
    expect(out!.d).toBe("M 1 1 L 3 1 L 3 3 Z");
  });

  it("treats repeated moveto arguments as implicit linetos, per SVG", () => {
    const out = transformPathData("M 0 0 1 1 2 2", IDENTITY, 3);
    expect(out!.d).toBe("M 0 0 L 1 1 L 2 2");
  });

  it("rounds to a fixed precision, which is what makes the output byte-stable", () => {
    const out = transformPathData("M 0 0 L 1 1", scaling(1 / 3, 1 / 3), 3);
    expect(out!.d).toBe("M 0 0 L 0.333 0.333");
    // And a negative zero must not serialise as "-0" — two arithmetically
    // equal results would then produce different bytes.
    const signed = transformPathData("M 0 0 L 1 0", scaling(-1, 1), 3);
    expect(signed!.d).toBe("M 0 0 L -1 0");
  });

  it("fails closed on an elliptical arc and on unknown commands", () => {
    // An arc's rx/ry/rotation do not survive an affine transform by rewriting
    // its endpoint, so accepting one would emit a wrong curve.
    expect(transformPathData("M 0 0 A 5 5 0 0 1 10 10", IDENTITY, 3)).toBeNull();
    expect(transformPathData("M 0 0 W 1 1", IDENTITY, 3)).toBeNull();
    expect(transformPathData("1 2 3", IDENTITY, 3)).toBeNull();
    expect(transformPathData("M 0", IDENTITY, 3)).toBeNull();
    expect(transformPathData("", IDENTITY, 3)).toBeNull();
  });

  it("recognises exactly one axis-aligned rectangle, and nothing else", () => {
    // This is what lets a clipped rule be trimmed exactly instead of refused.
    expect(transformPathData("M 0 0 L 10 0 L 10 5 L 0 5 Z", IDENTITY, 3)!.rect).toEqual({
      minX: 0,
      minY: 0,
      maxX: 10,
      maxY: 5,
    });
    // A triangle is not a rectangle...
    expect(transformPathData("M 0 0 L 10 0 L 10 5 Z", IDENTITY, 3)!.rect).toBeNull();
    // ...nor is a four-point path with a diagonal edge...
    expect(transformPathData("M 0 0 L 10 1 L 10 5 L 0 5 Z", IDENTITY, 3)!.rect).toBeNull();
    // ...nor a curve.
    expect(transformPathData("M 0 0 Q 5 5 10 0 Z", IDENTITY, 3)!.rect).toBeNull();
  });

  it("keeps a rectangle a rectangle under translate/scale but not under rotation", () => {
    expect(rectPathData(0, 0, 10, 5, multiply(translation(3, 3), scaling(2, 2)), 3)!.rect).toEqual({
      minX: 3,
      minY: 3,
      maxX: 23,
      maxY: 13,
    });
    const rotated = rectPathData(0, 0, 10, 5, parseTransform("rotate(30)")!, 3);
    expect(rotated!.rect).toBeNull();
  });

  it("refuses a negative rect but accepts a degenerate one", () => {
    expect(rectPathData(0, 0, -5, 5, IDENTITY, 3)).toBeNull();
    expect(rectPathData(0, 0, 10, 0, IDENTITY, 3)).not.toBeNull();
  });
});

describe("svgPath — box helpers (Month 6)", () => {
  const outer = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

  it("boxWithin only tolerates the rounding epsilon", () => {
    expect(boxWithin({ minX: 1, minY: 1, maxX: 9, maxY: 9 }, outer, 0.05)).toBe(true);
    expect(boxWithin({ minX: -0.01, minY: 0, maxX: 10, maxY: 10 }, outer, 0.05)).toBe(true);
    expect(boxWithin({ minX: -1, minY: 0, maxX: 10, maxY: 10 }, outer, 0.05)).toBe(false);
    expect(boxWithin({ minX: 0, minY: 0, maxX: 11, maxY: 10 }, outer, 0.05)).toBe(false);
  });

  it("intersectBoxes trims, and returns null when there is nothing left", () => {
    expect(intersectBoxes({ minX: -5, minY: 2, maxX: 15, maxY: 4 }, outer)).toEqual({
      minX: 0,
      minY: 2,
      maxX: 10,
      maxY: 4,
    });
    expect(intersectBoxes({ minX: 20, minY: 0, maxX: 30, maxY: 10 }, outer)).toBeNull();
    // Touching edges share no area, so they clip away entirely.
    expect(intersectBoxes({ minX: 10, minY: 0, maxX: 20, maxY: 10 }, outer)).toBeNull();
  });

  it("boxPathData round-trips through the parser as the same rectangle", () => {
    const d = boxPathData({ minX: 1, minY: 2, maxX: 3, maxY: 4 }, 3);
    expect(transformPathData(d, IDENTITY, 3)!.rect).toEqual({
      minX: 1,
      minY: 2,
      maxX: 3,
      maxY: 4,
    });
  });
});
