import * as fs from "fs";
import * as path from "path";
import { PLAN_LIMITS, PlanLimits } from "../planLimits";

// The two tables are physically separate (one ships in the bundle, one in the
// function runtime) so this test is what keeps them honest.
describe("planLimits mirror", () => {
  it("maintains bidirectional equivalence with functions-side table", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../../functions/src/billing/limits.ts"),
      "utf8"
    );

    // Parse the functions-side PLAN_LIMITS table from source
    const functionsLimits: Record<string, Record<string, string>> = {};

    // Find the PLAN_LIMITS table definition
    const limitStart = src.indexOf("export const PLAN_LIMITS");
    const limitEnd = src.indexOf("};", limitStart) + 2;
    const limitSource = src.substring(limitStart, limitEnd);

    // Discover plan blocks from the source by finding top-level plan: { patterns
    // Match lines with whitespace + plan_name + colon + brace
    const planBlockMatches = Array.from(
      limitSource.matchAll(/^\s*(\w+):\s*\{/gm)
    );
    const discoveredPlans = planBlockMatches.map((m) => m[1]);

    // Guard: fail if parser found nothing (indicates parse failure or malformed table)
    expect(discoveredPlans.length).toBeGreaterThan(0);

    // Extract each discovered plan's block and parse its resources
    for (const plan of discoveredPlans) {
      const blockStart = limitSource.indexOf(`${plan}: {`);
      const blockEnd = limitSource.indexOf("}", blockStart);
      const blockSource = limitSource.substring(blockStart, blockEnd);

      functionsLimits[plan] = {};

      // Parse resource: value pairs from the plan block
      const lines = blockSource.split("\n");
      for (const line of lines) {
        const match = line.trim().match(/^(\w+):\s*(UNLIMITED|\d+)/);
        if (match) {
          functionsLimits[plan][match[1]] = match[2];
        }
      }
    }

    // Assert plan key sets match
    const clientPlanKeys = Object.keys(PLAN_LIMITS).sort();
    const functionPlanKeys = Object.keys(functionsLimits).sort();
    expect(clientPlanKeys).toEqual(functionPlanKeys);

    // Assert bidirectional resource key and value equivalence
    for (const plan of clientPlanKeys) {
      const clientResourceKeys = Object.keys(
        PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS]
      ).sort();
      const functionResourceKeys = Object.keys(functionsLimits[plan]).sort();

      // Both directions: client and functions must have identical resource sets
      expect(clientResourceKeys).toEqual(functionResourceKeys);

      // Values must match in both directions
      for (const resource of clientResourceKeys) {
        const planLimits = PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS];
        const clientValue = planLimits[resource as keyof PlanLimits];
        const clientValueStr =
          clientValue === Number.POSITIVE_INFINITY
            ? "UNLIMITED"
            : String(clientValue);
        const functionsValue = functionsLimits[plan][resource];

        expect(functionsValue).toBe(clientValueStr);
      }
    }
  });
});
