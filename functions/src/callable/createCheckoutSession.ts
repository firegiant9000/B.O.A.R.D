import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  assertStripeConfigured,
  createCheckoutSession as createStripeCheckoutSession,
  stripeClient,
  type CreateCheckoutSessionParams,
} from "../billing/stripe";
import { STRIPE_SECRET_KEY, STRIPE_PRO_PRICE_ID } from "../config";
import type { Plan } from "../billing/limits";

// Month 5 — starts a Stripe Checkout session that is meant to upgrade a
// workspace to Pro once paid, lifting the plan limits enforced in
// functions/src/billing/limits.ts; the webhook that writes `plan` from a
// completed checkout is a separate, later piece of work, not this one. There
// is no Stripe account behind this yet — no product, no live price, no
// webhook endpoint — so no payment actually completes anywhere today.
//
// The price ID is resolved entirely server-side from STRIPE_PRO_PRICE_ID
// (functions/src/config.ts) — this request type carries no price field at
// all, so there is nothing for a client to smuggle a cheaper (or $0) price
// through. See CreateCheckoutSessionRequest below.

export interface CreateCheckoutSessionRequest {
  workspaceId: string;
}

export interface CreateCheckoutSessionResponse {
  url: string;
}

/** Injected so the handler unit-tests without Firestore or the Stripe SDK,
 *  matching handleCreateBoard/handleCreateSession's pattern. `createSession`
 *  is the only place a Stripe API call happens — the real implementation
 *  (wired in the onCall binding below) resolves the price server-side and
 *  constructs the Stripe client itself; nothing about Stripe is visible to
 *  the handler. */
export interface CreateCheckoutSessionDeps {
  getWorkspace(
    workspaceId: string
  ): Promise<{ plan?: string; members?: Record<string, string> } | null>;
  createSession(params: CreateCheckoutSessionParams): Promise<{ url: string }>;
}

export async function handleCreateCheckoutSession(
  req: CallableRequest<CreateCheckoutSessionRequest>,
  deps: CreateCheckoutSessionDeps
): Promise<CreateCheckoutSessionResponse> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to start a checkout.");

  // Only `workspaceId` is read from req.data. There is no `priceId` field on
  // CreateCheckoutSessionRequest to even accidentally read — a client cannot
  // choose its own price no matter what it sends in the payload.
  const { workspaceId } = (req.data ?? {}) as Partial<CreateCheckoutSessionRequest>;
  if (!workspaceId) throw new HttpsError("invalid-argument", "workspaceId is required.");

  const ws = await deps.getWorkspace(workspaceId);
  if (!ws) throw new HttpsError("not-found", "Workspace not found.");

  // Only the owner may start a checkout — deny unless the caller is
  // PROVABLY the owner, rather than allow unless provably not. A missing
  // `members` map or a uid absent from it both read as `undefined !==
  // "owner"`, which denies, so a non-member takes the same path as a
  // wrong-role member instead of throwing on a missing lookup.
  if (!ws.members || ws.members[uid] !== "owner") {
    throw new HttpsError("permission-denied", "Only the workspace owner can start a checkout.");
  }

  // A workspace already on a paid (or edu) plan has nothing to upgrade to —
  // deny unless the plan is PROVABLY "free", the same fail-closed direction
  // as the owner check above. A missing `plan` field defaults to "free"
  // (same convention as handleCreateBoard/handleCreateSession) so a brand
  // new workspace can still check out.
  const plan = (ws.plan ?? "free") as Plan;
  if (plan !== "free") {
    throw new HttpsError("failed-precondition", "This workspace already has an active plan.");
  }

  return deps.createSession({ workspaceId, uid });
}

export const createCheckoutSession = onCall(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_PRO_PRICE_ID] },
  (req: CallableRequest<CreateCheckoutSessionRequest>) => {
    const db = getFirestore();
    return handleCreateCheckoutSession(req, {
      getWorkspace: async (id) => {
        const s = await db.doc(`workspaces/${id}`).get();
        return s.exists
          ? (s.data() as { plan?: string; members?: Record<string, string> })
          : null;
      },
      createSession: async (params) => {
        const secretKey = STRIPE_SECRET_KEY.value();
        const priceId = STRIPE_PRO_PRICE_ID.value();
        assertStripeConfigured(secretKey, priceId);
        return createStripeCheckoutSession(stripeClient(secretKey), priceId, params);
      },
    });
  }
);
