import {
  applySessionUsage,
  countOwnedWorkspaces,
  incrementSessionCount,
  type SessionUsageDoc,
} from "../billing/usage";
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

describe("countOwnedWorkspaces", () => {
  /** A Firestore stand-in that records the query it was asked to build, so the
   *  tests can assert on the FILTER as well as the result. The filter is the
   *  whole design decision here — `ownerId ==` rather than membership — and a
   *  test that only checked the returned numbers would pass just as happily
   *  against a query that counted every workspace the caller belongs to. */
  function fakeDb(plans: unknown[]) {
    const recorded: { collection?: string; where?: unknown[]; select?: unknown[] } = {};
    const query: any = {
      where: (...args: unknown[]) => {
        recorded.where = args;
        return query;
      },
      select: (...args: unknown[]) => {
        recorded.select = args;
        return query;
      },
      get: async () => ({
        size: plans.length,
        docs: plans.map((plan) => ({ get: (field: string) => (field === "plan" ? plan : undefined) })),
      }),
    };
    const db: any = {
      collection: (name: string) => {
        recorded.collection = name;
        return query;
      },
    };
    return { db, recorded };
  }

  it("counts by ownerId, never by membership", async () => {
    // Being invited to someone else's workspace must not consume your own
    // allowance — the cap is on what a user CREATES.
    const { db, recorded } = fakeDb(["free"]);
    await countOwnedWorkspaces(db, "u1");
    expect(recorded.collection).toBe("workspaces");
    expect(recorded.where).toEqual(["ownerId", "==", "u1"]);
  });

  it("projects only `plan`, so the count and the entitlement come from ONE read", async () => {
    const { db, recorded } = fakeDb([]);
    await countOwnedWorkspaces(db, "u1");
    expect(recorded.select).toEqual(["plan"]);
  });

  it("returns zero and no plans for a brand-new user", async () => {
    const { db } = fakeDb([]);
    expect(await countOwnedWorkspaces(db, "u1")).toEqual({ count: 0, plans: [] });
  });

  it("returns every owned workspace's plan alongside the count", async () => {
    const { db } = fakeDb(["free", "pro", "edu"]);
    expect(await countOwnedWorkspaces(db, "u1")).toEqual({
      count: 3,
      plans: ["free", "pro", "edu"],
    });
  });

  it("drops a non-string plan from `plans` but still COUNTS the document", async () => {
    // The two halves diverge on purpose: a corrupt `plan` must not be able to
    // read as an entitlement, but the workspace it sits on is still a real
    // workspace and still occupies a slot.
    const { db } = fakeDb([undefined, 12345, "free"]);
    expect(await countOwnedWorkspaces(db, "u1")).toEqual({ count: 3, plans: ["free"] });
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
