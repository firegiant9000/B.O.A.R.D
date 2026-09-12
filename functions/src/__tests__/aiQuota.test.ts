import { logger } from "firebase-functions/v2";
import {
  isWithinAiQuota,
  checkAiQuota,
  isWithinFeatureQuota,
  readCounter,
  readFeatureCalls,
  checkFeatureQuota,
  checkFeatureOnlyQuota,
} from "../ai/usage";
import { limitFor } from "../billing/limits";

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

// ─────────────────────────────────────────────────────────────────────────────
// Month 6 — per-feature quota. Board Q&A is the first feature carrying a plan
// row of its own on top of the workspace-wide AI cap, because a question fires
// as often as someone types one while a summary fires once per session.

describe("readCounter", () => {
  it("reads a real count", () => {
    expect(readCounter(7, () => undefined)).toBe(7);
  });

  it("reads an absent or explicitly null counter as zero, not as corrupt", () => {
    // Order matters: a workspace's FIRST call has no counter yet, and reading
    // that as corrupt would deny every workspace its first call forever.
    const onCorrupt = jest.fn();
    expect(readCounter(undefined, onCorrupt)).toBe(0);
    expect(readCounter(null, onCorrupt)).toBe(0);
    expect(onCorrupt).not.toHaveBeenCalled();
  });

  it("fails closed to Infinity on NaN, and says so", () => {
    // `typeof NaN === "number"` and NaN is a legal Firestore double, so a naive
    // type guard passes it straight through — and `NaN < 5` is false, which
    // reads as "denied" only by accident. Coercing to Infinity makes the denial
    // deliberate rather than incidental, and survives a plan with no cap.
    const onCorrupt = jest.fn();
    expect(readCounter(NaN, onCorrupt)).toBe(Number.POSITIVE_INFINITY);
    expect(onCorrupt).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a non-finite or non-numeric value", () => {
    const onCorrupt = jest.fn();
    expect(readCounter("12", onCorrupt)).toBe(Number.POSITIVE_INFINITY);
    expect(readCounter(Infinity, onCorrupt)).toBe(Number.POSITIVE_INFINITY);
    expect(onCorrupt).toHaveBeenCalledTimes(2);
  });
});

describe("readFeatureCalls", () => {
  it("reads a feature's own call count", () => {
    const doc = { calls: 9, byFeature: { boardQa: { calls: 2 } } };
    expect(readFeatureCalls(doc, "boardQa", () => undefined)).toBe(2);
  });

  it("reads a workspace that has never used the feature as zero", () => {
    const onCorrupt = jest.fn();
    expect(
      readFeatureCalls({ calls: 9, byFeature: { summary: { calls: 9 } } }, "boardQa", onCorrupt)
    ).toBe(0);
    expect(readFeatureCalls({ calls: 0 }, "boardQa", onCorrupt)).toBe(0);
    expect(readFeatureCalls(undefined, "boardQa", onCorrupt)).toBe(0);
    expect(onCorrupt).not.toHaveBeenCalled();
  });

  it("fails closed when the feature entry exists but isn't an object", () => {
    // `(5)?.calls` is `undefined`, which a tolerant reader would happily call
    // zero — handing out a fresh allowance off the back of a corrupt write.
    const onCorrupt = jest.fn();
    expect(readFeatureCalls({ byFeature: { boardQa: 5 } }, "boardQa", onCorrupt)).toBe(
      Number.POSITIVE_INFINITY
    );
    expect(onCorrupt).toHaveBeenCalledTimes(1);
  });

  it("fails closed when byFeature itself isn't a map", () => {
    const onCorrupt = jest.fn();
    expect(readFeatureCalls({ byFeature: "oops" }, "boardQa", onCorrupt)).toBe(
      Number.POSITIVE_INFINITY
    );
    expect(onCorrupt).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a corrupt count inside a well-shaped entry", () => {
    const onCorrupt = jest.fn();
    expect(
      readFeatureCalls({ byFeature: { boardQa: { calls: NaN } } }, "boardQa", onCorrupt)
    ).toBe(Number.POSITIVE_INFINITY);
    expect(onCorrupt).toHaveBeenCalledTimes(1);
  });
});

describe("isWithinFeatureQuota", () => {
  it("allows a free workspace under its Q&A cap", () => {
    expect(
      isWithinFeatureQuota("free", "boardQaPerPeriod", limitFor("free", "boardQaPerPeriod") - 1)
    ).toBe(true);
  });

  it("blocks a free workspace AT its Q&A cap", () => {
    expect(
      isWithinFeatureQuota("free", "boardQaPerPeriod", limitFor("free", "boardQaPerPeriod"))
    ).toBe(false);
  });

  it("blocks pro and edu too — this row is finite on every plan", () => {
    // The distinguishing property of this limit. `aiCallsPerPeriod` is
    // UNLIMITED on both, so a gate that quietly reused it would leave the one
    // feature the roadmap calls unbounded running uncapped on the paying tiers.
    expect(
      isWithinFeatureQuota("pro", "boardQaPerPeriod", limitFor("pro", "boardQaPerPeriod"))
    ).toBe(false);
    expect(
      isWithinFeatureQuota("edu", "boardQaPerPeriod", limitFor("edu", "boardQaPerPeriod"))
    ).toBe(false);
  });

  it("treats a missing or unrecognized plan as free (fail closed)", () => {
    const freeCap = limitFor("free", "boardQaPerPeriod");
    expect(isWithinFeatureQuota(undefined, "boardQaPerPeriod", freeCap)).toBe(false);
    expect(isWithinFeatureQuota("future-tier" as never, "boardQaPerPeriod", freeCap)).toBe(false);
  });

  it("denies a corrupt (Infinity) counter regardless of plan", () => {
    expect(isWithinFeatureQuota("pro", "boardQaPerPeriod", Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("checkFeatureQuota", () => {
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("allows a free workspace under both caps", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: 1, byFeature: { boardQa: { calls: 1 } } },
      "workspaces/ws1": { plan: "free" },
    });
    await expect(checkFeatureQuota(db, "ws1", "boardQa", "boardQaPerPeriod", T)).resolves.toBe(true);
  });

  it("denies once the FEATURE cap is reached, even with AI calls left over", async () => {
    // free's Q&A cap is strictly under its aiCallsPerPeriod, so this is the
    // case the feature row exists for: Q&A stops before it has eaten the whole
    // workspace's AI allowance and left summaries/OCR with nothing.
    const qaCap = limitFor("free", "boardQaPerPeriod");
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: qaCap, byFeature: { boardQa: { calls: qaCap } } },
      "workspaces/ws1": { plan: "free" },
    });
    await expect(checkFeatureQuota(db, "ws1", "boardQa", "boardQaPerPeriod", T)).resolves.toBe(false);
  });

  it("denies once the workspace-wide AI cap is reached, even with the feature cap untouched", async () => {
    // The other direction: a per-feature allowance must never become a way
    // around the cap every other AI callable honours.
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": {
        calls: limitFor("free", "aiCallsPerPeriod"),
        byFeature: { boardQa: { calls: 0 } },
      },
      "workspaces/ws1": { plan: "free" },
    });
    await expect(checkFeatureQuota(db, "ws1", "boardQa", "boardQaPerPeriod", T)).resolves.toBe(false);
  });

  it("caps a pro workspace on this feature despite its unlimited AI calls", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": {
        calls: 100000,
        byFeature: { boardQa: { calls: limitFor("pro", "boardQaPerPeriod") } },
      },
      "workspaces/ws1": { plan: "pro" },
    });
    await expect(checkFeatureQuota(db, "ws1", "boardQa", "boardQaPerPeriod", T)).resolves.toBe(false);
  });

  it("lets a pro workspace under the feature cap through", async () => {
    // The positive control for the case above: without it, a gate that denied
    // every pro workspace outright would look identical.
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": {
        calls: 100000,
        byFeature: { boardQa: { calls: limitFor("pro", "boardQaPerPeriod") - 1 } },
      },
      "workspaces/ws1": { plan: "pro" },
    });
    await expect(checkFeatureQuota(db, "ws1", "boardQa", "boardQaPerPeriod", T)).resolves.toBe(true);
  });

  it("allows a workspace with no usage doc at all (genuinely no usage yet)", async () => {
    const db = fakeDbWithDocs({ "workspaces/ws1": { plan: "free" } });
    await expect(checkFeatureQuota(db, "ws1", "boardQa", "boardQaPerPeriod", T)).resolves.toBe(true);
  });

  it("treats a missing workspace doc as free (fail closed)", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": {
        calls: 0,
        byFeature: { boardQa: { calls: limitFor("free", "boardQaPerPeriod") } },
      },
    });
    await expect(checkFeatureQuota(db, "ws1", "boardQa", "boardQaPerPeriod", T)).resolves.toBe(false);
  });

  it("fails closed on a corrupt feature counter, and logs a hashed workspace id", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: 0, byFeature: { boardQa: { calls: NaN } } },
      "workspaces/ws1": { plan: "pro" },
    });

    await expect(checkFeatureQuota(db, "ws1", "boardQa", "boardQaPerPeriod", T)).resolves.toBe(false);

    expect(warnSpy).toHaveBeenCalled();
    const [, meta] = warnSpy.mock.calls[0];
    expect(meta).toMatchObject({ period: "2026-09", feature: "boardQa" });
    expect(meta?.workspaceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(meta)).not.toContain("ws1");
  });

  it("fails closed on a corrupt workspace-wide counter too", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: NaN, byFeature: { boardQa: { calls: 0 } } },
      "workspaces/ws1": { plan: "pro" },
    });
    await expect(checkFeatureQuota(db, "ws1", "boardQa", "boardQaPerPeriod", T)).resolves.toBe(false);
  });
});

// Month 6 — the gate for a feature metered with `countsTowardAiCap: false`.
// It is a MATCHED PAIR with that flag, not a convenience variant: a feature
// that does not feed the workspace-wide counter must not be gated by it, or
// an unrelated summary could stop a board from re-indexing.
describe("checkFeatureOnlyQuota", () => {
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("allows a workspace under its own feature cap", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: 0, byFeature: { embeddings: { calls: 5 } } },
      "workspaces/ws1": { plan: "free" },
    });
    await expect(
      checkFeatureOnlyQuota(db, "ws1", "embeddings", "embeddingsPerPeriod", T)
    ).resolves.toBe(true);
  });

  it("denies at the feature cap", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": {
        calls: 0,
        byFeature: { embeddings: { calls: limitFor("free", "embeddingsPerPeriod") } },
      },
      "workspaces/ws1": { plan: "free" },
    });
    await expect(
      checkFeatureOnlyQuota(db, "ws1", "embeddings", "embeddingsPerPeriod", T)
    ).resolves.toBe(false);
  });

  it("IGNORES the workspace-wide AI cap — the distinguishing behaviour", async () => {
    // This is the whole point of the function existing. `checkFeatureQuota`
    // with the same documents denies (that is the next assertion); this one
    // must not, because the feature it gates deliberately contributes nothing
    // to the counter that is exhausted.
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": {
        calls: limitFor("free", "aiCallsPerPeriod") + 100,
        byFeature: { embeddings: { calls: 1 } },
      },
      "workspaces/ws1": { plan: "free" },
    });

    await expect(
      checkFeatureOnlyQuota(db, "ws1", "embeddings", "embeddingsPerPeriod", T)
    ).resolves.toBe(true);
    // The contrast, on the very same data — without this the assertion above
    // could pass simply because the fixture was under every cap.
    await expect(
      checkFeatureQuota(db, "ws1", "embeddings", "embeddingsPerPeriod", T)
    ).resolves.toBe(false);
  });

  it("does not log a denial it is not making when the workspace-wide counter is corrupt", async () => {
    // It never reads that counter, so a corrupt `calls` must neither deny here
    // nor produce a "denying (fail closed)" line about a decision not taken.
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: NaN, byFeature: { embeddings: { calls: 1 } } },
      "workspaces/ws1": { plan: "free" },
    });

    await expect(
      checkFeatureOnlyQuota(db, "ws1", "embeddings", "embeddingsPerPeriod", T)
    ).resolves.toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still fails closed on a corrupt FEATURE counter, and logs it", async () => {
    const db = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": { calls: 0, byFeature: { embeddings: { calls: NaN } } },
      "workspaces/ws1": { plan: "pro" },
    });

    await expect(
      checkFeatureOnlyQuota(db, "ws1", "embeddings", "embeddingsPerPeriod", T)
    ).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls[0][1])).not.toContain("ws1");
  });

  it("caps a pro workspace too, and treats an unknown plan as free (fail closed)", async () => {
    const proAtCap = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": {
        byFeature: { embeddings: { calls: limitFor("pro", "embeddingsPerPeriod") } },
      },
      "workspaces/ws1": { plan: "pro" },
    });
    await expect(
      checkFeatureOnlyQuota(proAtCap, "ws1", "embeddings", "embeddingsPerPeriod", T)
    ).resolves.toBe(false);

    const unknownPlan = fakeDbWithDocs({
      "workspaces/ws1/aiUsage/2026-09": {
        byFeature: { embeddings: { calls: limitFor("free", "embeddingsPerPeriod") } },
      },
      "workspaces/ws1": { plan: "some-future-plan" },
    });
    await expect(
      checkFeatureOnlyQuota(unknownPlan, "ws1", "embeddings", "embeddingsPerPeriod", T)
    ).resolves.toBe(false);
  });

  it("allows a workspace with no usage doc at all", async () => {
    const db = fakeDbWithDocs({ "workspaces/ws1": { plan: "free" } });
    await expect(
      checkFeatureOnlyQuota(db, "ws1", "embeddings", "embeddingsPerPeriod", T)
    ).resolves.toBe(true);
  });
});
