import { PLAN_LIMITS, limitFor, UNLIMITED } from "../billing/limits";

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
