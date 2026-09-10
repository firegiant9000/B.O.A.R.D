import { doc, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../config/firebase";
import type { Subscription, SubscriptionStatus } from "../types";

// Month 5/6 — the client-side seam for billing. UI components call these
// functions, never Firestore or a callable directly (Global Constraint).
// The billing UI tasks consume `startCheckout`, `openBillingPortal` and
// `getSubscription`.
//
// The Stripe Customer Portal (opened via `openBillingPortal`) is where a
// customer cancels or changes their payment method — this file, and nothing
// in this app, implements a cancellation UI of its own.
//
// NOT LIVE. There is no Stripe account behind this repo: no API key, no
// product, no price, and no registered webhook endpoint. `startCheckout` and
// `openBillingPortal` are written and unit-tested against a mocked callable
// only — the real redirect (a client actually landing on Stripe's hosted
// Checkout / Customer Portal pages) has never been exercised. `getSubscription`
// reads Firestore directly and needs no Stripe account to verify; it is
// tested against fixtures shaped like `SubscriptionState`
// (functions/src/http/stripeWebhook.ts), not against a real written document.

/** Maps a raw `workspaces/{id}/billing/subscription` doc to the typed
 *  `Subscription`, tolerating missing fields so a partially-written or
 *  older-shape doc never throws (mirrors `mapUsageDoc` in
 *  src/services/aiUsageService.ts — the Global Constraints' cited
 *  precedent). Returns `null` only when the document itself does not exist;
 *  an existing-but-empty object still maps to a (maximally defaulted)
 *  Subscription, not null.
 *
 *  `data == null` (not `=== undefined`) so a runtime `null` — from a caller
 *  outside TypeScript's view, or a `snap.data()` that returns `null` rather
 *  than `undefined` — is treated the same as a missing doc instead of
 *  reaching `data.status` and throwing. That throw is exactly what the
 *  tolerant-reader convention this function follows exists to prevent.
 *
 *  `status` is passed through as-is rather than validated against
 *  `SubscriptionStatus` — the stored field is written by the webhook from
 *  Stripe's raw status string, which carries values this narrowed client
 *  type does not name ("trialing", "unpaid", "paused",
 *  "incomplete_expired", ...). A status this app doesn't recognize reads as
 *  itself rather than being coerced, and `isEntitledToPro` below denies
 *  anything it doesn't explicitly grant. A missing `status` field defaults
 *  to "incomplete" — the least-entitled value — rather than "active", so a
 *  corrupt/partial doc fails closed. */
export function mapSubscriptionDoc(
  data: Record<string, any> | null | undefined
): Subscription | null {
  if (data == null) return null;
  return {
    schemaVersion: 1,
    status: (data.status as SubscriptionStatus | undefined) ?? "incomplete",
    stripeCustomerId: data.stripeCustomerId ?? "",
    stripeSubscriptionId: data.stripeSubscriptionId ?? "",
    // `?? 0`: the stored field is `number | null` and a stored `null` is a
    // legitimate, expected value (see the doc comment on `Subscription` in
    // src/types/index.ts), not an error — 0 is the "unknown renewal date"
    // sentinel this app never produces as a real Stripe timestamp.
    currentPeriodEndMs: data.currentPeriodEndMs ?? 0,
  };
}

/** Whether `sub` currently entitles its workspace to Pro features, as of
 *  `nowMs`. Deny-unless-provably-permitted (Global Constraints): only
 *  "active", "trialing", and "past_due" strictly before its recorded period
 *  end, grant anything — every other status (including "incomplete", a
 *  status this union doesn't otherwise name, or a `null` subscription)
 *  denies.
 *
 *  "trialing" MUST grant: the webhook's own `PRO_STATUSES`
 *  (functions/src/http/stripeWebhook.ts) is `{active, trialing}` and writes
 *  `plan: "pro"` for a trialing subscription — so the server already treats
 *  a trialing workspace as fully Pro. If this function denied it, a
 *  trialing customer would be shown an upgrade prompt for a plan they
 *  already have. `status` is widened to `string` for this comparison
 *  because "trialing" is one of the raw Stripe values `mapSubscriptionDoc`
 *  passes through untouched (see its doc comment) but is not a member of
 *  the 4-value `SubscriptionStatus` union, so comparing the narrowed type
 *  directly against the "trialing" literal would be a compile error
 *  (TS2367: no overlap) even though the runtime value is real.
 *
 *  `nowMs < sub.currentPeriodEndMs` also denies on an unknown renewal date
 *  (`currentPeriodEndMs === 0`, see `mapSubscriptionDoc`): comparing any
 *  realistic epoch-ms `nowMs` against 0 is false, so a past_due subscription
 *  with no recorded period end does not silently get a grace window it
 *  cannot be shown to still be inside. This function is not currently wired
 *  into any UI gate in this task — the billing UI tasks are the consumers —
 *  but it is written to the same fail-closed discipline the Cloud Function
 *  gates use (functions/src/callable/createBoard.ts, createSession.ts). */
export function isEntitledToPro(sub: Subscription | null, nowMs: number): boolean {
  if (sub === null) return false;
  const status: string = sub.status;
  if (status === "active" || status === "trialing") return true;
  if (status === "past_due") return nowMs < sub.currentPeriodEndMs;
  return false;
}

/** Whether `sub.currentPeriodEndMs` is a real Stripe renewal timestamp
 *  rather than the "unknown" sentinel (`0` — see `mapSubscriptionDoc`).
 *  `new Date(0).toLocaleDateString()` succeeds with no throw, no
 *  `Invalid Date`, and no `undefined` to trip an optional chain — so a
 *  "Renews on {date}" row that formats `currentPeriodEndMs` directly would
 *  render 1 January 1970 with total confidence instead of visibly failing.
 *  Consumers should branch on this named predicate rather than comparing
 *  against the magic number themselves. */
export function hasKnownRenewalDate(sub: Subscription): boolean {
  return sub.currentPeriodEndMs !== 0;
}

/** Reads the workspace's subscription state, or `null` if it has never had
 *  one (the ordinary case for a workspace that has never paid).
 *
 *  Reads the SINGLE document `workspaces/{id}/billing/subscription` —
 *  deliberately NOT `collection('billing').get()`. The webhook
 *  (functions/src/http/stripeWebhook.ts) also stores one idempotency record
 *  per applied Stripe event in that same `billing` subcollection, and that
 *  set grows without bound over the workspace's lifetime; a collection read
 *  would pull every one of those records alongside the single document this
 *  function actually wants, and get slower every month. firestore.rules
 *  permits this read to the workspace owner/admin and denies every client
 *  write, so this function never writes. */
export async function getSubscription(workspaceId: string): Promise<Subscription | null> {
  const snap = await getDoc(doc(db, "workspaces", workspaceId, "billing", "subscription"));
  return mapSubscriptionDoc(snap.exists() ? (snap.data() as Record<string, any>) : undefined);
}

interface CheckoutSessionResponse {
  url: string;
}

/** Thrown by `startCheckout`/`openBillingPortal` when the callable rejects.
 *  Preserves the callable's `code` (e.g. `"failed-precondition"`) and
 *  `details` — such as `{ reason: "subscription-exists", canOpenPortal:
 *  true }` from the double-checkout guard in
 *  functions/src/callable/createCheckoutSession.ts, or `{ reason:
 *  "subscription-paused", canOpenPortal: false }` — instead of collapsing
 *  every rejection into a bare `Error(message)` the way this seam used to.
 *  A UI can branch on `.details?.reason`/`.details?.canOpenPortal` rather
 *  than regex-matching `.message`, which is all a plain `Error` leaves it. */
export class BillingCallableError extends Error {
  code?: string;
  details?: unknown;
  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "BillingCallableError";
    this.code = code;
    this.details = details;
  }
}

/** Starts a Stripe Checkout session for the workspace's Pro upgrade and
 *  returns the URL to redirect the client to. All plan/eligibility checks —
 *  including the double-checkout guard that refuses a second live
 *  subscription — run server-side in
 *  functions/src/callable/createCheckoutSession.ts; this wrapper does not
 *  duplicate them (Global Constraint: a client-side check is advisory only,
 *  never the enforcement point). */
export async function startCheckout(workspaceId: string): Promise<string> {
  const callable = httpsCallable<{ workspaceId: string }, CheckoutSessionResponse>(
    functions,
    "createCheckoutSession"
  );
  try {
    const { data } = await callable({ workspaceId });
    if (!data?.url) throw new Error("Stripe did not return a checkout URL.");
    return data.url;
  } catch (e: any) {
    // Surfaces the function's HttpsError message (failed-precondition,
    // permission-denied, ...) AND its `code`/`details`, rather than
    // collapsing the rejection into a message-only `Error` — see
    // `BillingCallableError`.
    throw new BillingCallableError(e?.message ?? "Failed to start checkout.", e?.code, e?.details);
  }
}

interface PortalSessionResponse {
  url: string;
}

/** Opens the Stripe Customer Portal for the workspace and returns the URL to
 *  redirect the client to. This is where a customer cancels their
 *  subscription or changes their payment method — this app builds no
 *  cancellation UI of its own; the portal is that UI. */
export async function openBillingPortal(workspaceId: string): Promise<string> {
  const callable = httpsCallable<{ workspaceId: string }, PortalSessionResponse>(
    functions,
    "createPortalSession"
  );
  try {
    const { data } = await callable({ workspaceId });
    if (!data?.url) throw new Error("Stripe did not return a billing portal URL.");
    return data.url;
  } catch (e: any) {
    throw new BillingCallableError(
      e?.message ?? "Failed to open the billing portal.",
      e?.code,
      e?.details
    );
  }
}
