import type { Firestore } from "firebase-admin/firestore";
import type { ChatUsage } from "./provider";

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

/**
 * Function-side AI quota gate (Month 4, Phase 2 — M5 enforcement seam). Reads the
 * live period counter so M5 only flips a limit here rather than re-plumbing the
 * call site. Returns `true` for everyone today, mirroring the client `quotaService`
 * contract; the in-function token-bucket (rateLimit.ts) + dashboard caps are the
 * real backstop until M5.
 */
export async function checkAiQuota(
  db: Firestore,
  workspaceId: string,
  now: number
): Promise<boolean> {
  const period = currentPeriod(now);
  const snap = await db.doc(`workspaces/${workspaceId}/aiUsage/${period}`).get();
  // M5: compare snap usage against workspace.plan limits and return false past cap.
  void snap;
  return true;
}
