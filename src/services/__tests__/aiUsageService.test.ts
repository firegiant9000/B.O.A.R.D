jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {} }));

import * as fs from "firebase/firestore";
import { makeDocSnap, makeQuerySnap } from "../../test-utils/firestoreMock";
import {
  periodFor,
  canViewUsage,
  mapUsageDoc,
  formatUsd,
  getAiUsage,
  getRecentAiLog,
} from "../aiUsageService";

const getDoc = fs.getDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("periodFor", () => {
  it("buckets by UTC year-month, matching the function's currentPeriod", () => {
    expect(periodFor(new Date(Date.UTC(2026, 5, 14)))).toBe("2026-06");
    expect(periodFor(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01");
  });
});

describe("canViewUsage", () => {
  it("allows owner and admin, denies member/viewer/undefined", () => {
    expect(canViewUsage("owner")).toBe(true);
    expect(canViewUsage("admin")).toBe(true);
    expect(canViewUsage("member")).toBe(false);
    expect(canViewUsage("viewer")).toBe(false);
    expect(canViewUsage(undefined)).toBe(false);
  });
});

describe("mapUsageDoc", () => {
  it("zeroes every field for a missing doc", () => {
    expect(mapUsageDoc("2026-06", undefined)).toEqual({
      period: "2026-06",
      calls: 0,
      tokens: 0,
      costUsd: 0,
      byFeature: {},
    });
  });

  it("maps a populated doc and its per-feature breakdown", () => {
    const mapped = mapUsageDoc("2026-06", {
      calls: 5,
      tokens: 900,
      costUsd: 0.012,
      byFeature: { summary: { calls: 5, tokens: 900, costUsd: 0.012 } },
    });
    expect(mapped.calls).toBe(5);
    expect(mapped.byFeature.summary.costUsd).toBeCloseTo(0.012, 6);
  });

  it("tolerates a partial per-feature entry (schema-version tolerance)", () => {
    const mapped = mapUsageDoc("2026-06", { byFeature: { ocr: { calls: 2 } } });
    expect(mapped.byFeature.ocr).toEqual({ calls: 2, tokens: 0, costUsd: 0 });
  });
});

describe("formatUsd", () => {
  it("shows 4 decimals for sub-cent costs, 2 otherwise", () => {
    expect(formatUsd(0.0012)).toBe("$0.0012");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});

describe("getAiUsage", () => {
  it("returns a zeroed period when none exists yet", async () => {
    getDoc.mockResolvedValue(makeDocSnap("2026-06", null));
    const usage = await getAiUsage("wsA", "2026-06");
    expect(usage.calls).toBe(0);
  });

  it("maps an existing period doc", async () => {
    getDoc.mockResolvedValue(
      makeDocSnap("2026-06", { calls: 3, tokens: 900, costUsd: 0.01, byFeature: {} })
    );
    const usage = await getAiUsage("wsA", "2026-06");
    expect(usage.calls).toBe(3);
    expect(usage.costUsd).toBeCloseTo(0.01, 6);
  });
});

describe("getRecentAiLog", () => {
  it("maps log rows, tolerating missing fields", async () => {
    getDocs.mockResolvedValue(
      makeQuerySnap([
        ["call1", { uid: "u1", feature: "summary", model: "gpt-3.5-turbo", totalTokens: 300, costUsd: 0.0005, createdAt: 100 }],
        ["call2", {}],
      ])
    );
    const log = await getRecentAiLog("wsA");
    expect(log[0]).toMatchObject({ id: "call1", feature: "summary", totalTokens: 300 });
    expect(log[1]).toMatchObject({ id: "call2", feature: "unknown", totalTokens: 0 });
  });
});
