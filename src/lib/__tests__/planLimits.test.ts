import * as fs from "fs";
import * as path from "path";
import { PLAN_LIMITS } from "../planLimits";

// The two tables are physically separate (one ships in the bundle, one in the
// function runtime) so this test is what keeps them honest.
describe("planLimits mirror", () => {
  it("matches the functions-side table value for value", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../../functions/src/billing/limits.ts"),
      "utf8"
    );
    for (const [plan, limits] of Object.entries(PLAN_LIMITS)) {
      for (const [resource, value] of Object.entries(limits)) {
        const expected = value === Number.POSITIVE_INFINITY ? "UNLIMITED" : String(value);
        const block = src.slice(src.indexOf(`${plan}: {`));
        const line = block.slice(0, block.indexOf("}")).split("\n")
          .find((l) => l.trim().startsWith(`${resource}:`));
        expect(line).toBeDefined();
        expect(line).toContain(expected);
      }
    }
  });
});
