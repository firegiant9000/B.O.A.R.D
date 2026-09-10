import { logger } from "firebase-functions/v2";
import { stripeClient } from "../billing/stripe";
import type { Plan } from "../billing/limits";
import {
  applyStripeEvent,
  applyStripeEventTransactionally,
  decidePlanWrite,
  handleStripeWebhook,
  StripeWebhookPayloadError,
  UnknownWorkspaceError,
  type ProcessedEventRecord,
  type StripeWebhookDeps,
  type StripeWebhookEvent,
  type SubscriptionState,
} from "../http/stripeWebhook";
import * as fx from "./fixtures/stripe-events";

// Month 5 — the Stripe webhook. There is no Stripe account behind this repo:
// no API key, no product, no price and no registered webhook endpoint, so no
// delivery from Stripe's servers has ever reached this code. Two things follow
// for these tests:
//
//   1. Signature verification is tested for real, not mocked past. The
//      installed `stripe` package exposes `webhooks.generateTestHeaderString`
//      specifically so a payload can be signed locally with the same HMAC
//      construction Stripe uses, so the production `constructEvent` call runs
//      against genuinely signed bytes here. Only the *delivery* is simulated.
//   2. The event payloads are reconstructed from the SDK's types rather than
//      captured (see fixtures/stripe-events.ts).

const T = Date.UTC(2026, 8, 10, 12, 0, 0);

// Not a real key, and never used as one: `stripe.webhooks` is a pure
// HMAC helper that makes no API call, so the constructor argument is
// irrelevant to everything below. Signature verification uses the WEBHOOK
// signing secret, not the API key.
const testStripe = stripeClient("sk_test_thisIsNotARealKeyAndIsNeverSent");
const WEBHOOK_SECRET = "whsec_testSigningSecretForUnitTestsOnly";

function sign(payload: string, opts: { secret?: string; timestamp?: number } = {}): string {
  return testStripe.webhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? WEBHOOK_SECRET,
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
  });
}

/** In-memory store honouring the same contract as the Firestore-backed one:
 *  every write is READ BACK by the corresponding reader, so the tests below
 *  exercise the handler's real short-circuits rather than a hard-coded mock
 *  answer. Three of those loops matter:
 *
 *  - `markProcessed` is what makes a later `alreadyProcessed` true (replay).
 *  - `setSubscription` is what makes a later `readSubscription` return a
 *    `lastEventCreated` and a `currentPeriodEndMs` (out-of-order guard, and
 *    the period-end carry-forward).
 *  - `setPlan` actually mutates the stored plan, so a second event sees the
 *    plan the first one wrote. Without that, an out-of-order test would pass
 *    for the wrong reason: `decidePlanWrite` would skip the second write as
 *    redundant and the guard itself would never be exercised. */
function store(opts: { plan?: unknown; missingWorkspace?: boolean } = {}) {
  const seen = new Set<string>();
  const workspace: { plan?: unknown } | null = opts.missingWorkspace
    ? null
    : { plan: opts.plan ?? "free" };
  let subscription: { lastEventCreated?: unknown; currentPeriodEndMs?: unknown } | null = null;
  return {
    seen,
    readWorkspace: jest.fn(async (_workspaceId: string) => workspace),
    readSubscription: jest.fn(async (_workspaceId: string) => subscription),
    alreadyProcessed: jest.fn(async (_workspaceId: string, eventId: string) => seen.has(eventId)),
    setPlan: jest.fn(async (_workspaceId: string, plan: Plan) => {
      if (workspace !== null) workspace.plan = plan;
    }),
    setSubscription: jest.fn(async (_workspaceId: string, state: SubscriptionState) => {
      subscription = { ...state };
    }),
    markProcessed: jest.fn(
      async (_workspaceId: string, eventId: string, _record: ProcessedEventRecord) => {
        seen.add(eventId);
      }
    ),
  };
}

// Every block below stubs the logger: the handler logs on the fail-closed and
// ignored paths, and unstubbed output would pollute the run. The
// "never logs" block asserts on these same spies.
let infoSpy: jest.SpiedFunction<typeof logger.info>;
let warnSpy: jest.SpiedFunction<typeof logger.warn>;
let errorSpy: jest.SpiedFunction<typeof logger.error>;

beforeEach(() => {
  infoSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined);
  warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Everything the logger saw this test, flattened to one string. */
function loggedText(): string {
  return [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
    .map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    .join("\n");
}

// ── applyStripeEvent: upgrades ────────────────────────────────────────────────

describe("applyStripeEvent — upgrades", () => {
  it("upgrades the workspace on checkout completion", async () => {
    const s = store();
    await applyStripeEvent(fx.checkoutCompleted, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "pro");
  });

  it("records the subscription state from the checkout session", async () => {
    const s = store();
    await applyStripeEvent(fx.checkoutCompleted, s, T);
    expect(s.setSubscription).toHaveBeenCalledWith("ws1", {
      schemaVersion: 1,
      status: "active",
      statusSource: "checkout",
      stripeCustomerId: fx.CUSTOMER_ID,
      stripeSubscriptionId: fx.SUBSCRIPTION_ID,
      // A Checkout Session carries no renewal date and this workspace has no
      // previously recorded one, so there is nothing to carry forward. The
      // carry-forward case has its own test below.
      currentPeriodEndMs: null,
      lastEventId: fx.checkoutCompleted.id,
      lastEventType: "checkout.session.completed",
      lastEventCreated: fx.checkoutCompleted.created,
      updatedAt: T,
    });
  });

  it("resolves the workspace from metadata.workspaceId when client_reference_id is absent", async () => {
    const s = store();
    await applyStripeEvent(fx.checkoutCompletedMetadataOnly, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "pro");
  });

  it("grants pro for a trial checkout (no_payment_required)", async () => {
    const s = store();
    await applyStripeEvent(fx.checkoutCompletedNoPaymentRequired, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "pro");
  });

  it("does NOT grant pro when the completed session's payment has not cleared", async () => {
    // A completed-but-unpaid session is what an async payment method produces.
    // Deny unless provably paid: the subscription state is still recorded, so
    // the later customer.subscription.updated -> active can grant Pro.
    const s = store();
    await applyStripeEvent(fx.checkoutCompletedUnpaid, s, T);
    expect(s.setPlan).not.toHaveBeenCalled();
    expect(s.setSubscription).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ status: "incomplete" })
    );
  });

  it("upgrades on customer.subscription.updated with status active", async () => {
    const s = store();
    await applyStripeEvent(fx.subscriptionActive, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "pro");
  });

  it("upgrades on customer.subscription.created that is already active", async () => {
    // A subscription created outside Checkout fires `created` and then nothing
    // until it next changes state, so ignoring this type would leave it
    // un-upgraded indefinitely.
    const s = store();
    await applyStripeEvent(fx.subscriptionCreatedActive, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "pro");
  });

  it("upgrades on a trialing subscription", async () => {
    const s = store();
    await applyStripeEvent(fx.subscriptionTrialing, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "pro");
  });

  it("stores the period end in MILLISECONDS from the subscription item (current API shape)", async () => {
    const s = store();
    await applyStripeEvent(fx.subscriptionActive, s, T);
    expect(s.setSubscription).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ currentPeriodEndMs: fx.PERIOD_END_MS })
    );
  });

  it("falls back to the legacy top-level current_period_end", async () => {
    // A replayed event carries the shape of the API version it was created
    // under, so both shapes have to read.
    const s = store();
    await applyStripeEvent(fx.subscriptionLegacyShape, s, T);
    expect(s.setSubscription).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ currentPeriodEndMs: fx.PERIOD_END_MS })
    );
  });

  it("carries a recorded period end forward across an event that carries none", async () => {
    // `setSubscription` writes the whole document, and only a subscription
    // object carries a renewal date — an Invoice and a Checkout Session do
    // not. Without the carry-forward, every invoice.payment_failed and every
    // checkout.session.completed would null a renewal date a previous
    // subscription event had recorded, and a billing screen would show a blank
    // renewal date precisely when the customer's payment had just failed.
    const s = store({ plan: "pro" });

    await applyStripeEvent(fx.subscriptionActive, s, T);
    expect(s.setSubscription).toHaveBeenLastCalledWith(
      "ws1",
      expect.objectContaining({ currentPeriodEndMs: fx.PERIOD_END_MS })
    );

    await applyStripeEvent(fx.invoicePaymentFailedRetrying, s, T);
    expect(s.setSubscription).toHaveBeenLastCalledWith(
      "ws1",
      expect.objectContaining({
        statusSource: "invoice",
        currentPeriodEndMs: fx.PERIOD_END_MS,
      })
    );
  });

  it("does not rewrite plan when the workspace is already pro", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.subscriptionActive, s, T);
    expect(s.setPlan).not.toHaveBeenCalled();
    // Still records the fresh subscription state and still marks the event
    // processed — skipping a redundant plan write is not skipping the event.
    expect(s.setSubscription).toHaveBeenCalledTimes(1);
    expect(s.markProcessed).toHaveBeenCalledTimes(1);
  });
});

// ── applyStripeEvent: downgrades ──────────────────────────────────────────────

describe("applyStripeEvent — downgrades", () => {
  it("downgrades on subscription deletion", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.subscriptionDeleted, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
  });

  it("downgrades on a canceled subscription", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.subscriptionCanceled, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
  });

  it("downgrades on an unpaid subscription (dunning exhausted)", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.subscriptionUnpaid, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
  });

  it("downgrades on incomplete_expired", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.subscriptionIncompleteExpired, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
  });

  it("downgrades on a paused subscription", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.subscriptionPaused, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
  });

  it("downgrades on a terminal invoice.payment_failed (no retry scheduled)", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.invoicePaymentFailedFinal, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
  });

  it("resolves the workspace from an invoice's parent.subscription_details.metadata", async () => {
    // An invoice has no client_reference_id and its own metadata is empty; the
    // workspace id only reaches it through the subscription-metadata snapshot.
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.invoicePaymentFailedFinal, s, T);
    expect(s.setSubscription).toHaveBeenCalledWith("ws1", expect.objectContaining({ status: "unpaid" }));
  });

  it("resolves the workspace from the legacy invoice subscription_details shape", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.invoicePaymentFailedLegacyShape, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
  });

  it("normalizes a garbage stored plan to free on a downgrade", async () => {
    const s = store({ plan: "some-future-plan" });
    await applyStripeEvent(fx.subscriptionDeleted, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
  });

  it("does not write plan on a downgrade for a workspace already on free", async () => {
    const s = store({ plan: "free" });
    await applyStripeEvent(fx.subscriptionDeleted, s, T);
    expect(s.setPlan).not.toHaveBeenCalled();
    expect(s.markProcessed).toHaveBeenCalledTimes(1);
  });
});

// ── applyStripeEvent: grace, edu, and unknown statuses ────────────────────────

describe("applyStripeEvent — no-plan-change paths", () => {
  it("keeps pro while past_due (grace, not instant downgrade)", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.subscriptionPastDue, s, T);
    expect(s.setPlan).not.toHaveBeenCalledWith("ws1", "free");
    expect(s.setSubscription).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ status: "past_due" })
    );
  });

  it("keeps pro on a payment failure that still has a retry scheduled", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.invoicePaymentFailedRetrying, s, T);
    expect(s.setPlan).not.toHaveBeenCalled();
    expect(s.setSubscription).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ status: "past_due", statusSource: "invoice" })
    );
  });

  it("keeps pro while a first payment is incomplete", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.subscriptionIncomplete, s, T);
    expect(s.setPlan).not.toHaveBeenCalled();
  });

  it("makes no plan change on a status it does not recognize, and says so in a log", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.subscriptionUnknownStatus, s, T);
    expect(s.setPlan).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, meta] = warnSpy.mock.calls[0];
    expect(meta).toMatchObject({ status: "some_future_status" });
  });

  it("never downgrades an edu workspace off a Stripe cancellation", async () => {
    // `edu` is granted out of band, not by Stripe. A Stripe subscription
    // ending says nothing about an edu grant, so this webhook must leave it
    // alone rather than revoke a plan it never issued.
    const s = store({ plan: "edu" });
    await applyStripeEvent(fx.subscriptionDeleted, s, T);
    expect(s.setPlan).not.toHaveBeenCalled();
  });

  it("never overwrites an edu workspace with pro on a checkout", async () => {
    const s = store({ plan: "edu" });
    await applyStripeEvent(fx.checkoutCompleted, s, T);
    expect(s.setPlan).not.toHaveBeenCalled();
  });
});

// ── applyStripeEvent: idempotency ─────────────────────────────────────────────

describe("applyStripeEvent — idempotency", () => {
  it("is idempotent on a replayed event", async () => {
    const s = store();
    await applyStripeEvent(fx.checkoutCompleted, s, T);
    await applyStripeEvent(fx.checkoutCompleted, s, T);
    expect(s.setPlan).toHaveBeenCalledTimes(1);
    expect(s.setSubscription).toHaveBeenCalledTimes(1);
    expect(s.markProcessed).toHaveBeenCalledTimes(1);
  });

  it("reports the replay as a duplicate rather than as applied", async () => {
    const s = store();
    await expect(applyStripeEvent(fx.checkoutCompleted, s, T)).resolves.toMatchObject({
      outcome: "applied",
    });
    await expect(applyStripeEvent(fx.checkoutCompleted, s, T)).resolves.toMatchObject({
      outcome: "duplicate",
    });
  });

  it("records the event id it processed, so the replay above has something to match", async () => {
    const s = store();
    await applyStripeEvent(fx.checkoutCompleted, s, T);
    expect(s.markProcessed).toHaveBeenCalledWith("ws1", fx.checkoutCompleted.id, {
      schemaVersion: 1,
      eventId: fx.checkoutCompleted.id,
      eventType: "checkout.session.completed",
      planWritten: "pro",
      processedAt: T,
    });
  });

  it("does NOT dedupe two genuinely different events for the same workspace", async () => {
    // Deduping is per event id: a redelivery is suppressed, two distinct
    // checkouts are not. Reconciling duplicate subscriptions is a separate
    // problem and deliberately not attempted here.
    const s = store();
    await applyStripeEvent(fx.checkoutCompleted, s, T);
    await applyStripeEvent(fx.checkoutCompletedMetadataOnly, s, T);
    expect(s.setSubscription).toHaveBeenCalledTimes(2);
  });
});

// ── applyStripeEvent: out-of-order deliveries ─────────────────────────────────
//
// A DIFFERENT mechanism from idempotency above, guarding a different failure.
// Idempotency suppresses a redelivery of one event id; this suppresses a
// genuinely different, genuinely older event that lost a race. Nothing keyed on
// `event.id` could catch these — the events have different ids, so neither is a
// duplicate of the other.

describe("applyStripeEvent — out-of-order deliveries", () => {
  it("ignores an event older than the state already applied, restoring nothing", async () => {
    // The permanent defect this guards: `updated{active}` fails on a Firestore
    // blip, `deleted` is delivered and applies (plan -> free), then the
    // `active` retry finally succeeds. Applied, it would put the workspace
    // back on Pro for a subscription that no longer exists — and Stripe has
    // nothing further to send about a deleted subscription, so no later event
    // would ever correct it.
    const s = store({ plan: "pro" });

    await applyStripeEvent(fx.subscriptionDeletedLate, s, T);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
    s.setPlan.mockClear();

    const res = await applyStripeEvent(fx.subscriptionActiveEarly, s, T);

    expect(res.outcome).toBe("stale");
    expect(s.setPlan).not.toHaveBeenCalled();
    // The stale delivery writes NOTHING: rewriting the subscription document
    // would replace the cancellation's state with the older event's.
    expect(s.setSubscription).toHaveBeenCalledTimes(1);
    expect(s.markProcessed).toHaveBeenCalledTimes(1);
  });

  it("applies an event newer than the state already applied", async () => {
    // The other direction, which a guard with its comparison the wrong way
    // round would break: the cancellation must still land after the upgrade.
    const s = store({ plan: "pro" });

    await applyStripeEvent(fx.subscriptionActiveEarly, s, T);
    const res = await applyStripeEvent(fx.subscriptionDeletedLate, s, T);

    expect(res.outcome).toBe("applied");
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
    expect(s.setSubscription).toHaveBeenCalledTimes(2);
  });

  it("applies an event stamped in the SAME second — a tie is not a drop", async () => {
    // Strictly-newer-wins. `created` has one-second resolution, so two events
    // of one checkout routinely tie; a `>=` comparison here would silently
    // discard a legitimate event, which is the worse of the two errors.
    const s = store({ plan: "pro" });

    await applyStripeEvent(fx.subscriptionActiveEarly, s, T);
    const res = await applyStripeEvent(fx.subscriptionDeletedSameSecond, s, T);

    expect(res.outcome).toBe("applied");
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
  });

  it("records event.created, which is the only thing a later delivery can be ordered against", async () => {
    const s = store();
    await applyStripeEvent(fx.subscriptionActiveEarly, s, T);
    expect(s.setSubscription).toHaveBeenCalledWith(
      "ws1",
      // Unix SECONDS, stored exactly as Stripe sent it, so the comparison
      // against an incoming `event.created` needs no conversion.
      expect.objectContaining({ lastEventCreated: fx.CREATED_EARLY })
    );
  });

  it("logs the stale delivery with a hashed workspace id and both timestamps", async () => {
    const s = store({ plan: "pro" });
    await applyStripeEvent(fx.subscriptionDeletedLate, s, T);
    warnSpy.mockClear();

    await applyStripeEvent(fx.subscriptionActiveEarly, s, T);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toMatchObject({
      eventCreated: fx.CREATED_EARLY,
      appliedCreated: fx.CREATED_LATE,
    });
    expect(meta.workspaceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(meta)).not.toContain('"ws1"');
  });
});

// ── applyStripeEvent: unhandled types and fail-closed paths ───────────────────

describe("applyStripeEvent — unhandled and malformed", () => {
  it("ignores an event type it does not handle, without touching the store at all", async () => {
    // Also pins that the TYPE check comes first, and that an unhandled type
    // needs no workspace id: `customer.created` legitimately carries none, and
    // demanding one would turn every unrelated event into an error.
    const s = store();
    await expect(applyStripeEvent(fx.unhandledEvent, s, T)).resolves.toMatchObject({
      outcome: "ignored",
    });
    expect(s.setPlan).not.toHaveBeenCalled();
    expect(s.setSubscription).not.toHaveBeenCalled();
    expect(s.markProcessed).not.toHaveBeenCalled();
    expect(s.readWorkspace).not.toHaveBeenCalled();
    expect(s.readSubscription).not.toHaveBeenCalled();
    expect(s.alreadyProcessed).not.toHaveBeenCalled();
  });

  it("throws when the event carries no workspace id", async () => {
    const s = store();
    await expect(applyStripeEvent(fx.checkoutCompletedNoWorkspace, s, T)).rejects.toThrow(
      /workspace/i
    );
    expect(s.setPlan).not.toHaveBeenCalled();
    expect(s.setSubscription).not.toHaveBeenCalled();
    expect(s.markProcessed).not.toHaveBeenCalled();
  });

  it("throws on a path-shaped workspace id instead of interpolating it into a document path", async () => {
    const s = store();
    await expect(applyStripeEvent(fx.checkoutCompletedPathyWorkspace, s, T)).rejects.toThrow(
      /workspace/i
    );
    expect(s.readWorkspace).not.toHaveBeenCalled();
  });

  it("throws on a malformed event id instead of using it as a document id", async () => {
    const bad: StripeWebhookEvent = {
      ...fx.checkoutCompleted,
      id: "evt/../../workspaces",
    };
    const s = store();
    await expect(applyStripeEvent(bad, s, T)).rejects.toThrow(/event id/i);
    expect(s.setPlan).not.toHaveBeenCalled();
  });

  it("throws for an event whose workspace does not exist, writing nothing", async () => {
    const s = store({ missingWorkspace: true });
    await expect(applyStripeEvent(fx.checkoutCompleted, s, T)).rejects.toThrow(/workspace/i);
    expect(s.setPlan).not.toHaveBeenCalled();
    expect(s.setSubscription).not.toHaveBeenCalled();
    expect(s.markProcessed).not.toHaveBeenCalled();
  });

  it("does not grant a recurring plan for a completed ONE-TIME payment session", async () => {
    // Deny unless provably a subscription checkout. Nothing creates a
    // payment-mode session today, so this pins the fail direction ahead of the
    // first one-off purchase rather than after it has handed out free Pro.
    const s = store();
    await expect(applyStripeEvent(fx.checkoutCompletedPaymentMode, s, T)).resolves.toMatchObject({
      outcome: "ignored",
    });
    expect(s.setPlan).not.toHaveBeenCalled();
    expect(s.setSubscription).not.toHaveBeenCalled();
  });

  it("acknowledges a failed one-off invoice rather than retrying it forever", async () => {
    // No subscription on it, so it is provably not about a workspace's plan.
    // Throwing here would mean days of retries over an event this endpoint
    // will never act on.
    const s = store();
    await expect(applyStripeEvent(fx.invoiceOneOffPaymentFailed, s, T)).resolves.toMatchObject({
      outcome: "ignored",
    });
    expect(s.setPlan).not.toHaveBeenCalled();
    expect(s.setSubscription).not.toHaveBeenCalled();
  });

  it("still throws for a subscription invoice that has lost its workspace id", async () => {
    // The narrow half of the rule above: an invoice that DOES name a
    // subscription but carries no workspace id is an anomaly that must fail
    // loudly, not be quietly acknowledged — quietly acknowledging it would
    // drop a downgrade.
    const s = store();
    const bad: StripeWebhookEvent = {
      id: "evt_invoice_no_workspace",
      type: "invoice.payment_failed",
      created: fx.CREATED_EARLY,
      data: {
        object: {
          id: "in_TestInvoiceNoWorkspace",
          object: "invoice",
          next_payment_attempt: null,
          parent: {
            type: "subscription_details",
            subscription_details: { subscription: fx.SUBSCRIPTION_ID, metadata: {} },
          },
        },
      },
    };
    await expect(applyStripeEvent(bad, s, T)).rejects.toThrow(/workspace/i);
  });

  it("throws when a handled event's data.object is not an object", async () => {
    const s = store();
    const bad: StripeWebhookEvent = {
      id: "evt_malformed_payload",
      type: "customer.subscription.updated",
      created: fx.CREATED_EARLY,
      data: { object: "not-an-object" },
    };
    await expect(applyStripeEvent(bad, s, T)).rejects.toThrow(/workspace/i);
  });
});

// ── decidePlanWrite (pure) ────────────────────────────────────────────────────

describe("decidePlanWrite", () => {
  it("writes pro for a free workspace being upgraded", () => {
    expect(decidePlanWrite("free", "pro")).toBe("pro");
  });

  it("writes pro when the stored plan field is missing entirely", () => {
    expect(decidePlanWrite(undefined, "pro")).toBe("pro");
  });

  it("skips a redundant pro write", () => {
    expect(decidePlanWrite("pro", "pro")).toBeUndefined();
  });

  it("writes free for a pro workspace being downgraded", () => {
    expect(decidePlanWrite("pro", "free")).toBe("free");
  });

  it("skips a redundant free write", () => {
    expect(decidePlanWrite("free", "free")).toBeUndefined();
    expect(decidePlanWrite(undefined, "free")).toBeUndefined();
  });

  it("leaves edu alone in both directions", () => {
    expect(decidePlanWrite("edu", "pro")).toBeUndefined();
    expect(decidePlanWrite("edu", "free")).toBeUndefined();
  });

  it("writes nothing when the decision is unchanged, whatever the stored plan", () => {
    expect(decidePlanWrite("free", "unchanged")).toBeUndefined();
    expect(decidePlanWrite("pro", "unchanged")).toBeUndefined();
    expect(decidePlanWrite("edu", "unchanged")).toBeUndefined();
    expect(decidePlanWrite(undefined, "unchanged")).toBeUndefined();
  });

  it("is not fooled by a prototype-shaped stored plan", () => {
    // `PLAN_LIMITS["__proto__"]` is Object.prototype, so anything that looked
    // the stored plan up in an object literal could read a truthy value for a
    // plan that does not exist. These comparisons are string equality only.
    expect(decidePlanWrite("__proto__", "pro")).toBe("pro");
    expect(decidePlanWrite("__proto__", "free")).toBe("free");
  });

  it("treats a non-string stored plan as not-provably-anything", () => {
    expect(decidePlanWrite(42, "pro")).toBe("pro");
    expect(decidePlanWrite(null, "free")).toBeUndefined();
  });
});

// ── handleStripeWebhook: signature verification ───────────────────────────────

function jsonEvent(event: StripeWebhookEvent): string {
  return JSON.stringify(event);
}

function reqFor(
  rawBody: Buffer | undefined,
  signature: string | string[] | undefined,
  method = "POST"
) {
  const headers: Record<string, string | string[] | undefined> = {
    "content-type": "application/json",
  };
  if (signature !== undefined) headers["stripe-signature"] = signature;
  return { method, headers, rawBody };
}

function deps(overrides: Partial<StripeWebhookDeps> = {}): StripeWebhookDeps & {
  apply: jest.Mock;
} {
  const apply = jest.fn(async (_event: StripeWebhookEvent, _now: number) => ({
    outcome: "applied" as const,
  }));
  return {
    webhookSecret: WEBHOOK_SECRET,
    verifier: testStripe.webhooks,
    apply,
    ...overrides,
  } as StripeWebhookDeps & { apply: jest.Mock };
}

describe("handleStripeWebhook — signature verification", () => {
  it("accepts a genuinely signed delivery and applies the event", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const raw = Buffer.from(payload, "utf8");
    const d = deps();

    const res = await handleStripeWebhook(reqFor(raw, sign(payload)), d, T);

    expect(res.status).toBe(200);
    expect(d.apply).toHaveBeenCalledTimes(1);
    expect(d.apply.mock.calls[0][0]).toMatchObject({
      id: fx.checkoutCompleted.id,
      type: "checkout.session.completed",
    });
  });

  it("verifies against the RAW bytes, not a re-stringified parsed body", async () => {
    // Functions v2 parses the body before the handler runs, and
    // JSON.stringify(req.body) does not reproduce the bytes Stripe signed —
    // whitespace and key order are lost. This payload is pretty-printed so a
    // regression to `req.body` could not possibly re-derive it, and the
    // signature is computed over these exact bytes.
    const payload = JSON.stringify(fx.subscriptionActive, null, 2);
    expect(payload).toContain("\n");
    const raw = Buffer.from(payload, "utf8");
    const d = deps();

    const res = await handleStripeWebhook(reqFor(raw, sign(payload)), d, T);

    expect(res.status).toBe(200);
    expect(d.apply).toHaveBeenCalledTimes(1);
  });

  it("takes the event from rawBody even when a parsed `body` disagrees with it", async () => {
    // Proves the event handed to `apply` is parsed from rawBody rather than
    // from the parsed body Functions attaches: only rawBody's event id can
    // appear, and the decoy body is signed by nothing.
    const payload = jsonEvent(fx.subscriptionDeleted);
    const raw = Buffer.from(payload, "utf8");
    const d = deps();
    const req = {
      ...reqFor(raw, sign(payload)),
      body: { ...fx.checkoutCompleted, id: "evt_from_the_parsed_body" },
    };

    const res = await handleStripeWebhook(req, d, T);

    expect(res.status).toBe(200);
    expect(d.apply.mock.calls[0][0].id).toBe(fx.subscriptionDeleted.id);
  });

  it("rejects a tampered payload with 400 and applies nothing", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const signature = sign(payload);
    const tampered = Buffer.from(payload.replace("ws1", "ws2"), "utf8");
    const d = deps();

    const res = await handleStripeWebhook(reqFor(tampered, signature), d, T);

    expect(res.status).toBe(400);
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const d = deps();

    const res = await handleStripeWebhook(
      reqFor(Buffer.from(payload, "utf8"), sign(payload, { secret: "whsec_someOtherSecret" })),
      d,
      T
    );

    expect(res.status).toBe(400);
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed but stale delivery (replay window enforced)", async () => {
    // Pins that the replay window is actually in force: the signature here is
    // genuine and would verify, and only the timestamp is old. `constructEvent`
    // supplies DEFAULT_TOLERANCE itself when the argument is omitted, so this
    // holds whether or not the call site passes one — but the low-level
    // `verifyHeader` entry point defaults to 0, which DISABLES the check, so a
    // change of entry point would go red here.
    const payload = jsonEvent(fx.checkoutCompleted);
    const staleTimestamp = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
    const d = deps();

    const res = await handleStripeWebhook(
      reqFor(Buffer.from(payload, "utf8"), sign(payload, { timestamp: staleTimestamp })),
      d,
      T
    );

    expect(res.status).toBe(400);
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("rejects a missing stripe-signature header", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const d = deps();
    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), undefined), d, T);
    expect(res.status).toBe(400);
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("rejects a stripe-signature header sent as an array", async () => {
    // Stripe never sends one, but express types allow it and the SDK throws on
    // an array rather than verifying — better a deliberate 400 than a throw.
    const payload = jsonEvent(fx.checkoutCompleted);
    const signature = sign(payload);
    const d = deps();
    const res = await handleStripeWebhook(
      reqFor(Buffer.from(payload, "utf8"), [signature, signature]),
      d,
      T
    );
    expect(res.status).toBe(400);
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("answers 500 and logs at ERROR when there is no raw body to verify", async () => {
    // Deliberately unlike the header check above, which is a 400. Stripe
    // always POSTs a body, so an absent `rawBody` cannot be the caller's
    // doing — it can only be the platform or runtime failing to attach the
    // unparsed bytes, i.e. ours. If that assumption is ever wrong it is wrong
    // for EVERY delivery, and a 400 logged at `warn` would be the worst
    // available pair: Stripe does not retry a 400, and nothing alerts on
    // `warn`. Every payment lost, silently.
    const d = deps();
    const res = await handleStripeWebhook(reqFor(undefined, "t=1,v1=deadbeef"), d, T);
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("rejects a non-POST request with 405 without verifying anything", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const d = deps();
    const res = await handleStripeWebhook(
      reqFor(Buffer.from(payload, "utf8"), sign(payload), "GET"),
      d,
      T
    );
    expect(res.status).toBe(405);
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("refuses to process anything when the webhook secret is not configured", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const constructEvent = jest.fn();
    const d = deps({
      webhookSecret: "",
      verifier: { DEFAULT_TOLERANCE: 300, constructEvent },
    });

    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), sign(payload)), d, T);

    expect(res.status).toBe(500);
    expect(constructEvent).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

// ── handleStripeWebhook — response contract ───────────────────────────────────

describe("handleStripeWebhook — response contract", () => {
  it("returns 200 for an event type it does not handle, so Stripe stops retrying", async () => {
    const payload = jsonEvent(fx.unhandledEvent);
    const d = deps({
      apply: jest.fn(async () => ({ outcome: "ignored" as const })),
    });
    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), sign(payload)), d, T);
    expect(res.status).toBe(200);
  });

  it("returns 200 for a redelivery that was short-circuited as a duplicate", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const d = deps({
      apply: jest.fn(async () => ({ outcome: "duplicate" as const })),
    });
    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), sign(payload)), d, T);
    expect(res.status).toBe(200);
  });

  it("returns 500 and logs at ERROR when a TRANSIENT failure stops the event applying", async () => {
    // A verified event we could not apply is money we owe the customer, and
    // here a retry genuinely is the fix. A 2xx would discard it silently; a
    // 5xx keeps Stripe's retry schedule working and surfaces the failure on
    // Stripe's own dashboard. ERROR, not `warn`, because that argument depends
    // on the failure being surfaced and GCP alerting policies fire on ERROR —
    // at `warn` the mechanism the argument relies on does not exist.
    const payload = jsonEvent(fx.checkoutCompleted);
    const d = deps({
      apply: jest.fn(async () => {
        throw new Error("firestore unavailable");
      }),
    });
    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), sign(payload)), d, T);
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][1]).toMatchObject({ retryRequested: true });
  });

  it("returns 200 for a payload no retry could ever make applicable, and logs it at ERROR", async () => {
    // Stripe DISABLES an endpoint after a sustained run of consecutive
    // failures. Retrying an event whose bytes can never be acted on therefore
    // does worse than nothing: its tail is the endpoint going dark, which
    // costs every LATER event too — cancellations included. So it is
    // acknowledged. 200 is not "ignore": the ERROR log is now the only thing
    // that will surface it, since there is no retry left to do so.
    const payload = jsonEvent(fx.checkoutCompletedNoWorkspace);
    const d = deps({
      apply: jest.fn(async () => {
        throw new StripeWebhookPayloadError(
          "could not resolve a usable workspace id from the event payload"
        );
      }),
    });
    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), sign(payload)), d, T);
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][1]).toMatchObject({
      errorName: "StripeWebhookPayloadError",
      retryRequested: false,
    });
  });

  it("returns 200 for an event naming a workspace that no longer exists", async () => {
    // A deleted workspace is not coming back, so three days of retries change
    // nothing and only feed the consecutive-failure run.
    const payload = jsonEvent(fx.checkoutCompleted);
    const d = deps({
      apply: jest.fn(async () => {
        throw new UnknownWorkspaceError(
          "the event names a workspace that does not exist; refusing to write"
        );
      }),
    });
    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), sign(payload)), d, T);
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][1]).toMatchObject({
      errorName: "UnknownWorkspaceError",
      retryRequested: false,
    });
  });

  it("never puts an internal error message in the response body", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const d = deps({
      apply: jest.fn(async () => {
        throw new Error("SECRET_LEAK sk_live_abc123");
      }),
    });
    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), sign(payload)), d, T);
    expect(res.body).not.toContain("sk_live_abc123");
    expect(res.body).not.toContain("SECRET_LEAK");
  });

  it("never puts payload contents in the response body of a rejected delivery", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const res = await handleStripeWebhook(
      reqFor(Buffer.from(payload, "utf8"), "t=1,v1=notasignature"),
      deps(),
      T
    );
    expect(res.body).not.toContain(fx.CUSTOMER_EMAIL);
    expect(res.body).not.toContain("ws1");
  });
});

// ── logging hygiene ───────────────────────────────────────────────────────────

describe("stripeWebhook — logging hygiene", () => {
  it("logs no customer email, customer id, subscription id, or raw workspace id on the happy path", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const s = store();
    const d = deps({ apply: (event, now) => applyStripeEvent(event, s, now) });

    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), sign(payload)), d, T);
    expect(res.status).toBe(200);

    const text = loggedText();
    expect(text).not.toContain(fx.CUSTOMER_EMAIL);
    expect(text).not.toContain(fx.CUSTOMER_ID);
    expect(text).not.toContain(fx.SUBSCRIPTION_ID);
    expect(text).not.toContain('"ws1"');
    expect(text).not.toContain("workspaceId");
  });

  it("puts a hashed workspace id on the accepted-delivery log line", async () => {
    // Without it the happy path is the one line support cannot correlate to a
    // workspace — the duplicate short-circuit and the unrecognized-status
    // warning both already carry one.
    const payload = jsonEvent(fx.checkoutCompleted);
    const s = store();
    const d = deps({ apply: (event, now) => applyStripeEvent(event, s, now) });

    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), sign(payload)), d, T);
    expect(res.status).toBe(200);

    const accepted = infoSpy.mock.calls.find(
      ([message]) => typeof message === "string" && message.includes("delivery accepted")
    );
    expect(accepted).toBeDefined();
    const meta = accepted?.[1] as Record<string, unknown>;
    expect(meta.workspaceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(meta)).not.toContain("ws1");
  });

  it("logs a hashed workspace id, never the raw one, on the unknown-status path", async () => {
    const s = store({ plan: "pro" });
    const event: StripeWebhookEvent = {
      ...fx.subscriptionUnknownStatus,
      data: {
        object: {
          ...(fx.subscriptionUnknownStatus.data.object as Record<string, unknown>),
          metadata: { workspaceId: "some-real-workspace-id" },
        },
      },
    };

    await applyStripeEvent(event, s, T);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta.workspaceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(meta)).not.toContain("some-real-workspace-id");
  });

  it("never logs the raw event body when a delivery fails verification", async () => {
    const payload = jsonEvent(fx.checkoutCompleted);
    const res = await handleStripeWebhook(
      reqFor(Buffer.from(payload, "utf8"), "t=1,v1=notasignature"),
      deps(),
      T
    );

    expect(res.status).toBe(400);
    const text = loggedText();
    expect(text).not.toContain(fx.CUSTOMER_EMAIL);
    expect(text).not.toContain("cs_test_CheckoutSession123");
    expect(text).not.toContain(fx.CUSTOMER_ID);
    // The Stripe SDK's own SignatureVerificationError carries the payload on
    // its `payload` property, so logging the error object itself would leak
    // the whole body. Only a fixed message plus non-payload metadata is safe.
    expect(text).not.toContain("checkout.session");
  });
});

// ── applyStripeEventTransactionally (the real transactional core) ─────────────
//
// Everything above injects the store, so none of it can prove the idempotency
// record and the plan write actually share one transaction — which is the
// whole point: if they could diverge, a crash between them either loses the
// event forever or double-applies the retry. This block runs the production
// wiring against a fake Firestore whose `tx` enforces the real "all reads
// before any write" rule, mirroring functions/src/__tests__/createSession.test.ts.

function fakeTransactionalDb(docs: Record<string, Record<string, unknown> | undefined>) {
  let writesStarted = false;
  const tx = {
    get: jest.fn(async (ref: { path: string }) => {
      if (writesStarted) {
        throw new Error("fake tx: read attempted after a write — violates Firestore's ordering rule");
      }
      const data = docs[ref.path];
      return { exists: data !== undefined, data: () => data };
    }),
    set: jest.fn((_ref: { path: string }, _data: unknown) => {
      writesStarted = true;
    }),
    update: jest.fn((_ref: { path: string }, _data: unknown) => {
      writesStarted = true;
    }),
  };
  const db = {
    doc: (path: string) => ({ path }),
    runTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, tx };
}

describe("applyStripeEventTransactionally", () => {
  it("writes the plan, the subscription state and the idempotency record in ONE transaction", async () => {
    const { db, tx } = fakeTransactionalDb({ "workspaces/ws1": { plan: "free" } });

    const res = await applyStripeEventTransactionally(db, fx.checkoutCompleted, T);

    expect(res.outcome).toBe("applied");
    expect(db.runTransaction).toHaveBeenCalledTimes(1);
    const written = [
      ...tx.set.mock.calls.map(([ref]) => ref.path),
      ...tx.update.mock.calls.map(([ref]) => ref.path),
    ];
    expect(written).toContain("workspaces/ws1");
    expect(written).toContain("workspaces/ws1/billing/subscription");
    expect(written).toContain(`workspaces/ws1/billing/event_${fx.checkoutCompleted.id}`);
  });

  it("updates only the plan field on the workspace doc, never overwriting it", async () => {
    // A `set` here would drop `members` and lock everyone out of the
    // workspace they just paid for.
    const { db, tx } = fakeTransactionalDb({ "workspaces/ws1": { plan: "free" } });
    await applyStripeEventTransactionally(db, fx.checkoutCompleted, T);
    expect(tx.update).toHaveBeenCalledTimes(1);
    const [ref, data] = tx.update.mock.calls[0];
    expect(ref.path).toBe("workspaces/ws1");
    expect(data).toEqual({ plan: "pro" });
  });

  it("reads the idempotency record from inside the transaction and short-circuits a replay", async () => {
    const { db, tx } = fakeTransactionalDb({
      "workspaces/ws1": { plan: "free" },
      [`workspaces/ws1/billing/event_${fx.checkoutCompleted.id}`]: {
        eventId: fx.checkoutCompleted.id,
      },
    });

    const res = await applyStripeEventTransactionally(db, fx.checkoutCompleted, T);

    expect(res.outcome).toBe("duplicate");
    expect(tx.set).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("writes nothing at all for a workspace that does not exist", async () => {
    const { db, tx } = fakeTransactionalDb({});
    await expect(applyStripeEventTransactionally(db, fx.checkoutCompleted, T)).rejects.toThrow(
      /workspace/i
    );
    expect(tx.set).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("reads the prior subscription state from inside the same transaction as the writes", async () => {
    // The out-of-order guard compares the incoming `event.created` against
    // `lastEventCreated` on this document. Reading it outside the transaction
    // would let a concurrent delivery commit between the comparison and the
    // write, which is the whole failure the guard exists to prevent.
    const { db, tx } = fakeTransactionalDb({ "workspaces/ws1": { plan: "free" } });
    await applyStripeEventTransactionally(db, fx.checkoutCompleted, T);
    const read = tx.get.mock.calls.map(([ref]) => ref.path);
    expect(read).toContain("workspaces/ws1/billing/subscription");
  });

  it("writes nothing at all for an event older than the state already recorded", async () => {
    const { db, tx } = fakeTransactionalDb({
      "workspaces/ws1": { plan: "free" },
      "workspaces/ws1/billing/subscription": {
        lastEventId: fx.subscriptionDeletedLate.id,
        lastEventCreated: fx.CREATED_LATE,
      },
    });

    const res = await applyStripeEventTransactionally(db, fx.subscriptionActiveEarly, T);

    expect(res.outcome).toBe("stale");
    expect(tx.set).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("performs every read before any write (Firestore's transaction rule)", async () => {
    // The fake tx throws on a read that follows a write, so this passing is
    // the assertion; the explicit check is that reads happened at all.
    const { db, tx } = fakeTransactionalDb({ "workspaces/ws1": { plan: "pro" } });
    await applyStripeEventTransactionally(db, fx.subscriptionDeleted, T);
    expect(tx.get.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("still records the idempotency record when no plan write was needed", async () => {
    // The dangerous asymmetry: a past_due event changes no plan, but a replay
    // of it must still be recognized as a replay.
    const { db, tx } = fakeTransactionalDb({ "workspaces/ws1": { plan: "pro" } });
    await applyStripeEventTransactionally(db, fx.subscriptionPastDue, T);
    expect(tx.update).not.toHaveBeenCalled();
    const written = tx.set.mock.calls.map(([ref]) => ref.path);
    expect(written).toContain(`workspaces/ws1/billing/event_${fx.subscriptionPastDue.id}`);
  });

  it("opens no transaction at all for an unhandled event type", async () => {
    const { db } = fakeTransactionalDb({});
    const res = await applyStripeEventTransactionally(db, fx.unhandledEvent, T);
    expect(res.outcome).toBe("ignored");
    expect(db.runTransaction).not.toHaveBeenCalled();
  });
});
