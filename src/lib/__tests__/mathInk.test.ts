import * as fs from "fs";
import * as path from "path";
import { MAX_LATEX_LENGTH } from "../mathInk";

// The two caps are physically separate (one ships in the client bundle as an
// advisory affordance, one lives inside the `renderMath` callable and is the
// real trust boundary — see this module's own header on MAX_LATEX_LENGTH) so
// this test is what keeps them honest. Same technique as
// src/lib/__tests__/planLimits.test.ts and functions/src/__tests__/limits.test.ts:
// parse the other file as text and compare, with a guard that fails if the
// parse matched nothing — a drift test whose parse silently matches nothing
// (both sides "undefined") would pass forever instead of catching drift.
describe("MAX_LATEX_LENGTH mirror", () => {
  it("keeps the client cap in sync with functions/src/math/mathRender.ts", () => {
    const rendererPath = path.join(
      __dirname,
      "../../../functions/src/math/mathRender.ts"
    );
    const src = fs.readFileSync(rendererPath, "utf8");
    const match = src.match(/export const MAX_LATEX_LENGTH = (\d+);/);

    // Guard: an empty/failed parse must fail loudly here, not silently
    // compare `undefined` against `undefined` and pass vacuously.
    expect(match).not.toBeNull();
    const rendererValue = Number(match![1]);
    expect(Number.isFinite(rendererValue)).toBe(true);

    expect(MAX_LATEX_LENGTH).toBe(rendererValue);
  });
});
