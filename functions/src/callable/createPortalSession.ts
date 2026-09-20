import Stripe from "stripe";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { stripeClient } from "../billing/stripe";
import { STRIPE_SECRET_KEY } from "../config";

// Month 5/6 — mints a Stripe Customer Portal session. The portal is where a
// customer cancels their subscription or changes their payment method — this
// plan deliberately builds no cancellation UI anywhere else, so this callable
// (plus the redirect it returns a URL for) is the entire cancellation/
// payment-update surface for the app.
//
// NOT LIVE. There is no Stripe account behind this repo: no API key, no
// product, no price, and no registered webhook endpoint. Everything below is
// written and unit-tested against a fake Stripe-shaped client
// (functions/src/__tests__/createPortalSession.test.ts) — the real Customer
// Portal API (`stripe.billingPortal.sessions.create` accepting these exact
// parameters, and a live account actually having a portal configuration to
// serve) has never been exercised. See the task report for the exact list of
// what a live account would still verify.
//
// The Stripe customer id this callable needs comes from
// `workspaces/{id}/billing/subscription.stripeCustomerId`, which the webhook
// (functions/src/http/stripeWebhook.ts) stamps on every applied event via
// `resolveCustomerId` — checkout completion, every subscription lifecycle
// event, and every failed-invoice event all record it. A workspace that has
// never had at least one such event has no customer id and nothing for the
// portal to show; see the `failed-precondition` below.

// Return URL: no billing screen exists in the app yet (a later task's job),
// so this points at the same custom URL scheme the rest of the app already
// uses for deep links (APP_SCHEME in src/lib/deepLinks.ts) rather than a real
// route — mirrors CHECKOUT_SUCCESS_URL/CHECKOUT_CANCEL_URL in
// functions/src/billing/stripe.ts. Update once a billing screen exists.
const PORTAL_RETURN_URL = "boardapp://billing";

export interface CreatePortalSessionRequest {
  workspaceId: string;
}

export interface CreatePortalSessionResponse {
  url: string;
}

/** The slice of the Stripe SDK this file calls, narrower than the full
 *  `Stripe` type so a test can inject a minimal fake instead of mocking the
 *  whole SDK — mirrors `StripeCheckoutClient` in functions/src/billing/
 *  stripe.ts. The real client from `stripeClient` satisfies this
 *  structurally, with no adapter needed. */
export interface StripeBillingPortalClient {
  billingPortal: {
    sessions: {
      create(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }>;
    };
  };
}

/** Injected so the handler unit-tests without Firestore or the Stripe SDK,
 *  matching CreateCheckoutSessionDeps (functions/src/callable/
 *  createCheckoutSession.ts). `createPortalSession` is the only place a
 *  Stripe API call happens — nothing about Stripe is visible to the
 *  handler. */
export interface CreatePortalSessionDeps {
  getWorkspace(workspaceId: string): Promise<{ members?: Record<string, string> } | null>;
  /** Reads `workspaces/{id}/billing/subscription` for the Stripe customer id
   *  — the only field this callable needs from that document. `null` covers
   *  both "no subscription document exists yet" and "one exists but never
   *  recorded a customer id" (a partially-written doc); both mean the same
   *  thing here — there is nothing for the portal to manage. */
  getStripeCustomerId(workspaceId: string): Promise<string | null>;
  createPortalSession(stripeCustomerId: string): Promise<{ url: string }>;
}

/** Creates the Customer Portal session. Split out as its own exported
 *  function — rather than inlined in the onCall binding below — so it
 *  unit-tests directly against a fake Stripe-shaped client, the same way
 *  `createCheckoutSession` in functions/src/billing/stripe.ts does; the
 *  onCall binding's `createPortalSession` dep is a thin call to this. */
export async function createBillingPortalSession(
  stripe: StripeBillingPortalClient,
  customerId: string,
  returnUrl: string
): Promise<{ url: string }> {
  let session: { url: string };
  try {
    session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  } catch (err) {
    // Same mapping as createCheckoutSession.ts's Stripe call: a malformed
    // request (e.g. no default portal configuration set up for this Stripe
    // account) is a server-side configuration problem, not something the
    // caller did wrong, and Stripe's raw message can leak account details —
    // map it to one caller-safe message. Anything else propagates unchanged
    // for the default `internal` scrub.
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      throw new HttpsError(
        "failed-precondition",
        "The billing portal is temporarily unavailable. Please try again later."
      );
    }
    throw err;
  }
  if (!session.url) {
    throw new HttpsError("internal", "Stripe did not return a billing portal URL.");
  }
  return { url: session.url };
}

export async function handleCreatePortalSession(
  req: CallableRequest<CreatePortalSessionRequest>,
  deps: CreatePortalSessionDeps
): Promise<CreatePortalSessionResponse> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to manage billing.");

  const { workspaceId } = (req.data ?? {}) as Partial<CreatePortalSessionRequest>;
  if (!workspaceId) throw new HttpsError("invalid-argument", "workspaceId is required.");

  const ws = await deps.getWorkspace(workspaceId);
  if (!ws) throw new HttpsError("not-found", "Workspace not found.");

  // Only the owner may manage billing — same restriction, and the same
  // deny-unless-provably-permitted comparison, as
  // handleCreateCheckoutSession: a missing `members` map or a uid absent
  // from it both read as `undefined !== "owner"`, which denies.
  if (!ws.members || ws.members[uid] !== "owner") {
    throw new HttpsError("permission-denied", "Only the workspace owner can manage billing.");
  }

  const stripeCustomerId = await deps.getStripeCustomerId(workspaceId);
  // No customer id means Stripe has never processed an event for this
  // workspace (it has never started, or never completed, a checkout), so
  // there is no billing account for the portal to show. Distinct from a
  // Stripe-side failure, which propagates from `createPortalSession` below.
  if (!stripeCustomerId) {
    throw new HttpsError(
      "failed-precondition",
      "This workspace has no billing account to manage yet."
    );
  }

  return deps.createPortalSession(stripeCustomerId);
}

export const createPortalSession = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  (req: CallableRequest<CreatePortalSessionRequest>) => {
    const db = getFirestore();
    return handleCreatePortalSession(req, {
      getWorkspace: async (id) => {
        const s = await db.doc(`workspaces/${id}`).get();
        return s.exists ? (s.data() as { members?: Record<string, string> }) : null;
      },
      getStripeCustomerId: async (id) => {
        const snap = await db.doc(`workspaces/${id}/billing/subscription`).get();
        const customerId = snap.exists ? snap.data()?.stripeCustomerId : undefined;
        return typeof customerId === "string" && customerId.length > 0 ? customerId : null;
      },
      createPortalSession: (customerId) =>
        createBillingPortalSession(
          stripeClient(STRIPE_SECRET_KEY.value()),
          customerId,
          PORTAL_RETURN_URL
        ),
    });
  }
);
