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

// Redirect targets Stripe sends a customer to after hosted Checkout. These
// used to point at boardapp://billing/success and boardapp://billing/cancel
// — the app's custom URL scheme (APP_SCHEME in src/lib/deepLinks.ts) — from
// back when no billing screen existed anywhere in the app. That screen now
// exists (app/pricing.tsx, Month 5/6, rendering src/components/
// PricingBody.tsx on web only — see those files' headers): checkout itself
// is started only from that page, via
// src/services/billingService.ts#startCheckout, so a customer who just
// completed (or canceled) a hosted Checkout session was, by construction,
// already in a web browser. Redirecting them to a custom URL scheme instead
// of back to that web page would either prompt an unwanted "open app?"
// dialog or fail outright on a device with the app not installed — the
// dangling behavior this comment used to warn about, just moved one step
// later instead of fixed. These now point back at that page's own https
// route, using the same placeholder-domain convention `getLinkDomain()` /
// `LINK_DOMAIN_PLACEHOLDER` already establishes in src/lib/deepLinks.ts
// (functions/ cannot import from the app's src/ tree, so this is the same
// literal value kept in sync by convention, not by a shared import) — update
// alongside that constant once a real domain is provisioned.
// `{CHECKOUT_SESSION_ID}` is a literal Stripe template token; Stripe
// substitutes it, this code does not. The `?checkout=success|cancel` query
// param is read by src/components/PricingBody.tsx to show an honest,
// non-committal banner — it does not claim the plan already changed, since
// that write happens asynchronously via the webhook (functions/src/http/
// stripeWebhook.ts), not via this redirect.
const CHECKOUT_REDIRECT_DOMAIN = "boardapp.example.com";
const CHECKOUT_SUCCESS_URL = `https://${CHECKOUT_REDIRECT_DOMAIN}/pricing?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
const CHECKOUT_CANCEL_URL = `https://${CHECKOUT_REDIRECT_DOMAIN}/pricing?checkout=cancel`;

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
  let session: { url: string | null };
  try {
    session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: params.workspaceId,
      metadata: { workspaceId: params.workspaceId, uid: params.uid },
      // Stripe does NOT copy the session's `metadata` onto the subscription it
      // creates, and `client_reference_id` exists only on the session. Without
      // this, every later `customer.subscription.*` and `invoice.*` event for
      // this customer would arrive with no way to tell which workspace it
      // belongs to — so the webhook could grant Pro at checkout but never
      // revoke it on a cancellation or a failed payment. See
      // WORKSPACE_ID_PATHS in functions/src/http/stripeWebhook.ts, which reads
      // this metadata back off the subscription and off the snapshot of it
      // that Stripe puts on each invoice.
      subscription_data: { metadata: { workspaceId: params.workspaceId, uid: params.uid } },
      success_url: CHECKOUT_SUCCESS_URL,
      cancel_url: CHECKOUT_CANCEL_URL,
    });
  } catch (err) {
    // A malformed session request — an archived price, a one-time price used
    // with mode: "subscription", a live/test key mismatch — is a server-side
    // configuration problem, not something the caller did wrong, and not
    // something worth exposing (Stripe's raw message can name the price id
    // or key mode). Map it to one caller-safe, non-leaking message; anything
    // else (network errors, rate limits, ...) propagates unchanged, which
    // firebase-functions scrubs to a bare `internal` for the caller.
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      throw new HttpsError(
        "failed-precondition",
        "Checkout is temporarily unavailable. Please try again later."
      );
    }
    throw err;
  }

  if (!session.url) {
    throw new HttpsError("internal", "Stripe did not return a checkout URL.");
  }
  return { url: session.url };
}
