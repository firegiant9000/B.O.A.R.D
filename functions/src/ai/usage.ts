import type { Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { createHash } from "node:crypto";
import type { ChatUsage } from "./provider";
import { limitFor, type Plan } from "../billing/limits";

// AI cost telemetry (Month 4, Phase 2). The function writes two things after every
// provider call: a per-period `aiUsage` counter (calls / tokens / $ estimate, plus a
// per-feature breakdown) and an append-only `aiLog` record. Both live under
// `workspaces/{id}/...` and are locked to Functions-only writes in firestore.rules.
//
// The pure math (`estimateCostUsd`, `currentPeriod`, `applyUsage`) is split out so it
// is unit-tested without Firestore — mirroring the `applyBucket` / `consumeToken`
// split in rateLimit.ts. `recordAiUsage` wraps it in a transaction (read-modify-write)
// so concurrent calls accumulate correctly.

/** USD per 1M tokens, split input/output, keyed by the concrete provider model the
 *  adapter reports (not the logical tier). One edit here when a model price moves. */
interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

const MODEL_RATES: Record<string, ModelRate> = {
  "gpt-3.5-turbo": { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
};

// Unknown model → assume the pricier text model so an estimate never under-reports
// cost (the M4 < $0.02/session benchmark should fail loud, not silently pass).
const DEFAULT_RATE: ModelRate = { inputPerMillion: 0.5, outputPerMillion: 1.5 };

/** Estimated USD for one call, rounded to the micro-dollar. Prompt + completion are
 *  priced separately because input/output rates differ across models. */
export function estimateCostUsd(model: string, usage: ChatUsage): number {
  const rate = MODEL_RATES[model] ?? DEFAULT_RATE;
  const cost =
    (usage.promptTokens / 1_000_000) * rate.inputPerMillion +
    (usage.completionTokens / 1_000_000) * rate.outputPerMillion;
  // Round to micro-dollars so accumulated counters don't drift on float noise.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** The UTC year-month bucket (e.g. "2026-06") a timestamp falls in. Counters reset
 *  per calendar month, matching how the usage page reads "$ this period". */
export function currentPeriod(now: number): string {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export interface FeatureUsage {
  calls: number;
  tokens: number;
  costUsd: number;
}

/** The shape persisted at `workspaces/{id}/aiUsage/{period}`. The reader (client
 *  aiUsageService) tolerates missing fields, so adding a feature is non-breaking. */
export interface UsageDoc {
  calls: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  byFeature: Record<string, FeatureUsage>;
  updatedAt: number;
}

export interface RecordUsageParams {
  workspaceId: string;
  uid: string;
  /** "summary" today; OCR / explain / diagram phases pass their own name. */
  feature: string;
  /** The concrete provider model that served the call (for the rate table). */
  model: string;
  usage: ChatUsage;
  now: number;
  /** Per-image-priced engines (Phase 10 — Google Vision) bill per call, not per
   *  token, so they pass an explicit cost here instead of going through the
   *  token-rate table. When set, it overrides `estimateCostUsd`. */
  flatCostUsd?: number;
}

function emptyUsage(now: number): UsageDoc {
  return {
    calls: 0,
    tokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    byFeature: {},
    updatedAt: now,
  };
}

/** Pure: fold one call's usage into the running period counter. Returns the next
 *  doc to persist. Kept side-effect-free so the accumulation math is unit-tested. */
export function applyUsage(
  prev: UsageDoc | undefined,
  params: RecordUsageParams,
  costUsd: number
): UsageDoc {
  const base = prev ?? emptyUsage(params.now);
  const prevFeature = base.byFeature?.[params.feature] ?? {
    calls: 0,
    tokens: 0,
    costUsd: 0,
  };

  return {
    calls: base.calls + 1,
    tokens: base.tokens + params.usage.totalTokens,
    promptTokens: base.promptTokens + params.usage.promptTokens,
    completionTokens: base.completionTokens + params.usage.completionTokens,
    costUsd: base.costUsd + costUsd,
    byFeature: {
      ...base.byFeature,
      [params.feature]: {
        calls: prevFeature.calls + 1,
        tokens: prevFeature.tokens + params.usage.totalTokens,
        costUsd: prevFeature.costUsd + costUsd,
      },
    },
    updatedAt: params.now,
  };
}

/** Builds the append-only per-call log record. */
function buildLogEntry(params: RecordUsageParams, costUsd: number) {
  return {
    uid: params.uid,
    feature: params.feature,
    model: params.model,
    promptTokens: params.usage.promptTokens,
    completionTokens: params.usage.completionTokens,
    totalTokens: params.usage.totalTokens,
    costUsd,
    createdAt: params.now,
  };
}

/**
 * Writes the period counter (read-modify-write in a transaction) and appends the
 * per-call log in the same transaction so a counter bump and its log row never
 * diverge. Returns the period + cost so the caller can surface/log them.
 */
export async function recordAiUsage(
  db: Firestore,
  params: RecordUsageParams
): Promise<{ period: string; costUsd: number }> {
  const costUsd = params.flatCostUsd ?? estimateCostUsd(params.model, params.usage);
  const period = currentPeriod(params.now);
  const usageRef = db.doc(`workspaces/${params.workspaceId}/aiUsage/${period}`);
  const logRef = db.collection(`workspaces/${params.workspaceId}/aiLog`).doc();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const prev = snap.exists ? (snap.data() as UsageDoc) : undefined;
    tx.set(usageRef, applyUsage(prev, params, costUsd));
    tx.set(logRef, buildLogEntry(params, costUsd));
  });

  return { period, costUsd };
}

/** First 16 hex chars of a sha256 of `workspaceId`, for logging without
 *  transmitting the raw identifier (Global Constraint: hashed workspace id
 *  only, never a raw id or user identifier). */
function hashWorkspaceId(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}

/**
 * Pure quota comparison, split out for unit testing without Firestore.
 * `callsThisPeriod < limit` is deliberately branch-free for `UNLIMITED`
 * (`Infinity`): `anything < Infinity` is always `true`, so pro/edu need no
 * special case. A missing/unrecognized plan reaches `limitFor` as `"free"`.
 */
export function isWithinAiQuota(plan: Plan | undefined, callsThisPeriod: number): boolean {
  return callsThisPeriod < limitFor((plan ?? "free") as Plan, "aiCallsPerPeriod");
}

/**
 * Function-side AI quota gate, live as of M5. Reads the live period counter
 * *and* the workspace's plan, then denies past the cap; this is now the real
 * enforcement point (the client `quotaService` is advisory only).
 *
 * Missing data and corrupt data get different fail-closed defaults, and the
 * order below is load-bearing: an absent doc/field (or explicit `null`, which
 * a partial write can leave behind) genuinely means zero calls so far and
 * must be checked *before* the type guard, or every workspace's first-ever
 * call would be denied. A `calls` value that exists but isn't a finite number
 * is untrustworthy, not zero, so it fails to `Number.POSITIVE_INFINITY`
 * instead — denying without needing to know the caller's plan limit here.
 */
export async function checkAiQuota(
  db: Firestore,
  workspaceId: string,
  now: number
): Promise<boolean> {
  const period = currentPeriod(now);
  const [usageSnap, workspaceSnap] = await Promise.all([
    db.doc(`workspaces/${workspaceId}/aiUsage/${period}`).get(),
    db.doc(`workspaces/${workspaceId}`).get(),
  ]);

  const rawCalls = usageSnap.exists ? usageSnap.data()?.calls : undefined;
  let calls: number;
  if (rawCalls == null) {
    // Absent doc, absent field, or explicit null all read as "no usage yet".
    calls = 0;
  } else if (typeof rawCalls === "number" && Number.isFinite(rawCalls)) {
    calls = rawCalls;
  } else {
    calls = Number.POSITIVE_INFINITY;
    // Fail-closed is silent by default; without a log line, a pro customer
    // whose counter corrupts just sees "quota exceeded" with no lead for
    // support to chase. No raw workspace id or usage value, per the
    // no-identifiers Global Constraint.
    logger.warn("checkAiQuota: corrupt aiUsage.calls, denying (fail closed)", {
      workspaceHash: hashWorkspaceId(workspaceId),
      period,
      rawCallsType: typeof rawCalls,
    });
  }

  const rawPlan = workspaceSnap.exists ? workspaceSnap.data()?.plan : undefined;
  const plan = typeof rawPlan === "string" ? (rawPlan as Plan) : undefined;

  return isWithinAiQuota(plan, calls);
}
