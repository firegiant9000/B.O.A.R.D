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
//
// THE DOUBLE-CHECKOUT GUARD. `plan !== "free"` alone is not enough: `plan` is
// written by the webhook only once a Stripe event is PROCESSED
// (functions/src/http/stripeWebhook.ts), so a subscription can already be
// live in Stripe — and already recorded on the subscription document — while
// `plan` here still reads "free". Two real cases land exactly there:
//   - `checkout.session.completed` with an unsettled async payment method
//     writes `status: "incomplete"` and leaves `plan` unchanged
//     (evaluateCheckoutSession) while the first session's payment is still
//     pending.
//   - A previously-paying subscription downgraded to "unpaid" or "paused"
//     also reverts `plan` to "free" (REVOKE_STATUSES), but the Stripe
//     subscription object itself still exists — it was downgraded, not
//     deleted.
// Reading the subscription document below closes that gap for the SEQUENTIAL
// case: a second `createCheckoutSession` call made after the first event has
// already been applied is refused.
//
// NOT CLOSED by this guard: two calls made back-to-back BEFORE either
// checkout's payment event has reached the webhook. Both calls read the same
// pre-payment state (no live subscription recorded yet) and both are
// permitted — this file holds no lock across concurrent invocations, and
// closing that race would mean changing the webhook's transaction, which is
// out of scope for this task. See the task report for the full account.

export interface CreateCheckoutSessionRequest {
  workspaceId: string;
}

export interface CreateCheckoutSessionResponse {
  url: string;
}

/** Statuses for which a Stripe subscription object is PROVABLY gone or never
 *  came to life — the only two states excluded from "live" below. Every
 *  other status, including one this file has never heard of, blocks a second
 *  Checkout Session: deny-unless-provably-permitted (Global Constraints),
 *  applied to a category instead of a number.
 *
 *  - "canceled": the subscription is deleted. Excluding it is the entire
 *    point of this allowlist — a customer who cancels through the Customer
 *    Portal must be able to start a fresh Checkout, or cancellation becomes
 *    a one-way door out of the product.
 *  - "incomplete_expired": the FIRST invoice's payment was never confirmed
 *    (an abandoned 3-D Secure, say) and Stripe auto-expired the subscription
 *    ~23h later. It never collected anything and never will; a new Checkout
 *    Session is the only way forward.
 *
 *  Deliberately NOT excluded, even though the webhook's own REVOKE_STATUSES
 *  (functions/src/http/stripeWebhook.ts) groups them with "canceled" for the
 *  purpose of downgrading `plan`: "unpaid" and "paused" still name a live
 *  Stripe subscription object that was downgraded, not deleted. Letting a
 *  fresh Checkout Session through for either would leave that subscription
 *  dangling alongside a second, genuinely duplicate one.
 *
 *  - "unpaid": the Customer Portal is the intended fix — the customer
 *    updates their payment method there and Stripe retries the SAME
 *    subscription, no new Checkout needed.
 *  - "paused": comes from `pause_collection`, which is operator-set, not
 *    customer-set, and the Customer Portal exposes no resume control for
 *    it. Nothing in this app pauses a subscription, so this is reachable
 *    only by an operator acting directly on Stripe — and that operator is
 *    also the one who can unpause it. The denial thrown below says so
 *    honestly (see `denySecondCheckout`) rather than pointing at the
 *    portal, which would be a false claim for this one status. */
const NON_LIVE_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);

/** True unless `status` is PROVABLY one of the two terminal values above. A
 *  missing/non-string status on an EXISTING subscription document — a
 *  partially-written doc — also reads as live: it does not prove the
 *  subscription is gone, so it must not be trusted to permit a second
 *  charge (fail closed on an unreadable document, per this task's brief). */
function isLiveSubscriptionStatus(status: unknown): boolean {
  return !(typeof status === "string" && NON_LIVE_SUBSCRIPTION_STATUSES.has(status));
}

/** Denies a second checkout, distinguishably from the plan check just above
 *  it. Both use `failed-precondition` — the SAME code — because a client
 *  branching on error code alone couldn't tell them apart, and previously
 *  neither carried anything else: a caller had no signal beyond a string to
 *  match against. `details.reason` is that signal, and `startCheckout`
 *  (src/services/billingService.ts) now preserves it through to the caller
 *  instead of discarding it.
 *
 *  Message and `canOpenPortal` vary by status, because the honest remedy
 *  does: for everything except "paused", the Customer Portal is a real next
 *  step (it is the general per-customer billing surface, regardless of the
 *  specific subscription status behind it). For "paused" specifically it is
 *  not — see the comment on NON_LIVE_SUBSCRIPTION_STATUSES above — so that
 *  one status gets its own message rather than repeating a false claim. */
function denySecondCheckout(status: unknown): never {
  if (status === "paused") {
    throw new HttpsError(
      "failed-precondition",
      "This workspace's subscription is paused and can only be resumed by an operator.",
      { reason: "subscription-paused", canOpenPortal: false }
    );
  }
  throw new HttpsError(
    "failed-precondition",
    "This workspace's subscription needs attention in the billing portal.",
    { reason: "subscription-exists", canOpenPortal: true }
  );
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
  /** Reads `workspaces/{id}/billing/subscription` (Admin SDK; bypasses
   *  rules). Returns `null` when the workspace has never had a subscription
   *  document — the ordinary case for a workspace that has never paid, and
   *  NOT grounds to refuse a checkout. Returns the raw stored `status` field
   *  when a document exists; kept `unknown` because the document can have
   *  been written by an older deploy (same convention as
   *  StripeWebhookStore.readSubscription in functions/src/http/
   *  stripeWebhook.ts). */
  getSubscriptionStatus(workspaceId: string): Promise<{ status?: unknown } | null>;
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

  // The double-checkout guard — see the header comment for exactly what this
  // does and does not close. Absence of the subscription document (`null`)
  // is the ordinary case and must NOT block; only a document that exists AND
  // is provably live does.
  const subscription = await deps.getSubscriptionStatus(workspaceId);
  if (subscription !== null && isLiveSubscriptionStatus(subscription.status)) {
    denySecondCheckout(subscription.status);
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
      getSubscriptionStatus: async (id) => {
        const snap = await db.doc(`workspaces/${id}/billing/subscription`).get();
        return snap.exists ? ((snap.data() ?? {}) as { status?: unknown }) : null;
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
