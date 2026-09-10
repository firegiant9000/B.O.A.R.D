import { applySessionUsage, type SessionUsageDoc } from "../billing/usage";
import { currentPeriod } from "../ai/usage";

const T = Date.UTC(2026, 8, 9, 12, 0, 0); // 2026-09-09

describe("applySessionUsage", () => {
  it("starts a fresh period at one", () => {
    const next = applySessionUsage(undefined, T);
    expect(next.sessions).toBe(1);
    expect(next.updatedAt).toBe(T);
  });

  it("increments an existing period", () => {
    const prev: SessionUsageDoc = { sessions: 2, updatedAt: T - 1000 };
    expect(applySessionUsage(prev, T).sessions).toBe(3);
  });

  it("tolerates a malformed counter without throwing", () => {
    const prev = { sessions: "oops", updatedAt: 0 } as unknown as SessionUsageDoc;
    expect(applySessionUsage(prev, T).sessions).toBe(1);
  });
});

describe("period agreement", () => {
  it("uses the same bucket as the AI meter", () => {
    // The AI meter and the session meter must never disagree about when a
    // month starts, or a user's two quotas reset on different days.
    expect(currentPeriod(T)).toBe("2026-09");
  });
});
