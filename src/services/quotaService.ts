// ⚠️ ADVISORY ONLY — NOT AN ENFORCEMENT POINT.
//
// This module exists so the UI can warn a user *before* a create fails.
//
// AI calls ARE gated server-side today: functions/src/ai/usage.ts#checkAiQuota
// reads the workspace's plan and period usage and denies past the cap.
//
// Board and session limits are NOT enforced server-side yet. As of this
// writing, firestore.rules lets a signed-in workspace member create a board
// or session directly with no count or plan condition, and nothing else
// intercepts either create path — so the `boards` / `sessionsPerPeriod`
// numbers this module compares against are backed by nothing server-side.
// A create-time server check and a matching rules denial for both are
// expected on this branch later; when they land, update this comment to say
// so rather than trusting this note to still be accurate.
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

const RESOURCE_TO_LIMIT: Record<QuotaResource, Parameters<typeof limitFor>[1]> = {
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
 * TODO(quota-wiring): the production call sites (`boardService.createBoard`,
 * `sessionService.createSession`) currently call this with 2 args, so `plan`
 * and `currentCount` fall back to `"free"`/`0` and `checkQuota` always
 * evaluates `0 < limit` -> true. The comparison logic above is exercised only
 * by this file's own tests until those call sites are wired to pass the
 * workspace's real plan and current count.
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
