import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { countOwnedWorkspaces, type OwnedWorkspaces } from "../billing/usage";
import { limitFor, type Plan } from "../billing/limits";

// Workspace creation is server-side so the free-tier workspace cap
// (functions/src/billing/limits.ts: `workspaces: 1`) can't be bypassed by a
// patched client or a raw REST call. It was the last of ROADMAP.md's five
// free-tier gates with no server-side enforcement at all: the old
// firestore.rules `allow create` asked only that the caller be the new doc's
// `ownerId`, be its `'owner'` member, and stamp `plan: 'free'` — no count
// condition, because rules have no way to count a caller's existing documents.
//
// The leak that closes is a spending one rather than a storage one. Every other
// quota is scoped PER WORKSPACE, so minting N workspaces yielded N×5 boards,
// N×5 AI calls/month and N×3 board-Q&A calls — real metered AI spend, on the
// tier that pays nothing.
//
// This is the ONLY create path: firestore.rules denies client workspace creates
// outright, and the Admin SDK write below bypasses rules. That makes this
// function load-bearing in the strongest sense of the three M5 create
// callables — see the ⛔ note below — and it must be deployed before those
// rules (see the warning at the top of firestore.rules).
//
// ⛔ THIS IS THE SIGNUP PATH. src/services/authService.ts provisions a personal
// workspace on account creation (`ensurePersonalWorkspace` ->
// `workspaceService.createWorkspace`), so this callable has to succeed for a
// user's FIRST workspace or new accounts cannot be created. Nothing here
// special-cases that first workspace, deliberately: a brand-new user owns zero
// workspaces, `0 < 1` is simply under the free cap, and a special case would be
// a second code path to get wrong.
//
// Plan resolution here is unlike every other gate in this package, and the
// difference is structural rather than stylistic. checkAiQuota,
// handleCreateBoard and handleCreateSession all read `plan` off the workspace
// that contains the thing being created. A workspace has no container. So the
// caller's entitlement is resolved as the BEST plan across the workspaces they
// already own (`resolveOwnerPlan`), read from the same query that does the
// counting. There is no user-level plan field anywhere in this codebase to read
// instead — inventing one would create a second source of truth for billing
// state that the Stripe webhook does not write.
//
// Honest caveat this function cannot close on its own: nothing pins `ownerId`
// on a workspace, so an owner can rewrite the field, keep their `members` entry
// and hide a workspace from the count — see `countOwnedWorkspaces` in
// functions/src/billing/usage.ts for the full route and what closing it needs.

export interface CreateWorkspaceRequest {
  name: string;
}

export interface CreateWorkspaceResponse {
  workspaceId: string;
}

/** Injected so the handler unit-tests without Firestore, matching
 *  handleCreateBoard's pattern (functions/src/callable/createBoard.ts). */
export interface CreateWorkspaceDeps {
  countOwnedWorkspaces(ownerId: string): Promise<OwnedWorkspaces>;
  writeWorkspace(doc: Record<string, unknown>): Promise<string>;
}

/** The caller's entitlement for THIS resource: the best plan among the
 *  workspaces they already own, with anything unrecognized treated as no
 *  entitlement at all (`free`) rather than trusted.
 *
 *  The pro-before-edu ordering decides nothing today — `workspaces` is
 *  UNLIMITED on both rows of PLAN_LIMITS — so this is written as an explicit
 *  ordering rather than an "any non-free plan" test purely so that a future
 *  finite `workspaces` number on one of them resolves deterministically instead
 *  of by whatever order Firestore returned the documents in. */
export function resolveOwnerPlan(plans: readonly string[]): Plan {
  if (plans.includes("pro")) return "pro";
  if (plans.includes("edu")) return "edu";
  return "free";
}

export async function handleCreateWorkspace(
  req: CallableRequest<CreateWorkspaceRequest>,
  deps: CreateWorkspaceDeps
): Promise<CreateWorkspaceResponse> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to create a workspace.");

  const { name } = req.data ?? ({} as CreateWorkspaceRequest);
  if (!name || !name.trim()) {
    throw new HttpsError("invalid-argument", "A workspace name is required.");
  }

  // One read answers both halves of the decision: how many workspaces this
  // caller owns, and what plan those workspaces put them on.
  const owned = await deps.countOwnedWorkspaces(uid);
  const plan = resolveOwnerPlan(owned.plans);
  const limit = limitFor(plan, "workspaces");
  // Same negated "deny unless PROVABLY under the cap" form as the board cap —
  // see the comment on handleCreateBoard's `!(used < limit)` in
  // functions/src/callable/createBoard.ts for why `used >= limit` is the wrong
  // shape, and why UNLIMITED needs no branch of its own.
  if (!(owned.count < limit)) {
    throw new HttpsError(
      "resource-exhausted",
      `You've reached your plan's workspace limit (${limit}). Upgrade for more.`
    );
  }

  const workspaceId = await deps.writeWorkspace({
    name: name.trim(),
    // Derived from the auth token, never from req.data — a client must not be
    // able to plant a workspace owned by (or charged against) somebody else.
    // Mirrors ownerId/adminId in handleCreateBoard.
    ownerId: uid,
    members: { [uid]: "owner" },
    // Parallel array for `array-contains` membership queries — the field
    // `workspaceService.getUserWorkspaces` actually queries on. Field-for-field
    // what the client used to write directly (src/services/workspaceService.ts),
    // since every reader of a workspace document predates this function.
    memberIds: [uid],
    // Forced, never taken from the client. A client that could mint a `pro`
    // workspace would hand itself every other gate at once, since all of them
    // read `plan` off the containing workspace. The Stripe webhook (Admin SDK)
    // stays the only writer of the field after this point.
    plan: "free",
    createdAt: FieldValue.serverTimestamp(),
  });

  return { workspaceId };
}

export const createWorkspace = onCall((req: CallableRequest<CreateWorkspaceRequest>) => {
  const db = getFirestore();
  return handleCreateWorkspace(req, {
    countOwnedWorkspaces: (ownerId) => countOwnedWorkspaces(db, ownerId),
    writeWorkspace: async (doc) => (await db.collection("workspaces").add(doc)).id,
  });
});
