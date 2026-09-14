jest.mock("../../config/firebase", () => ({ db: {} }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));

import * as fs from "firebase/firestore";
import { makeDocSnap, makeCountSnap } from "../../test-utils/firestoreMock";
import { periodFor } from "../aiUsageService";
import { UNLIMITED } from "../../lib/planLimits";
import {
  toHeadroom,
  countWorkspaceBoards,
  readSessionUsage,
  getWorkspaceUsage,
} from "../usageService";

const getDoc = fs.getDoc as jest.Mock;
const getCountFromServer = fs.getCountFromServer as jest.Mock;
const where = fs.where as jest.Mock;
const doc = fs.doc as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("toHeadroom", () => {
  it("reports remaining and a fraction for a capped resource", () => {
    expect(toHeadroom(3, 5)).toEqual({ used: 3, limit: 5, remaining: 2, fraction: 0.6, unlimited: false });
  });

  it("clamps an over-limit resource to zero remaining", () => {
    expect(toHeadroom(8, 5)).toMatchObject({ remaining: 0, fraction: 1 });
  });

  it("marks an unlimited resource", () => {
    const h = toHeadroom(999, Number.POSITIVE_INFINITY);
    expect(h.unlimited).toBe(true);
    expect(h.fraction).toBe(0);
  });

  it("treats a non-finite used value as zero rather than letting NaN propagate", () => {
    expect(toHeadroom(NaN, 5)).toMatchObject({ used: 0, remaining: 5, fraction: 0 });
  });

  it("treats a non-numeric limit (e.g. limitFor's undefined for a prototype-shaped plan) as at-cap, never dividing to Infinity/NaN", () => {
    const h = toHeadroom(2, undefined as unknown as number);
    expect(h.unlimited).toBe(false);
    expect(Number.isFinite(h.fraction)).toBe(true);
    expect(Number.isFinite(h.remaining)).toBe(true);
    expect(h.fraction).toBe(1);
    expect(h.remaining).toBe(0);
  });
});

describe("countWorkspaceBoards", () => {
  it("counts via aggregation, filtered by workspaceId and a provably-non-null inviteCode", async () => {
    // The filter's second clause is NOT arbitrary: firestore.rules' board read
    // rule is `ownerId==caller || caller in members || inviteCode != null`, and
    // Firestore validates an aggregation query against the query's *potential*
    // result set, not the documents actually in the database (verified against
    // the emulator). A bare `workspaceId==X` filter can't prove any disjunct for
    // a caller who isn't a member of every board in the workspace (routine for
    // an owner/admin viewing this dashboard — createBoard adds only the
    // creator), so it is rejected outright. Only the inviteCode clause is
    // provable from the filter alone.
    getCountFromServer.mockResolvedValueOnce(makeCountSnap(3));
    await expect(countWorkspaceBoards("ws1")).resolves.toBe(3);
    expect(where).toHaveBeenCalledWith("workspaceId", "==", "ws1");
    expect(where).toHaveBeenCalledWith("inviteCode", "!=", null);
  });
});

describe("readSessionUsage", () => {
  it("reads the sessions field off the workspace's usage/{period} doc", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("2026-09", { sessions: 2, updatedAt: 100 }));
    await expect(readSessionUsage("ws1", "2026-09")).resolves.toBe(2);
  });

  it("defaults to 0 for a not-yet-written period bucket rather than throwing", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("2026-09", null));
    await expect(readSessionUsage("ws1", "2026-09")).resolves.toBe(0);
  });

  it("defaults to 0 for a non-finite stored value (mirrors the Function's own guard)", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("2026-09", { sessions: "oops" }));
    await expect(readSessionUsage("ws1", "2026-09")).resolves.toBe(0);
  });
});

describe("getWorkspaceUsage", () => {
  function mockDocsByPath(byPath: Record<string, Record<string, unknown> | null>) {
    getDoc.mockImplementation(async (ref: { path?: string[] }) => {
      const key = (ref?.path ?? []).join("/");
      const match = Object.keys(byPath).find((p) => key.includes(p));
      return makeDocSnap(key, match ? byPath[match] : null);
    });
  }

  it("returns all four resources with their headroom on a capped (free) plan", async () => {
    getCountFromServer.mockResolvedValueOnce(makeCountSnap(3));
    mockDocsByPath({
      "/usage/": { sessions: 1, updatedAt: 0 },
      "/aiUsage/": { calls: 4, tokens: 900, costUsd: 0.01, byFeature: {} },
      // workspace doc itself (neither /usage/ nor /aiUsage/ in its path)
      "workspaces/ws1": { plan: "free", members: { alice: "owner", bob: "member" } },
    });

    const result = await getWorkspaceUsage("ws1", "free");

    expect(result.boards).toEqual({ used: 3, limit: 5, remaining: 2, fraction: 0.6, unlimited: false });
    expect(result.sessions).toEqual({ used: 1, limit: 3, remaining: 2, fraction: 1 / 3, unlimited: false });
    expect(result.aiCalls).toMatchObject({ used: 4, limit: 5, unlimited: false });
    expect(result.collaborators).toMatchObject({ used: 2, limit: 4, unlimited: false });
  });

  // Month 6's two added plan rows. Both are counted out of the SAME
  // `aiUsage/{period}` document this function already fetches for `aiCalls`
  // — `byFeature[feature].calls`, the exact field the server's own gates
  // read (functions/src/ai/usage.ts#readFeatureCalls) — so they cost no
  // extra read and cannot drift from what enforcement counts.
  it("returns the board Q&A and embeddings rows from byFeature, the same counter the server gates on", async () => {
    getCountFromServer.mockResolvedValueOnce(makeCountSnap(1));
    mockDocsByPath({
      "/usage/": { sessions: 0, updatedAt: 0 },
      "/aiUsage/": {
        calls: 9,
        tokens: 900,
        costUsd: 0.01,
        byFeature: {
          boardQa: { calls: 2, tokens: 400, costUsd: 0.005 },
          embeddings: { calls: 7, tokens: 500, costUsd: 0.005 },
        },
      },
      "workspaces/ws1": { plan: "free", members: { alice: "owner" } },
    });

    const result = await getWorkspaceUsage("ws1", "free");

    expect(result.boardQa).toEqual({ used: 2, limit: 3, remaining: 1, fraction: 2 / 3, unlimited: false });
    expect(result.embeddings).toMatchObject({ used: 7, limit: 2000, unlimited: false });
  });

  // `boardQaPerPeriod` is the one row finite on EVERY plan, Pro included —
  // which is the whole reason this page needs to show it: it is the only
  // metered resource a paying customer can exhaust with nowhere else in the
  // product to see why.
  it("keeps board Q&A finite on Pro, unlike every other Pro-unlimited row", async () => {
    getCountFromServer.mockResolvedValueOnce(makeCountSnap(0));
    mockDocsByPath({
      "/aiUsage/": { calls: 0, tokens: 0, costUsd: 0, byFeature: { boardQa: { calls: 5 } } },
      "workspaces/ws1": { plan: "pro", members: { alice: "owner" } },
    });

    const result = await getWorkspaceUsage("ws1", "pro");

    expect(result.aiCalls.unlimited).toBe(true);
    expect(result.boardQa).toMatchObject({ used: 5, limit: 200, unlimited: false });
  });

  it("reports every plan-unlimited resource as unlimited, with no Infinity/NaN on the finite ones", async () => {
    getCountFromServer.mockResolvedValueOnce(makeCountSnap(40));
    mockDocsByPath({
      "/usage/": { sessions: 12, updatedAt: 0 },
      "/aiUsage/": { calls: 400, tokens: 90000, costUsd: 4.5, byFeature: {} },
      "workspaces/ws1": { plan: "pro", members: { alice: "owner", bob: "member", carol: "member" } },
    });

    const result = await getWorkspaceUsage("ws1", "pro");

    expect(result.boards.unlimited).toBe(true);
    expect(result.sessions.unlimited).toBe(true);
    expect(result.aiCalls.unlimited).toBe(true);
    // Pro still caps collaborators per board (25) — not every resource is
    // unlimited just because the plan is Pro.
    expect(result.collaborators).toEqual({ used: 3, limit: 25, remaining: 22, fraction: 3 / 25, unlimited: false });
    for (const h of [result.boards, result.sessions, result.aiCalls]) {
      expect(Number.isNaN(h.fraction)).toBe(false);
      expect(h.fraction).toBe(0);
    }
  });

  it("tolerates a brand-new workspace with no usage docs written yet, defaulting every 'used' to 0", async () => {
    getCountFromServer.mockResolvedValueOnce(makeCountSnap(0));
    mockDocsByPath({}); // every getDoc resolves to a missing doc
    const result = await getWorkspaceUsage("ws1", "free");
    expect(result.boards.used).toBe(0);
    expect(result.sessions.used).toBe(0);
    expect(result.aiCalls.used).toBe(0);
    expect(result.collaborators.used).toBe(0);
  });

  it("reads the session-usage doc for periodFor()'s period — no re-derived UTC bucketing", async () => {
    getCountFromServer.mockResolvedValueOnce(makeCountSnap(0));
    mockDocsByPath({});
    await getWorkspaceUsage("ws1", "free");
    const expectedPeriod = periodFor();
    const docPaths = doc.mock.calls.map((args: unknown[]) => args.slice(1));
    expect(docPaths).toContainEqual(["workspaces", "ws1", "usage", expectedPeriod]);
  });
});
