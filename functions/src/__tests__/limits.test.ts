import * as fs from "fs";
import * as path from "path";
import { PLAN_LIMITS, limitFor, UNLIMITED, type Plan } from "../billing/limits";

describe("plan limits", () => {
  it("caps the free tier per the spec", () => {
    expect(limitFor("free", "boards")).toBe(5);
    expect(limitFor("free", "sessionsPerPeriod")).toBe(3);
    expect(limitFor("free", "aiCallsPerPeriod")).toBe(5);
    expect(limitFor("free", "collaboratorsPerBoard")).toBe(4);
    expect(limitFor("free", "workspaces")).toBe(1);
  });

  it("gives pro unlimited boards, sessions and AI but a seat cap", () => {
    expect(limitFor("pro", "boards")).toBe(UNLIMITED);
    expect(limitFor("pro", "sessionsPerPeriod")).toBe(UNLIMITED);
    expect(limitFor("pro", "aiCallsPerPeriod")).toBe(UNLIMITED);
    expect(limitFor("pro", "collaboratorsPerBoard")).toBe(25);
  });

  it("treats an unknown plan as free (fail closed)", () => {
    expect(limitFor("nonsense" as never, "boards")).toBe(5);
  });

  it("defines every resource for every plan", () => {
    for (const plan of ["free", "pro", "edu"] as const) {
      for (const r of ["boards", "sessionsPerPeriod", "aiCallsPerPeriod", "collaboratorsPerBoard", "workspaces"] as const) {
        expect(typeof PLAN_LIMITS[plan][r]).toBe("number");
      }
    }
  });
});

// The collaborator cap is enforced in firestore.rules (the invite-code self-join
// path is a client `update`, so a callable could not gate it) and rules cannot
// import TypeScript. That leaves the three numbers duplicated in `seatCaps()`
// there, and this test is the only thing keeping the two honest. Same technique
// as src/lib/__tests__/planLimits.test.ts: parse the other file as text and
// compare in BOTH directions, with a guard that fails if the parse matched
// nothing — a drift test whose parse silently matches nothing passes forever.
describe("firestore.rules seat-cap mirror", () => {
  it("keeps seatCaps() in firestore.rules in sync with collaboratorsPerBoard", () => {
    const rulesPath = path.join(__dirname, "../../../firestore.rules");
    const rules = fs.readFileSync(rulesPath, "utf8");

    // Isolate the seatCaps() body so a number elsewhere in the file can't satisfy
    // the comparison by accident.
    const fnStart = rules.indexOf("function seatCaps()");
    expect(fnStart).toBeGreaterThanOrEqual(0); // guard: the helper must still exist
    const fnEnd = rules.indexOf("}", rules.indexOf("return", fnStart));
    expect(fnEnd).toBeGreaterThan(fnStart); // guard: we actually captured a body
    const body = rules.slice(fnStart, fnEnd);

    // Parse the `'plan': number` map entries out of the rules source.
    const parsed: Record<string, number> = {};
    for (const m of body.matchAll(/'(\w+)'\s*:\s*(\d+)/g)) {
      parsed[m[1]] = Number(m[2]);
    }

    // Guard + first direction: every plan in the limits table appears in the
    // rules, and the rules define no plan the table doesn't. An empty parse
    // fails here rather than passing vacuously.
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(PLAN_LIMITS).sort());

    // Second direction: the numbers agree, plan by plan.
    for (const plan of Object.keys(parsed) as Plan[]) {
      expect(parsed[plan]).toBe(PLAN_LIMITS[plan].collaboratorsPerBoard);
    }
  });
});
