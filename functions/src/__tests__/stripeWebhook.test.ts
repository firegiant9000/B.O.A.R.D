import { logger } from "firebase-functions/v2";
import { stripeClient } from "../billing/stripe";
import type { Plan } from "../billing/limits";
import {
  applyStripeEvent,
  applyStripeEventTransactionally,
  decidePlanWrite,
  handleStripeWebhook,
  type ProcessedEventRecord,
  type StripeWebhookDeps,
  type StripeWebhookEvent,
  type SubscriptionState,
} from "../http/stripeWebhook";
import * as fx from "./fixtures/stripe-events";

// Task 9 — the Stripe webhook. G3 (a Stripe account) is NOT met: there is no
// key, product, price or registered endpoint, so no delivery from Stripe's
// servers has ever reached this code. Two things follow for these tests:
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
 *  `markProcessed` is what makes a later `alreadyProcessed` true, so the
 *  idempotency tests below exercise the handler's real short-circuit rather
 *  than a hard-coded mock answer. */
function store(opts: { plan?: unknown; missingWorkspace?: boolean } = {}) {
  const seen = new Set<string>();
  const workspace = opts.missingWorkspace ? null : { plan: opts.plan ?? "free" };
  return {
    seen,
    readWorkspace: jest.fn(async (_workspaceId: string) => workspace),
    alreadyProcessed: jest.fn(async (_workspaceId: string, eventId: string) => seen.has(eventId)),
    setPlan: jest.fn(async (_workspaceId: string, _plan: Plan) => {}),
    setSubscription: jest.fn(async (_workspaceId: string, _state: SubscriptionState) => {}),
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
      currentPeriodEndMs: null,
      lastEventId: fx.checkoutCompleted.id,
      lastEventType: "checkout.session.completed",
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

// ── applyStripeEvent: unhandled types and fail-closed paths ───────────────────

describe("applyStripeEvent — unhandled and malformed", () => {
  it("ignores an event type it does not handle, without touching the store at all", async () => {
    const s = store();
    await expect(applyStripeEvent(fx.unhandledEvent, s, T)).resolves.toMatchObject({
      outcome: "ignored",
    });
    expect(s.setPlan).not.toHaveBeenCalled();
    expect(s.setSubscription).not.toHaveBeenCalled();
    expect(s.markProcessed).not.toHaveBeenCalled();
    expect(s.readWorkspace).not.toHaveBeenCalled();
    expect(s.alreadyProcessed).not.toHaveBeenCalled();
  });

  it("does not require a workspace id for an unhandled type", async () => {
    // The type check has to come first: `customer.created` carries no
    // workspace id and must not be treated as a malformed payload.
    const s = store();
    await expect(applyStripeEvent(fx.unhandledEvent, s, T)).resolves.toBeDefined();
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

  it("rejects a request with no raw body", async () => {
    const d = deps();
    const res = await handleStripeWebhook(reqFor(undefined, "t=1,v1=deadbeef"), d, T);
    expect(res.status).toBe(400);
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

  it("returns 500 when applying the event fails, so Stripe retries it", async () => {
    // A verified event we could not apply is money we owe the customer. A 2xx
    // here would discard it silently; a 5xx keeps Stripe's retry schedule
    // working and surfaces the failure on Stripe's own dashboard.
    const payload = jsonEvent(fx.checkoutCompleted);
    const d = deps({
      apply: jest.fn(async () => {
        throw new Error("firestore unavailable");
      }),
    });
    const res = await handleStripeWebhook(reqFor(Buffer.from(payload, "utf8"), sign(payload)), d, T);
    expect(res.status).toBe(500);
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
