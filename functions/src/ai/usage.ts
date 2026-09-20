import type { Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { createHash } from "node:crypto";
import type { ChatUsage } from "./provider";
import { limitFor, type LimitedResource, type Plan } from "../billing/limits";

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
  // Month 6 — board Q&A embeddings. Input-only (an embed call has no
  // completion tokens; the trigger that meters it always reports 0 for
  // `completionTokens`), so `outputPerMillion` is never actually applied —
  // kept at the real rate anyway rather than 0, so a future caller that DID
  // pass a nonzero completionTokens by mistake gets a realistic estimate
  // instead of a silent free ride.
  "text-embedding-3-small": { inputPerMillion: 0.02, outputPerMillion: 0.02 },
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
  /**
   * Whether this call counts against the workspace-wide `aiCallsPerPeriod` cap.
   * Defaults to `true`; only automated, non-user-initiated spend passes `false`.
   *
   * Month 6 — the element-embedding trigger is the first caller to pass it, and
   * the reason is concrete. `aiCallsPerPeriod` is what a USER spends by asking
   * for something: a summary, an OCR, a question. The embedding trigger fires
   * on writes with nobody present, so counting its calls there made a free
   * workspace's five AI calls consumable by ordinary note-taking — roughly one
   * session of editing exhausted the month, at which point `boardQaPerPeriod`
   * (3) became unreachable AND the index stopped updating, so the answers would
   * have been stale even if they had been askable. The product displays that
   * limit of 3; it has to be able to honour it.
   *
   * `false` holds back ONLY the top-level `calls` counter. Tokens, prompt/
   * completion splits, `costUsd` and the per-feature entry all still
   * accumulate, so the spend stays fully visible on the usage page — this
   * changes what is GATED, never what is reported.
   *
   * PAIRING RULE: a feature metered with `countsTowardAiCap: false` must be
   * gated with `checkFeatureOnlyQuota`, never `checkFeatureQuota`. Gating it on
   * a workspace-wide counter it deliberately does not contribute to would mean
   * throttling it on other features' usage while its own growth was invisible.
   */
  countsTowardAiCap?: boolean;
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
    // The ONLY field `countsTowardAiCap: false` holds back — this is the
    // counter `checkAiQuota` gates on. Everything below still accumulates, so
    // an opted-out call is gated differently but reported identically.
    calls: base.calls + (params.countsTowardAiCap === false ? 0 : 1),
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
 *  only, never a raw id or user identifier). Exported so other modules that
 *  log a workspace (functions/src/http/stripeWebhook.ts) use this one
 *  implementation — a second copy could drift to a different digest or length
 *  and make log lines from the two impossible to correlate. */
export function hashWorkspaceId(workspaceId: string): string {
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
  const calls = readCounter(rawCalls, () =>
    // Fail-closed is silent by default; without a log line, a pro customer
    // whose counter corrupts just sees "quota exceeded" with no lead for
    // support to chase. No raw workspace id or usage value, per the
    // no-identifiers Global Constraint.
    logger.warn("checkAiQuota: corrupt aiUsage.calls, denying (fail closed)", {
      workspaceHash: hashWorkspaceId(workspaceId),
      period,
      rawCallsType: typeof rawCalls,
    })
  );

  return isWithinAiQuota(planOf(workspaceSnap), calls);
}

/**
 * Reads one stored call counter, fail-closed.
 *
 * Extracted from `checkAiQuota` (whose behaviour it reproduces exactly) so the
 * per-feature gate below cannot drift from it — two copies of a fail-closed
 * numeric guard is precisely how one of them ends up with a plain
 * `typeof x === "number"` check and silently starts granting on `NaN`.
 *
 * The ORDER is load-bearing, same as it always was: an absent doc/field, or an
 * explicit `null` that a partial write left behind, genuinely means "zero calls
 * so far" and must be recognised BEFORE the type guard, or every workspace's
 * first-ever call would be denied. Anything that exists but is not a finite
 * number is untrustworthy, not zero — `typeof NaN === "number"` and `NaN` is a
 * legal Firestore double — so it reads as `Infinity` and is denied by every
 * `used < limit` comparison, without this function needing to know the plan.
 */
export function readCounter(raw: unknown, onCorrupt: () => void): number {
  if (raw == null) return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  onCorrupt();
  return Number.POSITIVE_INFINITY;
}

/** The workspace doc's `plan`, or `undefined` when it is missing or isn't even
 *  a string — `limitFor` maps both to the free tier (fail closed). */
function planOf(workspaceSnap: { exists: boolean; data(): unknown }): Plan | undefined {
  const raw = workspaceSnap.exists
    ? (workspaceSnap.data() as { plan?: unknown } | undefined)?.plan
    : undefined;
  return typeof raw === "string" ? (raw as Plan) : undefined;
}

/**
 * Pure per-feature quota comparison — the same "deny unless provably under"
 * shape as `isWithinAiQuota`, against one feature's own row in the plan table
 * rather than the workspace-wide AI cap. Written `featureCalls < limit`, never
 * `featureCalls >= limit`: `limitFor` falls back to the free plan for an
 * unrecognised plan string, and a `>=` phrasing would GRANT on an `undefined`
 * limit rather than deny.
 */
export function isWithinFeatureQuota(
  plan: Plan | undefined,
  resource: LimitedResource,
  featureCalls: number
): boolean {
  return featureCalls < limitFor((plan ?? "free") as Plan, resource);
}

/**
 * Reads `byFeature[feature].calls` out of a period usage doc, fail-closed.
 *
 * Three cases have to stay distinct, and only the first is "no usage":
 *  - no `byFeature` map at all, or no entry for this feature — the honest
 *    "this workspace has never used this feature" case, so 0.
 *  - an entry that exists but isn't an object — a corrupt shape, not a zero.
 *  - an entry whose `calls` isn't a finite number — same, via `readCounter`.
 * The last two both fail closed to `Infinity`. Exported so the gate they feed
 * can be unit-tested on its own rather than only through a Firestore fake.
 */
export function readFeatureCalls(
  usageData: unknown,
  feature: string,
  onCorrupt: () => void
): number {
  const byFeature = (usageData as { byFeature?: unknown } | undefined)?.byFeature;
  if (byFeature == null) return 0;
  if (typeof byFeature !== "object") {
    onCorrupt();
    return Number.POSITIVE_INFINITY;
  }
  const entry = (byFeature as Record<string, unknown>)[feature];
  if (entry == null) return 0;
  if (typeof entry !== "object") {
    onCorrupt();
    return Number.POSITIVE_INFINITY;
  }
  return readCounter((entry as { calls?: unknown }).calls, onCorrupt);
}

/**
 * Function-side gate for a feature that carries its OWN plan row on top of the
 * workspace-wide AI cap (Month 6 — board Q&A is the first; see
 * `functions/src/callable/askBoard.ts`).
 *
 * Checks BOTH, and grants only if both grant:
 *  - the workspace-wide `aiCallsPerPeriod` cap, so a per-feature allowance can
 *    never be a way around the cap every other AI callable honours; and
 *  - the feature's own `resource` row, counted from this period's
 *    `byFeature[feature].calls`.
 *
 * One pair of reads serves both, rather than calling `checkAiQuota` and then
 * re-reading the same two documents for the feature counter.
 */
export async function checkFeatureQuota(
  db: Firestore,
  workspaceId: string,
  feature: string,
  resource: LimitedResource,
  now: number
): Promise<boolean> {
  const { plan, usageData, warnCorrupt } = await readQuotaState(
    db,
    workspaceId,
    feature,
    now,
    "checkFeatureQuota"
  );
  const calls = readCounter(
    (usageData as { calls?: unknown } | undefined)?.calls,
    warnCorrupt("calls")
  );
  const featureCalls = readFeatureCalls(usageData, feature, warnCorrupt("byFeature"));
  return (
    isWithinAiQuota(plan, calls) && isWithinFeatureQuota(plan, resource, featureCalls)
  );
}

/**
 * Gate for a feature that is metered with `countsTowardAiCap: false` — it
 * checks that feature's OWN plan row and nothing else.
 *
 * This is deliberately NOT `checkFeatureQuota` minus a clause; the two are a
 * matched pair with the metering flag, and using the wrong one is the bug:
 *
 *  - A feature that DOES count toward `aiCallsPerPeriod` must be gated by it
 *    too (`checkFeatureQuota`), or its own allowance becomes a route around the
 *    workspace-wide cap.
 *  - A feature that does NOT count toward it must NOT be gated by it (this
 *    function), or it gets throttled by other features' spend while its own
 *    growth contributes nothing to the counter doing the throttling — an
 *    unrelated summary could stop a board from re-indexing.
 *
 * Month 6 — the element-embedding trigger is the only caller. See
 * `RecordUsageParams.countsTowardAiCap` for why that trigger's spend was
 * carved out of the interactive cap in the first place.
 */
export async function checkFeatureOnlyQuota(
  db: Firestore,
  workspaceId: string,
  feature: string,
  resource: LimitedResource,
  now: number
): Promise<boolean> {
  const { plan, usageData, warnCorrupt } = await readQuotaState(
    db,
    workspaceId,
    feature,
    now,
    "checkFeatureOnlyQuota"
  );
  // Only the feature's own counter is read — so a corrupt workspace-wide
  // `calls` neither denies here nor logs a denial this gate is not making.
  const featureCalls = readFeatureCalls(usageData, feature, warnCorrupt("byFeature"));
  return isWithinFeatureQuota(plan, resource, featureCalls);
}

/** The plan and the raw period-usage document both gates above work from, in
 *  one pair of reads, plus the shared corrupt-counter logger. Each gate reads
 *  only the counters it actually uses — shared rather than copied for the same
 *  reason `readCounter` is: two copies of a fail-closed read is how one of
 *  them quietly loses its guard. */
async function readQuotaState(
  db: Firestore,
  workspaceId: string,
  feature: string,
  now: number,
  /** The gate calling in. Named in the log line so a denial is attributable to
   *  the function that actually made it — the two gates behave differently on
   *  the same data, so "which one denied" is the first thing anyone reading
   *  the line needs to know. */
  caller: string
): Promise<{
  plan: Plan | undefined;
  usageData: unknown;
  warnCorrupt: (field: string) => () => void;
}> {
  const period = currentPeriod(now);
  const [usageSnap, workspaceSnap] = await Promise.all([
    db.doc(`workspaces/${workspaceId}/aiUsage/${period}`).get(),
    db.doc(`workspaces/${workspaceId}`).get(),
  ]);

  return {
    plan: planOf(workspaceSnap),
    usageData: usageSnap.exists ? usageSnap.data() : undefined,
    warnCorrupt: (field: string) => () =>
      // Hashed workspace id only, never the raw one (Global Constraint), and no
      // counter value — a corrupt counter's own contents are not diagnostic.
      logger.warn(`${caller}: corrupt usage counter, denying (fail closed)`, {
        workspaceHash: hashWorkspaceId(workspaceId),
        period,
        feature,
        field,
      }),
  };
}
