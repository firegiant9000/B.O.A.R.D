import { applySessionUsage, incrementSessionCount, type SessionUsageDoc } from "../billing/usage";
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

describe("incrementSessionCount", () => {
  it("writes to the doc path firestore.rules locks (workspaces/{id}/usage/{period})", () => {
    // Pins the one string that must agree with firestore.rules' `match
    // /usage/{period}` block — a typo here is invisible to both tsc and the
    // rules tests otherwise.
    const tx = { set: jest.fn() };
    const fakeDb: any = { doc: (path: string) => ({ path }) };

    incrementSessionCount(tx as any, fakeDb, "ws1", T, undefined);

    expect(tx.set).toHaveBeenCalledTimes(1);
    const [ref, data] = tx.set.mock.calls[0];
    expect(ref.path).toBe("workspaces/ws1/usage/2026-09");
    expect(data).toEqual({ sessions: 1, updatedAt: T });
  });
});
