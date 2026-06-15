// Phase 5 (roadmap item 5). Plan-gating choke point. The point of landing this
// now — while it returns `true` for everyone — is so the call sites exist before
// M5 needs them: M5 turns `checkQuota` into a real gate (read `workspace.plan` +
// current usage) without re-plumbing `createBoard` / `createSession` / the AI seam.
// No enforcement, no Stripe, no upsell UI this month.

// Resources a workspace plan can cap. `aiSummary` is the session-summary seam;
// `aiCall` is the generic AI-call resource M4 Phase 2 added so later AI features
// (OCR, explain, diagram) gate through the same choke point. The server-side gate
// lives in the Cloud Function (functions/src/ai/usage.ts#checkAiQuota); this client
// resource exists for create-path symmetry and the M5 plan-gating UI.
export type QuotaResource = "board" | "session" | "aiSummary" | "aiCall";

/** Thrown by `assertQuota` once a plan limit is hit (never today — see `checkQuota`). */
export class QuotaExceededError extends Error {
  constructor(
    public readonly resource: QuotaResource,
    public readonly workspaceId: string
  ) {
    super(`Plan quota exceeded for "${resource}" in workspace ${workspaceId}.`);
    this.name = "QuotaExceededError";
  }
}

/**
 * Whether `workspaceId` may create another `resource`. Returns `true` for every
 * workspace today (the choke point exists; the gate does not). M5 replaces this
 * body with `workspace.plan` + usage math; nothing at the call sites changes.
 */
export async function checkQuota(
  workspaceId: string,
  resource: QuotaResource
): Promise<boolean> {
  void workspaceId;
  void resource;
  return true;
}

/**
 * Choke-point guard for create paths: throws `QuotaExceededError` when the quota
 * is exhausted. A no-op today (`checkQuota` always allows), so call sites keep
 * today's behavior; when M5 flips `checkQuota`, the throw activates here with no
 * call-site change.
 */
export async function assertQuota(
  workspaceId: string,
  resource: QuotaResource
): Promise<void> {
  if (!(await checkQuota(workspaceId, resource))) {
    throw new QuotaExceededError(resource, workspaceId);
  }
}
