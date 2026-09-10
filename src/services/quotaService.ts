// ⚠️ ADVISORY ONLY — NOT AN ENFORCEMENT POINT.
//
// This module exists so the UI can warn a user *before* a create fails.
//
// AI calls ARE gated server-side today: functions/src/ai/usage.ts#checkAiQuota
// reads the workspace's plan and period usage and denies past the cap.
//
// Boards ARE gated server-side: the `createBoard` callable
// (functions/src/callable/createBoard.ts) reads the live board count and denies
// past the plan's cap before writing, and firestore.rules now denies client
// board creates outright (`allow create: if false`), so the callable is the only
// create path. The cap rests on a second rule as well: firestore.rules pins a
// board's `workspaceId` on update, because the callable counts boards by
// workspace and a client that could unset that field would hide its boards from
// the count and earn a fresh allowance.
//
// Remaining caveat: boards predating the workspace migration have no
// `workspaceId`, so the count cannot see them and they don't consume a slot —
// the cap undercounts for those accounts until the backfill runs. That is
// existing data, not a route a client can take.
//
// Sessions ARE gated server-side: the `createSession` callable
// (functions/src/callable/createSession.ts) bumps the workspace's monthly
// session counter and writes the session in one transaction, denying past the
// plan's cap, and firestore.rules now denies client session creates outright.
//
// Collaborators per board are gated in firestore.rules directly, as a predicate
// on board `update` — the invite-code self-join path is an update to `members`,
// not a create, so no callable could gate it. That is the only enforcement point
// for that limit; nothing on the Functions side reads it.
//
// Workspaces are gated NOWHERE. firestore.rules' `match /workspaces/{workspaceId}`
// `allow create` requires only that the caller is the new doc's `ownerId`, is
// recorded as its `'owner'` member, and that `plan == 'free'` — there is no
// count condition, and rules have no way to write one (they cannot count a
// caller's existing documents). No callable owns
// workspace creation the way createBoard/createSession own theirs; the client
// (workspaceService.createWorkspace) writes the doc directly. PLAN_LIMITS.free.
// workspaces (src/lib/planLimits.ts) is a display value only — nothing denies a
// user who creates a second, tenth, or hundredth workspace, and each fresh
// workspace grants its own 5 boards and 5 AI calls. This is the free tier's most
// expensive uncapped resource. Closing it needs a `createWorkspace` callable
// mirroring createBoard/createSession — out of scope here; do not treat this
// limit as enforced anywhere.
//
// Never add a limit here and consider it enforced without independently
// confirming the server side actually denies it. A patched bundle skips this
// file entirely.

import { limitFor } from "../lib/planLimits";
import type { Plan } from "../types";

// Resources a workspace plan can cap. `aiSummary` is the session-summary seam;
// `aiCall` is the generic AI-call resource M4 Phase 2 added so later AI features
// (OCR, explain, diagram) gate through the same choke point. The server-side gate
// lives in the Cloud Function (functions/src/ai/usage.ts#checkAiQuota); this client
// resource exists for create-path symmetry and the M5 plan-gating UI.
export type QuotaResource = "board" | "session" | "aiSummary" | "aiCall";

/** Thrown by `assertQuota` once its advisory pre-flight thinks a plan limit is
 *  hit. Never a substitute for the server's rejection — a caller must still
 *  handle that (see the module header). */
export class QuotaExceededError extends Error {
  constructor(
    public readonly resource: QuotaResource,
    public readonly workspaceId: string
  ) {
    super(`Plan quota exceeded for "${resource}" in workspace ${workspaceId}.`);
    this.name = "QuotaExceededError";
  }
}

// Exported so callers that display the limit (the upsell modal) resolve the same
// `planLimits.ts` key this module's own check uses, instead of re-deriving it.
export const RESOURCE_TO_LIMIT: Record<QuotaResource, Parameters<typeof limitFor>[1]> = {
  board: "boards",
  session: "sessionsPerPeriod",
  aiSummary: "aiCallsPerPeriod",
  aiCall: "aiCallsPerPeriod",
};

/**
 * Advisory pre-flight (see the module header). Returns the UI's best guess so
 * it can show an upsell before the user acts and avoid a pointless round trip
 * — it is NOT the gate. The server (a callable, or `checkAiQuota` for AI) makes
 * the real decision and can still reject a call this returned `true` for; every
 * caller must handle that rejection regardless of what this returns.
 *
 * `plan` and `currentCount` are supplied by the caller from the active
 * workspace's already-loaded state so this stays a pure, synchronous-ish check
 * with no extra Firestore read of its own. `workspaceId` is kept for interface
 * stability (callers/tests pass it) though the check itself doesn't need it.
 */
export async function checkQuota(
  workspaceId: string,
  resource: QuotaResource,
  plan: Plan = "free",
  currentCount = 0
): Promise<boolean> {
  void workspaceId;
  return currentCount < limitFor(plan, RESOURCE_TO_LIMIT[resource]);
}

/**
 * Choke-point guard for create paths: throws `QuotaExceededError` when the
 * advisory pre-flight above thinks the quota is exhausted. This is UX only —
 * catching or not catching this error changes nothing about server
 * enforcement, which happens independently in the callable / `checkAiQuota`.
 *
 * Wiring note: `boardService.createBoard` passes its caller's real `plan` and
 * board count (both already loaded on the one dashboard screen that creates
 * boards — no extra read here). `sessionService.createSession` passes a real
 * `plan` (the board's already-loaded workspace) but NOT a real `currentCount`:
 * the authoritative count lives in `workspaces/{id}/usage/{period}`
 * (functions/src/billing/usage.ts), which firestore.rules restricts to
 * workspace owner/admin readers — most session creators can't read it, and
 * fetching it would add the very round trip this pre-flight exists to avoid.
 * `currentCount` for "session" falls back to its `0` default until a
 * member-readable session-usage path exists; the plan is still real, and the
 * server's rejection is still handled regardless of what this predicts.
 */
export async function assertQuota(
  workspaceId: string,
  resource: QuotaResource,
  plan?: Plan,
  currentCount?: number
): Promise<void> {
  if (!(await checkQuota(workspaceId, resource, plan, currentCount))) {
    throw new QuotaExceededError(resource, workspaceId);
  }
}

// ── server rejection detection ──────────────────────────────────────────────
// This is the REAL gate's rejection (see the module header) — the thing every
// create/AI call site must catch to show the upsell modal instead of a generic
// error. The Firebase JS SDK wraps a callable's HttpsError into a
// `FunctionsError` whose `.code` is prefixed `"functions/"` (the RPC status
// alone, e.g. "resource-exhausted", never reaches the client unprefixed) — see
// `FunctionsError` in @firebase/functions. Call sites must check `.code`
// through this helper, never `.message` text, so a reworded server message
// never silently stops being detected.
export const RESOURCE_EXHAUSTED_CODE = "functions/resource-exhausted";

/** True when `err` is the `resource-exhausted` callable rejection
 *  (functions/src/callable/createBoard.ts, createSession.ts, and the four AI
 *  callables via checkAiQuota). A network error, an unrelated HttpsError, or
 *  anything else must NOT match — callers branch on this instead of catching
 *  broadly so a real failure never reads as "upgrade".
 *
 *  NOT the same thing as "the plan cap was hit": on the four AI callables this
 *  code also fires for the plan-INDEPENDENT per-workspace request-rate
 *  throttle (30 burst / 1 per 30s), which the server does not distinguish
 *  from the plan-cap denial via `details`. A caller that wants to tell them
 *  apart needs the workspace's own `plan` (see UpsellModal/upsellCopy's
 *  `isPlanCapped`) — Pro/Edu are unlimited for every resource this modal
 *  covers, so `resource-exhausted` on those plans can only be the throttle. */
export function isResourceExhausted(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === RESOURCE_EXHAUSTED_CODE
  );
}

/** True when `err` is EITHER shape a create/AI path can reject with once a
 *  plan limit is (or looks) exhausted:
 *   - `isResourceExhausted(err)` — the server's real denial, arriving after
 *     the callable actually ran.
 *   - `err instanceof QuotaExceededError` — THIS module's own advisory
 *     pre-flight (`assertQuota`, called from `boardService.createBoard` and
 *     `sessionService.createSession`) throwing BEFORE the callable ever runs.
 *     A caller that checks `isResourceExhausted` alone misses this entirely:
 *     `QuotaExceededError` carries no `.code`, so it falls through to a
 *     generic error path and the raw `Plan quota exceeded for "..." in
 *     workspace ...` message reaches the user, un-actionable, while the
 *     modal never opens and the server is never even asked.
 *  Every create/AI call site must use THIS function, not `isResourceExhausted`
 *  alone, to decide whether to show the upsell. */
export function isQuotaDenial(err: unknown): boolean {
  return isResourceExhausted(err) || err instanceof QuotaExceededError;
}
