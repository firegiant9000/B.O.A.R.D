import { isWithinAiQuota, checkAiQuota } from "../ai/usage";

const T = Date.UTC(2026, 8, 9, 12, 0, 0); // 2026-09-09 -> period "2026-09"

describe("isWithinAiQuota", () => {
  it("allows a free workspace under the cap", () => {
    expect(isWithinAiQuota("free", 4)).toBe(true);
  });

  it("blocks a free workspace at the cap", () => {
    expect(isWithinAiQuota("free", 5)).toBe(false);
  });

  it("never blocks pro", () => {
    expect(isWithinAiQuota("pro", 100000)).toBe(true);
  });

  it("treats a missing plan as free (fail closed)", () => {
    expect(isWithinAiQuota(undefined, 5)).toBe(false);
  });
});

/** Builds a fake Firestore that answers `doc(path).get()` from a fixed map of
 *  path -> data (or `undefined` for a missing doc), mirroring the fakeDb style
 *  already used in usage.test.ts / billingUsage.test.ts. */
function fakeDbWithDocs(docs: Record<string, Record<string, unknown> | undefined>) {
  return {
    doc: (path: string) => ({
      get: async () => {
        const data = docs[path];
        return {
          exists: data !== undefined,
          data: () => data,
        };
      },
    }),
  } as any;
}

describe("checkAiQuota", () => {
  it("allows a free workspace under the cap", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: 4 },
      "workspaces/ws1": { plan: "free" },
    });
    await expect(checkAiQuota(db, "ws1", T)).resolves.toBe(true);
  });

  it("denies a free workspace at the cap (the point of this task)", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: 5 },
      "workspaces/ws1": { plan: "free" },
    });
    await expect(checkAiQuota(db, "ws1", T)).resolves.toBe(false);
  });

  it("never blocks a pro workspace, however high the counter", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: 100000 },
      "workspaces/ws1": { plan: "pro" },
    });
    await expect(checkAiQuota(db, "ws1", T)).resolves.toBe(true);
  });

  it("treats a missing usage doc as zero calls (genuinely no usage yet)", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1": { plan: "free" },
    });
    await expect(checkAiQuota(db, "ws1", T)).resolves.toBe(true);
  });

  it("treats a missing workspace doc as free (fail closed)", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: 5 },
    });
    await expect(checkAiQuota(db, "ws1", T)).resolves.toBe(false);
  });

  it("treats a missing plan field as free (fail closed)", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: 5 },
      "workspaces/ws1": {},
    });
    await expect(checkAiQuota(db, "ws1", T)).resolves.toBe(false);
  });

  it("fails closed on a corrupt (NaN) counter instead of granting unlimited AI", async () => {
    // typeof NaN === "number", and NaN is a legal Firestore double, so a naive
    // `typeof count === "number" ? count : 0` guard would let this through and
    // `NaN >= 5` evaluates false -- silently granting unlimited AI. The gate
    // must reject the free workspace here, not allow it.
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: NaN },
      "workspaces/ws1": { plan: "free" },
    });
    await expect(checkAiQuota(db, "ws1", T)).resolves.toBe(false);
  });

  it("fails closed on a non-numeric counter (string)", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: "oops" as unknown as number },
      "workspaces/ws1": { plan: "free" },
    });
    await expect(checkAiQuota(db, "ws1", T)).resolves.toBe(false);
  });

  it("treats an unrecognized plan value as free (fail closed)", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: 5 },
      "workspaces/ws1": { plan: "some-future-plan" },
    });
    await expect(checkAiQuota(db, "ws1", T)).resolves.toBe(false);
  });
});
