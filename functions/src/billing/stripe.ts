import Stripe from "stripe";
import { HttpsError } from "firebase-functions/v2/https";

// Month 5 — everything Stripe-specific lives in this file, split out of the
// callable (functions/src/callable/createCheckoutSession.ts) on purpose:
// neither needs the other's runtime to unit test. This file never touches
// Firestore or the caller's request; the callable's handler never imports the
// Stripe SDK (it goes through CreateCheckoutSessionDeps.createSession
// instead, which the onCall binding wires to the functions below).
//
// There is no Stripe account behind this yet: no product, no live price, no
// webhook endpoint. Everything in this file is written and unit-tested
// against a fake Stripe-shaped client (see
// functions/src/__tests__/stripeCheckout.test.ts) — the real Checkout API has
// not been exercised, so its acceptance of these exact parameters is
// unverified.

/** Pinned to the API version the installed `stripe` package's TS types were
 *  generated against (node_modules/stripe/.../apiVersion.d.ts). `Stripe.
 *  LatestApiVersion` is a single-literal type, so passing any other string
 *  here is a compile error, not a silent mismatch. */
const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2026-08-26.dahlia";

// Placeholder redirect targets. No billing screen exists in the app yet (that
// is a later task's job), so these point at the same custom URL scheme the
// rest of the app already uses for deep links (APP_SCHEME in
// src/lib/deepLinks.ts) rather than a real route. They are not wired to any
// screen today — update them here once one exists. `{CHECKOUT_SESSION_ID}` is
// a literal Stripe template token; Stripe substitutes it, this code does not.
const CHECKOUT_SUCCESS_URL = "boardapp://billing/success?session_id={CHECKOUT_SESSION_ID}";
const CHECKOUT_CANCEL_URL = "boardapp://billing/cancel";

export interface CreateCheckoutSessionParams {
  workspaceId: string;
  uid: string;
}

/** Fails closed on missing config instead of letting a blank string reach the
 *  Stripe SDK, which would otherwise surface as an opaque authentication or
 *  "resource missing" error with no hint that this was a deploy/config
 *  problem rather than a caller error. Plain strings in (not `defineSecret`
 *  handles), so this is testable with no Functions secrets runtime. */
export function assertStripeConfigured(secretKey: string, priceId: string): void {
  if (!secretKey) {
    throw new HttpsError("failed-precondition", "Stripe is not configured (missing secret key).");
  }
  if (!priceId) {
    throw new HttpsError("failed-precondition", "Stripe is not configured (missing Pro price id).");
  }
}

/** Constructs the real Stripe client from an already-resolved secret value.
 *  Takes the key as a parameter rather than reading `STRIPE_SECRET_KEY.
 *  value()` itself, so this stays a plain function of its inputs — only the
 *  onCall binding in createCheckoutSession.ts (and, later, the webhook's
 *  onRequest binding) ever calls this with a real key. */
export function stripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, typescript: true });
}

/** The slice of the Stripe SDK this module actually calls, narrower than the
 *  full `Stripe` type so a test can inject a minimal fake instead of mocking
 *  the whole SDK. The real client from `stripeClient` satisfies this
 *  structurally, with no adapter needed. */
export interface StripeCheckoutClient {
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<{ url: string | null }>;
    };
  };
}

/** Creates the Checkout Session for a Pro subscription. `priceId` is always
 *  server-resolved (STRIPE_PRO_PRICE_ID) by the caller — this function has no
 *  parameter through which a client-chosen price could reach the Stripe API,
 *  which is the entire security point of this task. */
export async function createCheckoutSession(
  stripe: StripeCheckoutClient,
  priceId: string,
  params: CreateCheckoutSessionParams
): Promise<{ url: string }> {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: params.workspaceId,
    metadata: { workspaceId: params.workspaceId, uid: params.uid },
    success_url: CHECKOUT_SUCCESS_URL,
    cancel_url: CHECKOUT_CANCEL_URL,
  });

  if (!session.url) {
    throw new HttpsError("internal", "Stripe did not return a checkout URL.");
  }
  return { url: session.url };
}
