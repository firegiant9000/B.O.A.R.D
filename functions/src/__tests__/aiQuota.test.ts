import { logger } from "firebase-functions/v2";
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
  // checkAiQuota logs on the corrupt-counter path (item 2 of the review), so
  // every test in this block stubs `logger.warn` to keep output pristine;
  // the dedicated logging test below asserts on this same spy's call args.
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

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

  it("allows a workspace whose usage doc exists but is empty (no calls field yet)", async () => {
    // Pins the allow-direction of the tolerant read: an existing-but-empty
    // doc must read the same as a missing one (0 calls), not fall through to
    // the corrupt-value branch.
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": {},
      "workspaces/ws1": { plan: "free" },
    });
    await expect(checkAiQuota(db, "ws1", T)).resolves.toBe(true);
  });

  it("treats an explicit null counter as absent, not corrupt", async () => {
    // A partial write can leave Firestore `null` behind; that is evidence of
    // an incomplete write; not evidence of a lost count, so it reads as 0.
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: null as unknown as number },
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

  it("logs the corrupt-counter denial with a hashed workspace id, never the raw one", async () => {
    // Fail-closed must not also be silent: an undiagnosable "quota exceeded"
    // for a paying customer whose counter corrupts is exactly the ticket this
    // line exists to prevent. Uses "pro" to make the point concrete -- a
    // corrupted counter denies even a plan with no real quota, so a paying
    // customer needs the log line to have any lead. Asserts real behaviour
    // (the actual call args), not the mock's own configured return value.
    const db = fakeDbWithDocs({
      "workspaces/some-real-workspace-id/aiUsage/2026-09": { calls: NaN },
      "workspaces/some-real-workspace-id": { plan: "pro" },
    });

    await checkAiQuota(db, "some-real-workspace-id", T);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = warnSpy.mock.calls[0];
    expect(message).toEqual(expect.stringContaining("corrupt"));
    expect(meta).toMatchObject({ period: "2026-09", rawCallsType: "number" });
    expect(meta?.workspaceHash).not.toBe("some-real-workspace-id");
    expect(meta?.workspaceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(meta)).not.toContain("some-real-workspace-id");
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
