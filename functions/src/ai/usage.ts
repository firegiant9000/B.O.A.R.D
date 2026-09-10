import type { Firestore } from "firebase-admin/firestore";
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

/**
 * Pure quota comparison, split out for unit testing without Firestore. A
 * missing/unknown plan is passed through as `"free"` before reaching `limitFor`,
 * which *also* falls back to `free` for anything it doesn't recognize — so a
 * corrupt or future plan value fails closed twice over, not by accident.
 *
 * `callsThisPeriod < limit` (rather than `>= limit` for the block case) is the
 * deliberate direction: pro/edu are `UNLIMITED` (`Infinity`), and
 * `anything < Infinity` is always `true` with no special-casing needed. Callers
 * must still pass an already-guarded, finite `callsThisPeriod` — see
 * `checkAiQuota` below — since comparing a corrupt value here is not a
 * substitute for validating it at the read site.
 */
export function isWithinAiQuota(plan: Plan | undefined, callsThisPeriod: number): boolean {
  return callsThisPeriod < limitFor((plan ?? "free") as Plan, "aiCallsPerPeriod");
}

/**
 * Function-side AI quota gate (Month 4 Phase 2 seam, live as of M5). Reads the
 * live period counter *and* the workspace's plan, then denies past the cap.
 * The in-function token-bucket (rateLimit.ts) + dashboard caps remain an
 * additional backstop; this is now the actual quota enforcement point — the
 * client `quotaService` is advisory only (see its module header).
 *
 * Two different "the data isn't there" cases are deliberately given different
 * fail-closed defaults, not the same one:
 *   - No usage doc (or the doc exists but never got a `calls` field) genuinely
 *     means zero AI calls so far this period — 0 is the correct reading, not a
 *     fallback.
 *   - A `calls` field that exists but isn't a finite number (`NaN` — a legal
 *     Firestore double — a string, etc.) is corrupt data, and defaulting THAT
 *     to 0 would be the exact fail-open trap this task calls out: a counter
 *     that gets corrupted and never self-heals (`recordAiUsage`'s
 *     accumulation is `base.calls + 1`, so once `calls` is `NaN` it stays
 *     `NaN` forever) would then read as "0 calls" on every single check,
 *     forever, silently granting unlimited AI to a free workspace. So corrupt
 *     data instead fails closed to `Number.POSITIVE_INFINITY` — guaranteed to
 *     land on the deny side of `isWithinAiQuota`'s `< limit` comparison for
 *     every *finite* plan limit, with no knowledge of which plan is in play
 *     required at this read site.
 * `typeof x === "number" && Number.isFinite(x)` is required (not
 * `Number.isFinite` alone, which isn't a type predicate and won't narrow
 * under this repo's strict mode) to actually catch `NaN`, since
 * `typeof NaN === "number"`.
 *
 * The workspace's `plan` field gets the same treatment: missing/non-string is
 * passed through as `undefined`, which `isWithinAiQuota` maps to `"free"`;
 * a defined-but-unrecognized plan string is deliberately *not* filtered here
 * and instead relies on `limitFor`'s own `?? PLAN_LIMITS.free` fallback — one
 * intentional fail-closed path, not two independent ones drifting apart.
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
  const calls =
    rawCalls === undefined
      ? 0
      : typeof rawCalls === "number" && Number.isFinite(rawCalls)
        ? rawCalls
        : Number.POSITIVE_INFINITY;

  const rawPlan = workspaceSnap.exists ? workspaceSnap.data()?.plan : undefined;
  const plan = typeof rawPlan === "string" ? (rawPlan as Plan) : undefined;

  return isWithinAiQuota(plan, calls);
}
