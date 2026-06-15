import {
  estimateCostUsd,
  currentPeriod,
  applyUsage,
  recordAiUsage,
  type RecordUsageParams,
  type UsageDoc,
} from "../ai/usage";

const params = (over: Partial<RecordUsageParams> = {}): RecordUsageParams => ({
  workspaceId: "wsA",
  uid: "u1",
  feature: "summary",
  model: "gpt-3.5-turbo",
  usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  now: Date.UTC(2026, 5, 14), // 2026-06-14
  ...over,
});

describe("estimateCostUsd", () => {
  it("prices prompt + completion tokens separately for gpt-3.5-turbo", () => {
    // 1000/1M * $0.50 + 500/1M * $1.50 = 0.0005 + 0.00075
    expect(
      estimateCostUsd("gpt-3.5-turbo", {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      })
    ).toBeCloseTo(0.00125, 6);
  });

  it("uses the cheaper gpt-4o-mini rates", () => {
    // 1000/1M * $0.15 + 1000/1M * $0.60 = 0.00075
    expect(
      estimateCostUsd("gpt-4o-mini", {
        promptTokens: 1000,
        completionTokens: 1000,
        totalTokens: 2000,
      })
    ).toBeCloseTo(0.00075, 6);
  });

  it("falls back to the default rate for an unknown model (never under-reports)", () => {
    expect(
      estimateCostUsd("some-future-model", {
        promptTokens: 1000,
        completionTokens: 0,
        totalTokens: 1000,
      })
    ).toBeCloseTo(0.0005, 6);
  });

  it("is zero when no tokens were used", () => {
    expect(
      estimateCostUsd("gpt-3.5-turbo", {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      })
    ).toBe(0);
  });
});

describe("currentPeriod", () => {
  it("buckets by UTC year-month, zero-padded", () => {
    expect(currentPeriod(Date.UTC(2026, 5, 14))).toBe("2026-06");
    expect(currentPeriod(Date.UTC(2026, 11, 31))).toBe("2026-12");
  });
});

describe("applyUsage", () => {
  it("seeds counters from an empty period", () => {
    const next = applyUsage(undefined, params(), 0.00125);
    expect(next.calls).toBe(1);
    expect(next.tokens).toBe(1500);
    expect(next.promptTokens).toBe(1000);
    expect(next.completionTokens).toBe(500);
    expect(next.costUsd).toBeCloseTo(0.00125, 6);
    expect(next.byFeature.summary).toEqual({
      calls: 1,
      tokens: 1500,
      costUsd: 0.00125,
    });
  });

  it("accumulates onto an existing period", () => {
    const prev: UsageDoc = {
      calls: 2,
      tokens: 3000,
      promptTokens: 2000,
      completionTokens: 1000,
      costUsd: 0.0025,
      byFeature: { summary: { calls: 2, tokens: 3000, costUsd: 0.0025 } },
      updatedAt: 0,
    };
    const next = applyUsage(prev, params(), 0.00125);
    expect(next.calls).toBe(3);
    expect(next.tokens).toBe(4500);
    expect(next.costUsd).toBeCloseTo(0.00375, 6);
    expect(next.byFeature.summary.calls).toBe(3);
  });

  it("tracks a second feature without clobbering the first", () => {
    const prev: UsageDoc = {
      calls: 1,
      tokens: 1500,
      promptTokens: 1000,
      completionTokens: 500,
      costUsd: 0.00125,
      byFeature: { summary: { calls: 1, tokens: 1500, costUsd: 0.00125 } },
      updatedAt: 0,
    };
    const next = applyUsage(prev, params({ feature: "ocr" }), 0.00125);
    expect(next.byFeature.summary.calls).toBe(1);
    expect(next.byFeature.ocr.calls).toBe(1);
    expect(next.calls).toBe(2);
  });
});

describe("recordAiUsage", () => {
  it("writes the period counter and an append-only log in one transaction", async () => {
    const sets: { path: string; data: any }[] = [];
    const fakeDb: any = {
      doc: (path: string) => ({ path }),
      collection: (path: string) => ({ doc: () => ({ path: `${path}/auto` }) }),
      runTransaction: (fn: any) =>
        fn({
          get: async () => ({ exists: false, data: () => undefined }),
          set: (ref: any, data: any) => sets.push({ path: ref.path, data }),
        }),
    };

    const res = await recordAiUsage(fakeDb, params());

    expect(res.period).toBe("2026-06");
    expect(res.costUsd).toBeCloseTo(0.00125, 6);

    const usage = sets.find((s) => s.path === "workspaces/wsA/aiUsage/2026-06");
    expect(usage?.data.calls).toBe(1);
    expect(usage?.data.byFeature.summary.costUsd).toBeCloseTo(0.00125, 6);

    const log = sets.find((s) => s.path === "workspaces/wsA/aiLog/auto");
    expect(log?.data).toMatchObject({
      uid: "u1",
      feature: "summary",
      model: "gpt-3.5-turbo",
      totalTokens: 1500,
    });
    expect(log?.data.costUsd).toBeCloseTo(0.00125, 6);
  });

  it("uses an explicit flatCostUsd over the token-rate table (Phase 10 Vision)", async () => {
    const sets: { path: string; data: any }[] = [];
    const fakeDb: any = {
      doc: (path: string) => ({ path }),
      collection: (path: string) => ({ doc: () => ({ path: `${path}/auto` }) }),
      runTransaction: (fn: any) =>
        fn({
          get: async () => ({ exists: false, data: () => undefined }),
          set: (ref: any, data: any) => sets.push({ path: ref.path, data }),
        }),
    };

    const res = await recordAiUsage(
      fakeDb,
      params({
        feature: "ocr",
        model: "google-vision",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        flatCostUsd: 0.0015,
      })
    );

    expect(res.costUsd).toBeCloseTo(0.0015, 6);
    const usage = sets.find((s) => s.path === "workspaces/wsA/aiUsage/2026-06");
    expect(usage?.data.byFeature.ocr.costUsd).toBeCloseTo(0.0015, 6);
  });
});
