import type { StripeWebhookEvent } from "../../http/stripeWebhook";

// Hand-built Stripe webhook event fixtures for functions/src/__tests__/
// stripeWebhook.test.ts. There is no Stripe account behind this repo yet — no
// product, no price, no registered webhook endpoint — so no delivery from
// Stripe's servers has ever been observed. These objects are therefore
// reconstructed from the installed `stripe` package's own TypeScript types
// (node_modules/stripe/cjs/resources/...) for the API version pinned in
// functions/src/billing/stripe.ts (2026-08-26.dahlia), not captured from a
// real delivery. Field names and nesting are accurate for that version; the
// objects are deliberately MINIMAL subsets, not complete Stripe objects (a
// real Checkout Session carries ~80 fields), which is why they are typed
// against the handler's tolerant `StripeWebhookEvent` shape rather than
// `Stripe.Event`.
//
// Two version-sensitive shapes are worth calling out, because getting either
// wrong would silently read `undefined` in production:
//
//   - `Subscription.current_period_end` no longer exists at the top level in
//     this API version; the period end lives on each subscription ITEM
//     (`items.data[].current_period_end` — see SubscriptionItems.d.ts). The
//     `subscriptionActive*` fixtures use the item shape; `subscriptionLegacyShape`
//     keeps the old top-level field so the reader's fallback branch is covered.
//   - `Invoice.subscription` no longer exists either; an invoice points at its
//     subscription (and carries a snapshot of that subscription's metadata)
//     through `parent.subscription_details` — see Invoices.d.ts, where
//     `Parent.SubscriptionDetails.metadata` is documented as "an immutable
//     snapshot of the subscription metadata at the time of invoice
//     finalization". That snapshot is the ONLY place an invoice event carries
//     the workspace id, which is why the Checkout Session sets
//     `subscription_data.metadata` (functions/src/billing/stripe.ts).
//
// `customer_details.email` is present on the checkout fixture on purpose: it
// is what a real delivery contains, and one test asserts that no log line
// this webhook writes ever contains it.

/** The envelope fields every Stripe event carries, beyond the three the
 *  handler actually reads. Present so the fixtures are event-shaped rather
 *  than three-field stubs; `StripeWebhookEvent` itself stays narrow so the
 *  handler cannot quietly grow a dependency on them. */
interface TestStripeEvent extends StripeWebhookEvent {
  object: "event";
  api_version: string;
  created: number;
  livemode: boolean;
  pending_webhooks: number;
  request: { id: string | null; idempotency_key: string | null };
}

const API_VERSION = "2026-08-26.dahlia";
const CREATED = 1789999999;

/** Unix SECONDS, as Stripe sends it. The handler stores milliseconds, so the
 *  expected persisted value is this × 1000 — a test asserts exactly that, so a
 *  regression that stored raw seconds (a ~55,000× understatement of the
 *  renewal date) would go red. */
export const PERIOD_END_UNIX = 1790000000;
export const PERIOD_END_MS = PERIOD_END_UNIX * 1000;

/** The email on the checkout fixture. Exported so the "never logged" test
 *  asserts against the same literal the fixture carries, instead of a copy
 *  that could drift out of sync and make the assertion vacuous. */
export const CUSTOMER_EMAIL = "paying.customer@example.com";
export const CUSTOMER_ID = "cus_TestCustomer123";
export const SUBSCRIPTION_ID = "sub_TestSubscription123";

function envelope(id: string, type: string, object: unknown): TestStripeEvent {
  return {
    id,
    object: "event",
    api_version: API_VERSION,
    created: CREATED,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

// ── checkout.session.completed ────────────────────────────────────────────────

/** The happy path: a subscription Checkout Session that is complete AND paid.
 *  Carries both `client_reference_id` and `metadata.workspaceId` because
 *  createCheckoutSession sets both. */
export const checkoutCompleted = envelope("evt_checkout_completed_1", "checkout.session.completed", {
  id: "cs_test_CheckoutSession123",
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  client_reference_id: "ws1",
  metadata: { workspaceId: "ws1", uid: "u1" },
  customer: CUSTOMER_ID,
  customer_details: { email: CUSTOMER_EMAIL, name: "A Paying Customer" },
  subscription: SUBSCRIPTION_ID,
  currency: "usd",
  amount_total: 900,
});

/** Same session, `metadata` only — proves the workspace id is resolved from
 *  `metadata.workspaceId` and not solely from `client_reference_id`. */
export const checkoutCompletedMetadataOnly = envelope(
  "evt_checkout_completed_2",
  "checkout.session.completed",
  {
    id: "cs_test_CheckoutSession456",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    client_reference_id: null,
    metadata: { workspaceId: "ws1", uid: "u1" },
    customer: CUSTOMER_ID,
    subscription: SUBSCRIPTION_ID,
  }
);

/** A completed session whose payment has NOT cleared. Real: this is what an
 *  asynchronous payment method (a delayed bank debit) produces — the session
 *  completes, the money has not arrived. Granting Pro here would hand out the
 *  paid tier for an unsettled payment. */
export const checkoutCompletedUnpaid = envelope(
  "evt_checkout_completed_unpaid",
  "checkout.session.completed",
  {
    id: "cs_test_CheckoutSession789",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "unpaid",
    client_reference_id: "ws1",
    metadata: { workspaceId: "ws1", uid: "u1" },
    customer: CUSTOMER_ID,
    subscription: SUBSCRIPTION_ID,
  }
);

/** A trial-started session: no money is due yet, but the subscription IS
 *  active, so this legitimately grants Pro. */
export const checkoutCompletedNoPaymentRequired = envelope(
  "evt_checkout_completed_trial",
  "checkout.session.completed",
  {
    id: "cs_test_CheckoutSessionTrial",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "no_payment_required",
    client_reference_id: "ws1",
    metadata: { workspaceId: "ws1", uid: "u1" },
    customer: CUSTOMER_ID,
    subscription: SUBSCRIPTION_ID,
  }
);

/** A completed ONE-TIME payment session. createCheckoutSession hard-codes
 *  `mode: "subscription"`, so this app produces none today — it stands for a
 *  future one-off purchase, which must not confer a recurring plan. */
export const checkoutCompletedPaymentMode = envelope(
  "evt_checkout_payment_mode",
  "checkout.session.completed",
  {
    id: "cs_test_CheckoutSessionOneOff",
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    client_reference_id: "ws1",
    metadata: { workspaceId: "ws1", uid: "u1" },
    customer: CUSTOMER_ID,
    subscription: null,
  }
);

/** A session with no workspace id anywhere. Should never happen —
 *  createCheckoutSession always sets both fields — so this stands for a bug
 *  or a session created outside this app (e.g. by hand in the Dashboard). */
export const checkoutCompletedNoWorkspace = envelope(
  "evt_checkout_no_workspace",
  "checkout.session.completed",
  {
    id: "cs_test_CheckoutSessionOrphan",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    client_reference_id: null,
    metadata: {},
    customer: CUSTOMER_ID,
    subscription: SUBSCRIPTION_ID,
  }
);

/** A workspace id shaped like a path. Signature verification means this can
 *  only ever come from Stripe, but the value is interpolated into a Firestore
 *  document path, so the handler validates it rather than trusting it. */
export const checkoutCompletedPathyWorkspace = envelope(
  "evt_checkout_pathy",
  "checkout.session.completed",
  {
    id: "cs_test_CheckoutSessionPathy",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    client_reference_id: "ws1/../../admin",
    metadata: {},
    customer: CUSTOMER_ID,
    subscription: SUBSCRIPTION_ID,
  }
);

// ── customer.subscription.updated / .deleted ──────────────────────────────────

function subscriptionObject(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: SUBSCRIPTION_ID,
    object: "subscription",
    status,
    customer: CUSTOMER_ID,
    // The workspace id reaches subscription events only through the
    // subscription's own metadata, which the Checkout Session seeds via
    // `subscription_data.metadata`. Session-level metadata is NOT copied onto
    // the subscription by Stripe.
    metadata: { workspaceId: "ws1", uid: "u1" },
    cancel_at_period_end: false,
    items: {
      object: "list",
      data: [
        {
          id: "si_TestItem123",
          object: "subscription_item",
          current_period_start: PERIOD_END_UNIX - 30 * 24 * 60 * 60,
          current_period_end: PERIOD_END_UNIX,
          price: { id: "price_TestPro", object: "price", recurring: { interval: "month" } },
          quantity: 1,
        },
      ],
    },
    ...extra,
  };
}

export const subscriptionActive = envelope(
  "evt_subscription_active",
  "customer.subscription.updated",
  subscriptionObject("active")
);

/** A subscription born `active` — what creating one through the API or the
 *  Stripe Dashboard produces, rather than this app's Checkout flow. It fires
 *  `created` and then nothing until its state next changes, so an endpoint
 *  that only listened for `updated` would never grant Pro for it. */
export const subscriptionCreatedActive = envelope(
  "evt_subscription_created",
  "customer.subscription.created",
  subscriptionObject("active")
);

export const subscriptionTrialing = envelope(
  "evt_subscription_trialing",
  "customer.subscription.updated",
  subscriptionObject("trialing")
);

export const subscriptionPastDue = envelope(
  "evt_subscription_past_due",
  "customer.subscription.updated",
  subscriptionObject("past_due")
);

export const subscriptionIncomplete = envelope(
  "evt_subscription_incomplete",
  "customer.subscription.updated",
  subscriptionObject("incomplete")
);

export const subscriptionCanceled = envelope(
  "evt_subscription_canceled",
  "customer.subscription.updated",
  subscriptionObject("canceled", { canceled_at: CREATED })
);

export const subscriptionUnpaid = envelope(
  "evt_subscription_unpaid",
  "customer.subscription.updated",
  subscriptionObject("unpaid")
);

export const subscriptionIncompleteExpired = envelope(
  "evt_subscription_incomplete_expired",
  "customer.subscription.updated",
  subscriptionObject("incomplete_expired")
);

export const subscriptionPaused = envelope(
  "evt_subscription_paused",
  "customer.subscription.updated",
  subscriptionObject("paused")
);

/** A status string this code has never seen. Stripe adds enum members over
 *  time (the SDK types them as a union with an `OtherString` escape hatch), so
 *  this is not hypothetical. */
export const subscriptionUnknownStatus = envelope(
  "evt_subscription_unknown_status",
  "customer.subscription.updated",
  subscriptionObject("some_future_status")
);

export const subscriptionDeleted = envelope(
  "evt_subscription_deleted",
  "customer.subscription.deleted",
  subscriptionObject("canceled", { canceled_at: CREATED, ended_at: CREATED })
);

/** The pre-2025-06-30 subscription shape, with the period end at the top
 *  level instead of on the items. Kept so the reader's fallback branch is
 *  exercised: an event replayed from Stripe's event log carries the shape of
 *  the API version it was created under, not the version pinned today. */
export const subscriptionLegacyShape = envelope(
  "evt_subscription_legacy_shape",
  "customer.subscription.updated",
  {
    id: SUBSCRIPTION_ID,
    object: "subscription",
    status: "active",
    customer: CUSTOMER_ID,
    metadata: { workspaceId: "ws1", uid: "u1" },
    current_period_end: PERIOD_END_UNIX,
  }
);

// ── invoice.payment_failed ────────────────────────────────────────────────────

function invoiceObject(nextPaymentAttempt: number | null) {
  return {
    id: "in_TestInvoice123",
    object: "invoice",
    status: "open",
    attempt_count: nextPaymentAttempt === null ? 4 : 1,
    // null once Stripe has exhausted its retry schedule ("smart retries").
    // That, not the first failure, is the terminal signal.
    next_payment_attempt: nextPaymentAttempt,
    customer: CUSTOMER_ID,
    // Invoices carry no `client_reference_id` and their own `metadata` is
    // empty unless set explicitly; the workspace id arrives in the
    // subscription-metadata snapshot under `parent`.
    metadata: {},
    parent: {
      type: "subscription_details",
      quote_details: null,
      subscription_details: {
        subscription: SUBSCRIPTION_ID,
        metadata: { workspaceId: "ws1", uid: "u1" },
      },
    },
    period_end: PERIOD_END_UNIX,
    amount_due: 900,
    currency: "usd",
  };
}

/** A failed payment with another attempt scheduled. Stripe has the
 *  subscription at `past_due` here; the customer keeps Pro. */
export const invoicePaymentFailedRetrying = envelope(
  "evt_invoice_payment_failed_retrying",
  "invoice.payment_failed",
  invoiceObject(PERIOD_END_UNIX + 3 * 24 * 60 * 60)
);

/** The terminal failure: no further attempt scheduled, so the payment is not
 *  coming. This is a downgrade. */
export const invoicePaymentFailedFinal = envelope(
  "evt_invoice_payment_failed_final",
  "invoice.payment_failed",
  invoiceObject(null)
);

/** A failed one-off invoice — no subscription anywhere on it. Nothing this
 *  app creates produces one, but an invoice raised by hand in the Stripe
 *  Dashboard would, and it says nothing about any workspace's plan. */
export const invoiceOneOffPaymentFailed = envelope(
  "evt_invoice_one_off_failed",
  "invoice.payment_failed",
  {
    id: "in_TestOneOffInvoice",
    object: "invoice",
    status: "open",
    next_payment_attempt: null,
    customer: CUSTOMER_ID,
    metadata: {},
    parent: null,
  }
);

/** The pre-2025-03-31 invoice shape, whose subscription metadata sat at
 *  `subscription_details` rather than under `parent`. Same replay reasoning as
 *  `subscriptionLegacyShape`. */
export const invoicePaymentFailedLegacyShape = envelope(
  "evt_invoice_payment_failed_legacy",
  "invoice.payment_failed",
  {
    id: "in_TestInvoiceLegacy",
    object: "invoice",
    status: "open",
    next_payment_attempt: null,
    customer: CUSTOMER_ID,
    subscription: SUBSCRIPTION_ID,
    subscription_details: { metadata: { workspaceId: "ws1", uid: "u1" } },
  }
);

// ── an event type this webhook does not handle ────────────────────────────────

/** Stripe sends whatever the endpoint is subscribed to, plus anything added to
 *  that subscription later. An event this code has no opinion on must be
 *  acknowledged, not retried forever. */
export const unhandledEvent = envelope("evt_unhandled_customer_created", "customer.created", {
  id: CUSTOMER_ID,
  object: "customer",
  email: CUSTOMER_EMAIL,
});
