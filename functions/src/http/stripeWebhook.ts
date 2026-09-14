import { onRequest, type Request } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore, type Firestore, type Transaction } from "firebase-admin/firestore";
import { stripeClient } from "../billing/stripe";
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } from "../config";
import { hashWorkspaceId } from "../ai/usage";
import type { Plan } from "../billing/limits";

// Month 5 — the Stripe webhook. This is the only writer of `workspaces/{id}.
// plan` after signup: firestore.rules denies `plan` on every client update and
// permits only `'free'` on create, and `workspaces/{id}/billing/{doc}` is
// `allow write: if false`, so both documents this file touches are
// Admin-SDK-only. That is what makes the plan gates in
// functions/src/billing/limits.ts worth anything — a client that could write
// `plan` could hand itself Pro for the price of one document write.
//
// NOT LIVE. There is no Stripe account behind this repo: no API key, no
// product, no price, and — the part that matters here — no webhook endpoint
// registered with Stripe and therefore no signing secret in existence. This
// endpoint has never received a delivery from Stripe's servers. What IS
// verified is everything below the wire: signature verification runs against
// genuinely HMAC-signed payloads in functions/src/__tests__/stripeWebhook.
// test.ts (the Stripe SDK can sign a payload locally with the same
// construction Stripe uses), and every event/plan transition is unit-tested.
// See the report for the exact list of what a live account would still verify.
//
// Three things make or break this file:
//
//   1. RAW BODY. Signature verification MUST run against `req.rawBody` — the
//      unparsed bytes. Firebase Functions v2 parses JSON bodies before the
//      handler runs, and `JSON.stringify(req.body)` does not reproduce what
//      Stripe signed: whitespace and key order are gone. Verifying a
//      re-stringified body fails *intermittently* (it happens to match for
//      some payloads), which reads like a Stripe bug rather than ours. Do not
//      "simplify" `rawBody` to `body`; there is a test that goes red if you do
//      ("verifies against the RAW bytes, not a re-stringified parsed body").
//
//   2. IDEMPOTENCY. Stripe retries deliveries, so the same event arrives more
//      than once. Every applied event writes a record keyed by `event.id`, and
//      a delivery whose record already exists short-circuits. Precisely what
//      that does and does not cover:
//        - It DOES suppress a redelivery of the same event.
//        - It does NOT suppress two genuinely different events. Two separate
//          checkouts by the same owner are two event ids and two real Stripe
//          subscriptions; this file writes the second over the first and makes
//          no attempt to reconcile or cancel either. Reconciling duplicate
//          subscriptions is a separate, registered problem and is deliberately
//          not attempted here. Nothing in this file prevents a double charge.
//        - It does NOT order anything. See item 3.
//
//   3. ORDERING. Stripe does not guarantee delivery order, and a delivery
//      answered with a 5xx is retried for up to ~3 days while newer events
//      keep being delivered — so a `subscription.updated{active}` that failed
//      can land AFTER the `subscription.deleted` that superseded it. Applied
//      in that order it would restore Pro for a subscription that no longer
//      exists, and Stripe would send nothing further to correct it. Every
//      applied event therefore records its `event.created`, and an event
//      strictly older than the recorded one is discarded. Item 2's event-id
//      record cannot cover this: those are two different events, so neither is
//      a duplicate of the other.

/** The narrow slice of a Stripe event this file reads. `Stripe.Event`
 *  satisfies it structurally, so the onRequest binding hands the real thing
 *  straight in — but keeping the type narrow (and `data.object` as `unknown`)
 *  means every field access below goes through the tolerant readers, which is
 *  what lets one code path handle both the API version pinned today and the
 *  older shapes a replayed event can carry. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  /** UNIX SECONDS, as Stripe sends it. The only ordering information a
   *  delivery carries, and the whole basis of the out-of-order guard in
   *  `applyStripeEvent` — Stripe does not guarantee delivery order, and an
   *  event that fails is retried for days while newer events keep arriving.
   *  Required because `Stripe.Event` always carries it; still read through
   *  `readFiniteNumber` below, the same way `id` is, so a shape that somehow
   *  lacks it degrades to "unorderable" rather than throwing. */
  created: number;
  data: { object: unknown };
}

/** Persisted at `workspaces/{id}/billing/subscription`. Functions-only writes.
 *  Readers must tolerate missing fields (`data?.field ?? default`) — this doc
 *  can be written by an older deploy than the one reading it. */
export interface SubscriptionState {
  schemaVersion: 1;
  /** Stripe's subscription status where the event carries one, or a value
   *  derived from the event (see `statusSource`). */
  status: string;
  /** Where `status` came from, because two of the three are derived rather
   *  than read: `checkout` and `invoice` events do not state the
   *  subscription's status, so this file infers it. Recording the provenance
   *  keeps a derived value from being mistaken for Stripe's own. */
  statusSource: "checkout" | "subscription" | "invoice";
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** MILLISECONDS (Stripe sends unix seconds). */
  currentPeriodEndMs: number | null;
  lastEventId: string;
  lastEventType: string;
  /** `event.created` of the newest event applied to this workspace, in UNIX
   *  SECONDS (not milliseconds — it is stored exactly as Stripe sent it, so it
   *  can be compared against an incoming `event.created` without a conversion
   *  that could be got wrong in one direction only).
   *
   *  This field is what makes the out-of-order guard possible, so it is not
   *  merely informational: an event whose `created` is OLDER than this is
   *  discarded (see `applyStripeEvent`). `null` means "unorderable" — an event
   *  arrived without a usable `created` — and never blocks a later event. */
  lastEventCreated: number | null;
  updatedAt: number;
}

/** Persisted at `workspaces/{id}/billing/event_{eventId}` — the idempotency
 *  record. Its existence is the entire dedupe mechanism, so it is written in
 *  the same transaction as the plan and subscription writes. */
export interface ProcessedEventRecord {
  schemaVersion: 1;
  eventId: string;
  eventType: string;
  /** The plan this event actually wrote, or null when it wrote none (a
   *  past_due grace event, or a redundant write skipped). */
  planWritten: Plan | null;
  processedAt: number;
}

/** `stale` is the out-of-order case: a genuinely different, genuinely older
 *  event that arrived after a newer one had already been applied. It is kept
 *  distinct from `duplicate` (a redelivery of the SAME event id) because the
 *  two say different things — a duplicate means Stripe retried, a stale event
 *  means Stripe delivered out of order and this endpoint declined to move the
 *  workspace backwards. */
export type StripeEventOutcome = "applied" | "duplicate" | "ignored" | "stale";

export interface ApplyStripeEventResult {
  outcome: StripeEventOutcome;
  /** Present only when this event actually changed `plan`. */
  planWritten?: Plan;
  /** The hashed workspace id, present once one has been resolved from the
   *  payload — so the request handler's accepted-delivery log line can be
   *  correlated to a workspace. Hashed, never the raw id. */
  workspaceHash?: string;
}

/** Injected so `applyStripeEvent` unit-tests with no Firestore mock at all,
 *  matching CreateSessionDeps in functions/src/callable/createSession.ts.
 *
 *  The Firestore implementation (`transactionStore` below) is TRANSACTION-
 *  SCOPED: its reads are `tx.get` and its writes are `tx.set`/`tx.update` on
 *  one transaction. That is deliberate and load-bearing — it is what stops the
 *  idempotency record and the plan write from diverging. `applyStripeEvent`
 *  therefore calls every read BEFORE any write, which Firestore requires. */
export interface StripeWebhookStore {
  /** True if this event id has already been applied for this workspace. */
  alreadyProcessed(workspaceId: string, eventId: string): Promise<boolean>;
  /** The workspace document, or null if it does not exist. */
  readWorkspace(workspaceId: string): Promise<{ plan?: unknown } | null>;
  /** The subscription document as previously written, or null if this
   *  workspace has never had one. Both fields are `unknown` rather than typed:
   *  the doc can have been written by an older deploy, and both are read
   *  through the tolerant readers. Two things need it, and both are inside the
   *  same transaction as the writes — the out-of-order guard
   *  (`lastEventCreated`) and carrying `currentPeriodEndMs` forward across an
   *  event that does not carry one. */
  readSubscription(
    workspaceId: string
  ): Promise<{ lastEventCreated?: unknown; currentPeriodEndMs?: unknown } | null>;
  setSubscription(workspaceId: string, state: SubscriptionState): Promise<void>;
  setPlan(workspaceId: string, plan: Plan): Promise<void>;
  markProcessed(
    workspaceId: string,
    eventId: string,
    record: ProcessedEventRecord
  ): Promise<void>;
}

/** Base for the two failures this file raises deliberately, so the request
 *  handler can log their (self-authored, therefore safe) messages without
 *  risking a third-party error message reaching the logs. */
export class StripeWebhookError extends Error {}

/** The event's shape is not something we can act on, and never will be — the
 *  bytes are immutable, so a retry cannot fix it. One of the two retry-proof
 *  classes: answered 200 + `logger.error`, see the comment on the catch in
 *  `handleStripeWebhook`. */
export class StripeWebhookPayloadError extends StripeWebhookError {
  constructor(message: string) {
    super(message);
    this.name = "StripeWebhookPayloadError";
  }
}

/** A verified event naming a workspace that does not exist. The other
 *  retry-proof class: a deleted workspace is not coming back, so no number of
 *  retries makes this applicable. */
export class UnknownWorkspaceError extends StripeWebhookError {
  constructor(message: string) {
    super(message);
    this.name = "UnknownWorkspaceError";
  }
}

// ── event types and statuses ──────────────────────────────────────────────────

/** The event types this endpoint acts on. Anything else is acknowledged with a
 *  2xx and dropped: a non-2xx would make Stripe retry, on a schedule measured
 *  in days, an event that will never be handled however many times it arrives.
 *
 *  `customer.subscription.created` is here alongside `updated` because a
 *  subscription that is born `active` (created through the API or the Stripe
 *  Dashboard rather than this app's Checkout flow) fires `created` and then
 *  nothing until its state next changes — without it, such a subscription
 *  would never grant Pro.
 *
 *  Must stay in step with the switch in `evaluateEvent`; the switch's default
 *  arm throws rather than silently doing nothing, so a divergence fails loudly
 *  instead of quietly dropping paid events. */
const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);

/** Subscription statuses that grant Pro. An allowlist, not a denylist: a
 *  status not named in any of the three sets below grants nothing. */
const PRO_STATUSES = new Set(["active", "trialing"]);

/** Statuses that take the workspace back to free so the gates re-engage.
 *  `unpaid` and `incomplete_expired` are where Stripe parks a subscription
 *  whose payments have definitively failed; `paused` collects no money either.
 *
 *  Deliberately NOT the same set `createCheckoutSession`'s double-checkout
 *  guard treats as safe to start a fresh Checkout over
 *  (NON_LIVE_SUBSCRIPTION_STATUSES in functions/src/callable/
 *  createCheckoutSession.ts) — that set excludes only "canceled" and
 *  "incomplete_expired", so "unpaid" and "paused" stay blocked there even
 *  though they revoke Pro here. The two sets answer different questions on
 *  purpose: this one asks "does the workspace get Pro", the guard asks "is
 *  it safe to mint a SECOND subscription" — and for "unpaid"/"paused" the
 *  answer to both is "no", for different reasons. A workspace in either
 *  state therefore loses Pro here AND is refused a new checkout there,
 *  simultaneously. That combined state is intentional, not an accidental
 *  gap between two files that happen to agree — if you change this set,
 *  check whether the guard's set should still diverge from it. */
const REVOKE_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);

/** Statuses where a payment is still in flight. The plan is left exactly as it
 *  is: `past_due` in particular is a customer whose card failed once and whom
 *  Stripe will retry, and revoking their paid features mid-retry is a support
 *  ticket, not enforcement. The downgrade still happens if the retries run out
 *  — Stripe moves the subscription to `unpaid`/`canceled` (above), and the
 *  final `invoice.payment_failed` also downgrades (see
 *  `evaluateInvoicePaymentFailed`). */
const GRACE_STATUSES = new Set(["past_due", "incomplete"]);

/** Sets, not object literals, on purpose: `PLAN_LIMITS["__proto__"]` is
 *  `Object.prototype` (see the hardening in callable/createBoard.ts), so a
 *  status looked up in an object literal could read a truthy value for a
 *  status that does not exist. `Set.has` compares values and has no prototype
 *  chain to walk. */
type PlanDecision = "pro" | "free" | "unchanged";

// Both ids below are interpolated into Firestore document paths. Signature
// verification means they can only have come from Stripe, so this is defence
// in depth rather than the primary control — but a `/` in either would silently
// retarget the write to a different document, so neither is trusted verbatim.
// Firestore auto-ids (what `addDoc` produces for workspaces) and Stripe object
// ids both fit comfortably inside this character class.
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

// ── tolerant readers ──────────────────────────────────────────────────────────
//
// Every read of the event payload goes through these. Two reasons, and the
// second is the load-bearing one: (a) `data.object` is `unknown`, and (b) an
// event replayed from Stripe's event log carries the shape of the API version
// it was CREATED under, not the version pinned in functions/src/billing/
// stripe.ts — so more than one shape has to read without throwing.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `Number.isFinite`, not `typeof === "number"`: `NaN` is a legal JSON/
 *  Firestore double and would otherwise propagate into a timestamp. */
function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Walks a fixed, code-authored key path. The keys are literals from the
 *  tables below — never a value taken from the payload — so no payload key can
 *  steer this. */
function readPath(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    const record = asRecord(cursor);
    if (!record) return undefined;
    cursor = record[key];
  }
  return cursor;
}

/** A Stripe id field, which is either the id itself or an expanded object. */
function readIdRef(value: unknown): string | undefined {
  return readString(value) ?? readString(asRecord(value)?.id);
}

/** Where the workspace id can be, in priority order.
 *
 *  Only the first two exist on a Checkout Session, and they are the two
 *  createCheckoutSession sets. Subscriptions carry the id in their OWN
 *  metadata, which Stripe does not copy from the session — the Checkout
 *  Session seeds it via `subscription_data.metadata` (functions/src/billing/
 *  stripe.ts), and without that seeding no `customer.subscription.*` event
 *  could be attributed to a workspace and no downgrade would ever apply.
 *  Invoices carry a snapshot of that subscription metadata: under `parent` in
 *  the pinned API version, at the top level in older ones. */
const WORKSPACE_ID_PATHS: readonly (readonly string[])[] = [
  ["client_reference_id"],
  ["metadata", "workspaceId"],
  ["parent", "subscription_details", "metadata", "workspaceId"],
  ["subscription_details", "metadata", "workspaceId"],
];

function resolveWorkspaceId(object: unknown): string | undefined {
  for (const path of WORKSPACE_ID_PATHS) {
    const value = readString(readPath(object, path));
    if (value !== undefined) return value;
  }
  return undefined;
}

function resolveCustomerId(object: unknown): string | null {
  return readIdRef(asRecord(object)?.customer) ?? null;
}

function resolveSubscriptionId(object: unknown): string | null {
  const record = asRecord(object);
  if (!record) return null;
  // On a `customer.subscription.*` event the subscription IS the object.
  if (readString(record.object) === "subscription") return readString(record.id) ?? null;
  return (
    readIdRef(record.subscription) ??
    readIdRef(readPath(record, ["parent", "subscription_details", "subscription"])) ??
    null
  );
}

/** The renewal date, in milliseconds. `Subscription.current_period_end` was
 *  removed from the top level in API version 2025-06-30 and now lives on each
 *  subscription ITEM; both shapes are read, because a replayed event can carry
 *  either. Returning seconds here instead of milliseconds would understate the
 *  renewal date by a factor of ~55,000 — there is a test pinning the unit. */
function resolvePeriodEndMs(object: unknown): number | null {
  const record = asRecord(object);
  if (!record) return null;
  const items = asRecord(record.items)?.data;
  if (Array.isArray(items)) {
    for (const item of items) {
      const seconds = readFiniteNumber(asRecord(item)?.current_period_end);
      if (seconds !== undefined) return seconds * 1000;
    }
  }
  const legacySeconds = readFiniteNumber(record.current_period_end);
  return legacySeconds === undefined ? null : legacySeconds * 1000;
}

// ── per-event evaluation ──────────────────────────────────────────────────────

interface EventEvaluation {
  status: string;
  statusSource: SubscriptionState["statusSource"];
  planDecision: PlanDecision;
}

/** A completed Checkout Session is not necessarily a paid one: an asynchronous
 *  payment method (a delayed bank debit) completes the session with
 *  `payment_status: "unpaid"` and the money arrives later, and a trial
 *  completes with `no_payment_required`. Grant Pro only when the session is
 *  PROVABLY settled — an absent or unrecognized `payment_status` grants
 *  nothing. The unpaid case is not lost: the subscription's own
 *  `active` event grants Pro once the payment clears. */
function evaluateCheckoutSession(object: unknown): EventEvaluation {
  const paymentStatus = readString(asRecord(object)?.payment_status);
  const settled = paymentStatus === "paid" || paymentStatus === "no_payment_required";
  return {
    status: settled ? "active" : "incomplete",
    statusSource: "checkout",
    planDecision: settled ? "pro" : "unchanged",
  };
}

function evaluateSubscription(
  object: unknown,
  workspaceId: string,
  deleted: boolean
): EventEvaluation {
  const status = readString(asRecord(object)?.status) ?? "unknown";
  if (deleted) {
    // `customer.subscription.deleted` means the subscription is gone, whatever
    // status snapshot the event happens to carry.
    return { status, statusSource: "subscription", planDecision: "free" };
  }
  if (PRO_STATUSES.has(status)) {
    return { status, statusSource: "subscription", planDecision: "pro" };
  }
  if (REVOKE_STATUSES.has(status)) {
    return { status, statusSource: "subscription", planDecision: "free" };
  }
  if (!GRACE_STATUSES.has(status)) {
    // Stripe adds status values over time (its own SDK types them as a union
    // with a string escape hatch). An unrecognized status grants nothing — but
    // it does not revoke either, because revoking on a status we do not
    // understand would downgrade a paying customer on a Stripe release note.
    // Fail-closed must not also be silent, or the ticket is undiagnosable.
    logger.warn("stripeWebhook: unrecognized subscription status; leaving the plan unchanged", {
      workspaceHash: hashWorkspaceId(workspaceId),
      status,
    });
  }
  return { status, statusSource: "subscription", planDecision: "unchanged" };
}

/** `invoice.payment_failed` fires on EVERY failed attempt, including the
 *  first, so it cannot mean "downgrade now" — that would revoke Pro from a
 *  customer whose card will succeed on Stripe's next retry two days later, and
 *  contradict the `past_due` grace above. What distinguishes the terminal
 *  failure is `next_payment_attempt`: Stripe sets it to the next scheduled
 *  retry and to null once the retry schedule is exhausted. A missing field
 *  reads as terminal, i.e. the fail direction here is toward the downgrade. */
function evaluateInvoicePaymentFailed(object: unknown): EventEvaluation {
  const retryScheduled = readFiniteNumber(asRecord(object)?.next_payment_attempt) !== undefined;
  return retryScheduled
    ? { status: "past_due", statusSource: "invoice", planDecision: "unchanged" }
    : { status: "unpaid", statusSource: "invoice", planDecision: "free" };
}

function evaluateEvent(
  eventType: string,
  object: unknown,
  workspaceId: string
): EventEvaluation {
  switch (eventType) {
    case "checkout.session.completed":
      return evaluateCheckoutSession(object);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return evaluateSubscription(object, workspaceId, false);
    case "customer.subscription.deleted":
      return evaluateSubscription(object, workspaceId, true);
    case "invoice.payment_failed":
      return evaluateInvoicePaymentFailed(object);
    default:
      // Unreachable while this switch and HANDLED_EVENT_TYPES agree. Throwing
      // rather than returning "unchanged" is the point: if someone adds a type
      // to the set and forgets this switch, every such event is logged at
      // ERROR instead of being silently dropped as a no-op. It is a
      // StripeWebhookPayloadError, so the delivery is acknowledged rather than
      // retried: retrying a missing evaluator fixes nothing, the fix is a
      // deploy, and the ERROR log is what prompts one.
      throw new StripeWebhookPayloadError(
        `event type ${eventType} is in HANDLED_EVENT_TYPES but has no evaluator`
      );
  }
}

// ── the plan write decision ───────────────────────────────────────────────────

/** Which plan value, if any, to write — given what the workspace currently
 *  stores and what the event decided. Pure, so the whole matrix unit-tests
 *  without a store.
 *
 *  Two rules beyond the obvious:
 *
 *  - `edu` is never touched, in EITHER direction. It is granted out of band,
 *    not by Stripe, so a Stripe subscription ending is no evidence an edu
 *    grant ended, and a Stripe checkout is no reason to demote an edu
 *    workspace (edu's collaborator cap is higher than Pro's).
 *  - A redundant write is skipped, so a `setPlan` call always means a real
 *    transition. A stored value that is neither `free`, `pro`, `edu` nor
 *    absent is treated as corrupt rather than as "already free": a downgrade
 *    normalizes it to `free`, and an upgrade overwrites it with `pro`. */
export function decidePlanWrite(currentPlan: unknown, decision: PlanDecision): Plan | undefined {
  if (decision === "unchanged") return undefined;
  // String equality only, never an object lookup keyed by the stored value.
  const current = typeof currentPlan === "string" ? currentPlan : undefined;
  if (current === "edu") return undefined;
  if (decision === "pro") return current === "pro" ? undefined : "pro";
  // A missing `plan` field means free by this codebase's convention (see
  // handleCreateSession), so there is nothing to revoke.
  return current === undefined || current === "free" ? undefined : "free";
}

// ── the pure handler ──────────────────────────────────────────────────────────

/** Why an event was acknowledged without acting on it. Recorded so "we did
 *  nothing" is distinguishable in the logs from "we failed", and so the two
 *  reasons are distinguishable from each other. */
type IgnoredReason =
  | "unhandled-type"
  | "not-a-subscription-checkout"
  | "not-a-subscription-invoice";

function ignoredResult(eventType: string, reason: IgnoredReason): ApplyStripeEventResult {
  logger.info("stripeWebhook: acknowledging an event this endpoint takes no action on", {
    eventType,
    reason,
  });
  return { outcome: "ignored" };
}

/** Whether a handled event type is, on this particular payload, not about a
 *  workspace's recurring plan at all — which is out of scope rather than
 *  malformed, so it is acknowledged (2xx) rather than retried for days over
 *  something this endpoint will never act on.
 *
 *  Both arms are the deny-unless-provably-permitted form, and both are
 *  deliberately narrow:
 *
 *  - A Checkout Session grants Pro only if it is PROVABLY `mode:
 *    "subscription"`. Nothing in this app creates a one-time-payment session
 *    today (createCheckoutSession hard-codes subscription mode), but if one is
 *    ever added, a completed one-off purchase must not silently confer a
 *    recurring plan.
 *  - An invoice is out of scope only if it names no subscription anywhere. An
 *    invoice that DOES name one but carries no workspace id is an anomaly, not
 *    out of scope, and must fail loudly instead — quietly acknowledging that
 *    one would drop a downgrade. */
function outOfScopeReason(eventType: string, object: unknown): IgnoredReason | undefined {
  if (eventType === "checkout.session.completed") {
    return readString(asRecord(object)?.mode) === "subscription"
      ? undefined
      : "not-a-subscription-checkout";
  }
  if (eventType === "invoice.payment_failed") {
    return resolveSubscriptionId(object) === null ? "not-a-subscription-invoice" : undefined;
  }
  return undefined;
}

/**
 * Applies one already-verified Stripe event. Pure over the injected store, so
 * every transition below is tested with no Firestore mock.
 *
 * The ordering is load-bearing in three places:
 *
 *   1. The event TYPE is checked first. An unhandled type must not be treated
 *      as a malformed payload — `customer.created` legitimately carries no
 *      workspace id, and demanding one would turn every unrelated event into
 *      an error on an event this endpoint will never act on.
 *   2. Both ids are validated before any store call, so an id that is not
 *      usable as a document id never reaches a Firestore path.
 *   3. Every READ (`alreadyProcessed`, `readWorkspace`, `readSubscription`)
 *      precedes every write. Firestore requires that inside a transaction, and
 *      the Firestore store is transaction-scoped.
 *
 * `markProcessed` is written on every applied event, including one that
 * changed no plan: a replay of a `past_due` event must still be recognized as
 * a replay.
 *
 * TWO INDEPENDENT SUPPRESSIONS, which are not the same mechanism:
 *
 *   - `alreadyProcessed` (`event.id`) suppresses a REDELIVERY of one event.
 *   - `lastEventCreated` (`event.created`) suppresses a genuinely different but
 *     OLDER event that lost a race. The event-id record cannot do this: the two
 *     events have different ids, so neither is a duplicate of the other.
 */
export async function applyStripeEvent(
  event: StripeWebhookEvent,
  store: StripeWebhookStore,
  now: number
): Promise<ApplyStripeEventResult> {
  const eventType = event.type;
  if (!HANDLED_EVENT_TYPES.has(eventType)) return ignoredResult(eventType, "unhandled-type");

  const eventId = readString(event.id);
  if (eventId === undefined || !SAFE_ID_PATTERN.test(eventId)) {
    throw new StripeWebhookPayloadError("event id is missing or unusable as a document id");
  }

  const object = event.data?.object;
  const outOfScope = outOfScopeReason(eventType, object);
  if (outOfScope !== undefined) return ignoredResult(eventType, outOfScope);

  const workspaceId = resolveWorkspaceId(object);
  if (workspaceId === undefined || !SAFE_ID_PATTERN.test(workspaceId)) {
    throw new StripeWebhookPayloadError(
      "could not resolve a usable workspace id from the event payload"
    );
  }

  const workspaceHash = hashWorkspaceId(workspaceId);
  // `readFiniteNumber`, not `event.created` directly, for the same reason
  // `event.id` goes through `readString`: the declared type says Stripe always
  // sends it, and an event that somehow does not must degrade rather than
  // throw. `undefined` here means "unorderable" and never drops the event.
  const eventCreated = readFiniteNumber(event.created);

  // ── reads ──
  if (await store.alreadyProcessed(workspaceId, eventId)) {
    logger.info("stripeWebhook: event already applied; short-circuiting the redelivery", {
      eventType,
      eventId,
      workspaceHash,
    });
    return { outcome: "duplicate", workspaceHash };
  }

  const workspace = await store.readWorkspace(workspaceId);
  if (workspace === null) {
    // Deliberate: do not create the workspace, and do not write a plan for
    // one that does not exist — that would leave an orphan billing subtree.
    // The delivery is acknowledged rather than retried (see the catch in
    // `handleStripeWebhook`) and logged at ERROR, because a paid checkout for
    // a workspace that no longer exists is money taken for nothing and needs a
    // human, not a retry.
    throw new UnknownWorkspaceError(
      "the event names a workspace that does not exist; refusing to write"
    );
  }

  const priorState = await store.readSubscription(workspaceId);

  // ── the out-of-order guard ──
  //
  // Stripe does NOT guarantee delivery order, and a delivery answered with a
  // 500 is retried for up to ~3 days while newer events keep arriving. Without
  // this guard: `customer.subscription.updated{active}` fails on a Firestore
  // blip, `customer.subscription.deleted` arrives and applies (plan -> free),
  // then the earlier `active` retry finally succeeds and puts the workspace
  // back on `pro` for a subscription that no longer exists. Nothing would ever
  // correct it, because Stripe has no further event to send about a
  // subscription it has already deleted.
  //
  // STRICTLY-NEWER-WINS: drop only when the stored event is strictly newer.
  // `created` has one-second resolution, so two events of the same checkout
  // routinely tie; a tie APPLIES, because silently discarding a legitimate
  // event is worse than applying two in an ambiguous order. The stale event's
  // auxiliary fields (period end, ids) are skipped along with its plan
  // decision, which is correct: the newer event is by definition the more
  // current statement of both.
  const priorCreated = readFiniteNumber(priorState?.lastEventCreated);
  if (priorCreated !== undefined && eventCreated !== undefined && priorCreated > eventCreated) {
    logger.warn("stripeWebhook: ignoring an out-of-order event older than the applied state", {
      eventType,
      eventId,
      workspaceHash,
      eventCreated,
      appliedCreated: priorCreated,
    });
    return { outcome: "stale", workspaceHash };
  }

  const evaluation = evaluateEvent(eventType, object, workspaceId);
  const planWritten = decidePlanWrite(workspace.plan, evaluation.planDecision);

  // Carried forward rather than nulled: `resolvePeriodEndMs` reads the renewal
  // date off a subscription, and neither a Checkout Session nor an Invoice
  // carries one — so a full `set` of this document on either would erase a
  // renewal date a previous subscription event had recorded. The prior value
  // comes from the read above, inside this same transaction.
  const currentPeriodEndMs =
    resolvePeriodEndMs(object) ?? readFiniteNumber(priorState?.currentPeriodEndMs) ?? null;

  // ── writes ──
  await store.setSubscription(workspaceId, {
    schemaVersion: 1,
    status: evaluation.status,
    statusSource: evaluation.statusSource,
    stripeCustomerId: resolveCustomerId(object),
    stripeSubscriptionId: resolveSubscriptionId(object),
    currentPeriodEndMs,
    lastEventId: eventId,
    lastEventType: eventType,
    lastEventCreated: eventCreated ?? null,
    updatedAt: now,
  });

  if (planWritten !== undefined) {
    await store.setPlan(workspaceId, planWritten);
  }

  await store.markProcessed(workspaceId, eventId, {
    schemaVersion: 1,
    eventId,
    eventType,
    planWritten: planWritten ?? null,
    processedAt: now,
  });

  return planWritten === undefined
    ? { outcome: "applied", workspaceHash }
    : { outcome: "applied", planWritten, workspaceHash };
}

// ── the Firestore store ───────────────────────────────────────────────────────

const SUBSCRIPTION_DOC_ID = "subscription";

/** Prefixed so an idempotency record can never collide with the subscription
 *  document, whatever a Stripe event id looks like, while both stay inside the
 *  `billing` subcollection that firestore.rules already locks to
 *  `allow write: if false`. Putting them in a new top-level collection would
 *  rely on Firestore's implicit default-deny instead of that explicit rule. */
const PROCESSED_EVENT_DOC_PREFIX = "event_";

function workspaceRef(db: Firestore, workspaceId: string) {
  return db.doc(`workspaces/${workspaceId}`);
}

function subscriptionRef(db: Firestore, workspaceId: string) {
  return db.doc(`workspaces/${workspaceId}/billing/${SUBSCRIPTION_DOC_ID}`);
}

function processedEventRef(db: Firestore, workspaceId: string, eventId: string) {
  return db.doc(
    `workspaces/${workspaceId}/billing/${PROCESSED_EVENT_DOC_PREFIX}${eventId}`
  );
}

/** The store, bound to one transaction. This is what makes the idempotency
 *  record and the plan write inseparable: they are two writes on the same
 *  transaction, so either both land or neither does. If they could diverge,
 *  the two failure modes are both bad and both silent — marking an event
 *  processed without applying it loses that upgrade forever, and applying it
 *  without marking it means the next retry applies it again.
 *
 *  `setPlan` uses `update`, not `set`: the workspace document holds `members`,
 *  `ownerId` and the rest, and a `set` would drop them — locking everyone out
 *  of the workspace they just paid for. `update` requires the document to
 *  exist, which `applyStripeEvent` has already established through
 *  `readWorkspace` inside this same transaction. */
function transactionStore(db: Firestore, tx: Transaction): StripeWebhookStore {
  return {
    alreadyProcessed: async (workspaceId, eventId) =>
      (await tx.get(processedEventRef(db, workspaceId, eventId))).exists,
    readWorkspace: async (workspaceId) => {
      const snap = await tx.get(workspaceRef(db, workspaceId));
      return snap.exists ? ((snap.data() ?? {}) as { plan?: unknown }) : null;
    },
    readSubscription: async (workspaceId) => {
      const snap = await tx.get(subscriptionRef(db, workspaceId));
      return snap.exists
        ? ((snap.data() ?? {}) as { lastEventCreated?: unknown; currentPeriodEndMs?: unknown })
        : null;
    },
    setSubscription: async (workspaceId, state) => {
      tx.set(subscriptionRef(db, workspaceId), state);
    },
    setPlan: async (workspaceId, plan) => {
      tx.update(workspaceRef(db, workspaceId), { plan });
    },
    markProcessed: async (workspaceId, eventId, record) => {
      tx.set(processedEventRef(db, workspaceId, eventId), record);
    },
  };
}

/** The production wiring: one transaction per event.
 *
 *  Firestore re-runs a transaction body on contention, which is safe here
 *  because `applyStripeEvent` derives everything from the event and the reads
 *  it makes inside the transaction — it holds no state across attempts. An
 *  error it throws deliberately (a malformed payload, an unknown workspace) is
 *  not a contention error, so it aborts the transaction and propagates rather
 *  than being retried. */
export async function applyStripeEventTransactionally(
  db: Firestore,
  event: StripeWebhookEvent,
  now: number
): Promise<ApplyStripeEventResult> {
  // Checked before opening a transaction: most deliveries to a busy endpoint
  // are types this code ignores, and each one would otherwise cost a
  // transaction round trip. Same predicate and same log line as
  // `applyStripeEvent`, so the two cannot disagree.
  if (!HANDLED_EVENT_TYPES.has(event.type)) return ignoredResult(event.type, "unhandled-type");
  return db.runTransaction((tx) => applyStripeEvent(event, transactionStore(db, tx), now));
}

// ── the request handler ───────────────────────────────────────────────────────

/** The two `stripe.webhooks` members this file uses. Narrower than the SDK's
 *  full webhooks object so a test can hand in a stub, though the real thing is
 *  what the signature tests actually use. */
export interface StripeSignatureVerifier {
  /** Stripe's recommended replay window, in seconds. */
  DEFAULT_TOLERANCE: number;
  constructEvent(
    payload: Buffer | string,
    header: string,
    secret: string,
    tolerance?: number
  ): StripeWebhookEvent;
}

export interface StripeWebhookDeps {
  /** The webhook SIGNING secret (`whsec_...`) — not the API key. */
  webhookSecret: string;
  verifier: StripeSignatureVerifier;
  apply(event: StripeWebhookEvent, now: number): Promise<ApplyStripeEventResult>;
}

/** The slice of the express request this handler reads. `firebase-functions`'
 *  v2 `Request` satisfies it, `rawBody` included. */
export interface StripeWebhookRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  /** The UNPARSED request bytes, which Functions v2 attaches alongside the
   *  parsed `body`. Signature verification uses only this. */
  rawBody?: Buffer;
}

export interface StripeWebhookReply {
  status: number;
  body: string;
}

/**
 * Verifies a delivery and hands the event to `deps.apply`. Returns the reply
 * rather than writing it, so the whole request path — including real signature
 * verification — unit-tests without express, the Functions runtime, or a
 * Stripe account. It never throws: every exit is a deliberate status code.
 *
 * The status codes are chosen around two facts, and the second one is the
 * reason the catch below is split rather than a blanket 500:
 *
 *   (a) A non-2xx makes Stripe retry, for up to ~3 days.
 *   (b) Stripe DISABLES an endpoint after a sustained run of consecutive
 *       failures — it emails first, then stops delivering. So answering a
 *       class of event that can never succeed with a 500 does not merely make
 *       noise: its tail is the endpoint going dark, which converts one
 *       permanently-unapplicable event into the loss of every subsequent good
 *       event, cancellations included.
 *
 *   200 — verified and applied, verified and deduped, an out-of-order event
 *         declined, an event type this endpoint does not handle, or a verified
 *         event that is PROVABLY unapplicable however many times it arrives
 *         (see the catch). All of them are "done"; retrying any of them
 *         achieves nothing, and the last one is logged at ERROR so that being
 *         done is not the same as being unnoticed.
 *   400 — the CALLER's delivery did not verify: bad signature, wrong secret,
 *         stale timestamp, missing or unusable signature header. Nothing is
 *         processed. Stripe does not retry a 400, which is correct — the same
 *         bytes with the same signature will never verify.
 *   405 — not a POST. Stripe only ever POSTs.
 *   500 — configuration is missing, the request arrived with no raw body to
 *         verify (a platform fault, not a caller fault — see below), or a
 *         verified event could not be applied for a reason a retry might fix.
 *         Deliberately retryable: a verified event we failed to apply is a
 *         payment we owe the customer, and Stripe's retry schedule plus the
 *         failed-delivery list on Stripe's own dashboard is what surfaces it.
 */
export async function handleStripeWebhook(
  req: StripeWebhookRequest,
  deps: StripeWebhookDeps,
  now: number
): Promise<StripeWebhookReply> {
  if ((req.method ?? "").toUpperCase() !== "POST") {
    return { status: 405, body: "method not allowed" };
  }

  // Fail closed on configuration before touching the payload: with no signing
  // secret there is no way to tell a real delivery from a forged one, and
  // verifying against "" would throw inside the SDK and read as a bad
  // signature rather than as the deploy problem it is.
  if (!deps.webhookSecret) {
    logger.error(
      "stripeWebhook: STRIPE_WEBHOOK_SECRET is not set; refusing to process any delivery"
    );
    return { status: 500, body: "not configured" };
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || signature.length === 0) {
    logger.warn("stripeWebhook: rejected a delivery with no usable stripe-signature header", {
      headerType: Array.isArray(signature) ? "array" : typeof signature,
    });
    return { status: 400, body: "invalid signature" };
  }

  // req.rawBody — NOT req.body. See item 1 in this file's header comment.
  //
  // ERROR and 500, not warn and 400, and the asymmetry with the header check
  // above is the point. Stripe always POSTs a body, so an absent `rawBody`
  // cannot be caused by the caller: it can only be the platform or the runtime
  // failing to attach the unparsed bytes, which is OURS. If that ever happens
  // it happens to EVERY delivery, and a 400 would be both un-retried and
  // un-alerted — every payment lost, silently. A 500 keeps Stripe's retries
  // alive long enough for a fix to land, and ERROR is what an alerting policy
  // fires on.
  const rawBody = req.rawBody;
  if (rawBody === undefined || rawBody.length === 0) {
    logger.error(
      "stripeWebhook: delivery arrived with no raw body to verify; the runtime did not attach one"
    );
    return { status: 500, body: "no raw body" };
  }

  let event: StripeWebhookEvent;
  try {
    event = deps.verifier.constructEvent(
      rawBody,
      signature,
      deps.webhookSecret,
      // The replay window, in seconds: a correctly signed delivery whose
      // timestamp is older than this is rejected. `constructEvent` already
      // applies `DEFAULT_TOLERANCE` when the argument is omitted, so this is
      // the same 300s either way — it is passed to state the window at the
      // call site rather than inherit it silently. Stripe signs each delivery
      // attempt afresh, so a legitimate retry is always inside the window.
      deps.verifier.DEFAULT_TOLERANCE
    );
  } catch (err) {
    // The error object itself is NOT logged: Stripe's
    // StripeSignatureVerificationError carries the entire request payload on
    // its `payload` property, and that payload contains the customer's email
    // address. Only the error's class name, which is safe, is recorded.
    logger.warn("stripeWebhook: signature verification failed; rejecting the delivery", {
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return { status: 400, body: "invalid signature" };
  }

  try {
    const result = await deps.apply(event, now);
    logger.info("stripeWebhook: delivery accepted", {
      eventType: event.type,
      eventId: event.id,
      outcome: result.outcome,
      planWritten: result.planWritten ?? "none",
      // Hashed, per the Global Constraint. Absent on an outcome that resolved
      // no workspace at all (an unhandled type, or an out-of-scope payload) —
      // there is nothing to correlate in that case.
      workspaceHash: result.workspaceHash ?? "none",
    });
    return { status: 200, body: "ok" };
  } catch (err) {
    // Split by ONE question: can a retry possibly help?
    //
    // Both of these classes are provably retry-proof. The event bytes are
    // immutable, so a payload this endpoint cannot act on will not become
    // actionable on the fourth delivery of the same bytes; and a deleted
    // workspace is not coming back. Retrying either for three days achieves
    // nothing — and, worse than nothing, feeds the consecutive-failure run
    // that makes Stripe disable the endpoint. Losing the endpoint would lose
    // every LATER event too, including the cancellations this file exists to
    // apply. So they are acknowledged with a 200.
    //
    // 200 does not mean "ignore": each one is logged at ERROR, because an
    // event this endpoint could not attribute may be a payment owed a
    // customer, and with no retry left to surface it the log line is the only
    // thing that will. ERROR specifically, because that is what a GCP alerting
    // policy fires on.
    //
    // Everything else — a Firestore blip, transaction contention exhausted, an
    // unexpected throw — keeps the 500. Those are exactly the cases where
    // retrying IS the fix, and where a 2xx would discard a verified event.
    //
    // The two classes are named individually rather than matched on their
    // shared `StripeWebhookError` base, so that adding a third subclass has to
    // make this decision explicitly instead of inheriting "unretryable".
    const unretryable =
      err instanceof StripeWebhookPayloadError || err instanceof UnknownWorkspaceError;
    logger.error(
      unretryable
        ? "stripeWebhook: verified delivery can never be applied; acknowledging it rather than risking the endpoint"
        : "stripeWebhook: verified delivery could not be applied; asking Stripe to retry",
      {
        eventType: event.type,
        eventId: event.id,
        errorName: err instanceof Error ? err.name : typeof err,
        // Only messages this file authored. A third-party error's message could
        // contain anything, including a connection string.
        detail: err instanceof StripeWebhookError ? err.message : undefined,
        retryRequested: !unretryable,
      }
    );
    return unretryable
      ? { status: 200, body: "acknowledged" }
      : { status: 500, body: "could not process event" };
  }
}

/**
 * The binding. Thin by design: verification and dispatch live in
 * `handleStripeWebhook`, the transaction in `applyStripeEventTransactionally`.
 *
 * `invoker: "public"` is stated explicitly rather than left to the platform
 * default because it is a real decision, not an oversight: Stripe's servers
 * carry no Google identity, so the endpoint has to accept unauthenticated
 * POSTs, and the HMAC signature over the raw body is the ONLY thing
 * authenticating a caller. That is why the raw-body and tolerance details
 * above are security-relevant and not merely fussy.
 *
 * There is nothing registered on the Stripe side to send deliveries here, and
 * STRIPE_WEBHOOK_SECRET does not exist yet — a webhook signing secret is
 * issued when the endpoint is registered. Until both are done this function
 * deploys and answers 500 ("not configured") to anything that reaches it.
 */
export const stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET], invoker: "public" },
  async (req: Request, res) => {
    // STRIPE_SECRET_KEY is bound because `constructEvent` hangs off a Stripe
    // client instance, which is what `stripeClient` builds. The API key plays
    // no part in verifying a signature — that is pure HMAC over the raw body
    // with the WEBHOOK signing secret — and this function makes no Stripe API
    // call, so an unset key would not break verification. It is read here to
    // keep client construction in one place (functions/src/billing/stripe.ts)
    // rather than hand-rolling a second one.
    const verifier = stripeClient(STRIPE_SECRET_KEY.value()).webhooks;
    const reply = await handleStripeWebhook(
      req,
      {
        webhookSecret: STRIPE_WEBHOOK_SECRET.value(),
        verifier,
        apply: (event, now) => applyStripeEventTransactionally(getFirestore(), event, now),
      },
      Date.now()
    );
    res.status(reply.status).send(reply.body);
  }
);
