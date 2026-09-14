import { PLAN_LIMITS, UNLIMITED, type PlanLimits } from "./planLimits";
import type { Plan } from "../types";

// Shared, price-bearing pricing copy — read by BOTH web-only billing
// surfaces: the pricing page (app/pricing.tsx renders
// src/components/PricingBody.tsx on web) and the web upsell modal
// (src/components/UpsellModal.tsx). Consolidated into one file so those two
// surfaces can never drift into quoting two different placeholder prices —
// the same reasoning the plan gives for limits ("a page that disagrees with
// the enforced limits is worse than no page") applies just as much to price.
//
// This module must NEVER be imported by src/components/UpsellModal.native.tsx,
// src/components/PricingBody.native.tsx, or src/components/upsellCopy.ts —
// see UpsellModal.native.tsx's own header comment for the store-compliance
// invariant (no price, no checkout affordance, reachable from a native
// build) this file's PRICE constant would violate if it ever reached any of
// those files' import graphs. Guarded by tests in
// src/lib/__tests__/pricingCopy.test.ts and
// src/components/__tests__/PricingBody.test.tsx.
//
// Every LIMIT figure below is read from PLAN_LIMITS (src/lib/planLimits.ts),
// never retyped as a literal — see describeCount/planFeatures. The one
// figure that genuinely cannot come from that table is the price, because no
// business decision has been made yet (Gate G4 is unmet) — see
// PENDING_PRO_PRICE_LABEL.

// PLACEHOLDER — Gate G4 (pricing) is unmet; no price has been approved by
// the business. This constant is not a pricing decision made here; it
// exists so the UI has something concrete to render instead of a blank
// space, clearly named and commented as pending. Both web billing surfaces
// import this SAME constant (rather than each declaring their own
// placeholder) so a future price change is a one-line edit, not a hunt
// across files that may have drifted apart in the meantime.
export const PENDING_PRO_PRICE_LABEL = "$5/month";

/** User-VISIBLE caveat shown beside the Pro price on the pricing page —
 *  deliberately not left as a code comment nobody but a developer reads. A
 *  pricing page is exactly the surface where an unqualified number reads as
 *  a done deal; this string exists so it doesn't. Update alongside
 *  PENDING_PRO_PRICE_LABEL once a real price is approved (Gate G4). */
export const PRICE_PROVISIONAL_NOTE = "Pricing is provisional and not final.";

/** Whether Stripe checkout is actually live. Hard-coded `false` — this is
 *  NOT an environment-configurable flag (there is exactly one Stripe
 *  account this app will ever have, or none), just a single switch flipped
 *  by hand once Gate G3 (a real Stripe account: an API key, a product, a
 *  live price, a registered webhook — see src/services/billingService.ts's
 *  module header) is actually met. Consumers (src/components/
 *  PricingBody.tsx) must gate the checkout CTA on this rather than
 *  presenting a button that looks like a working purchase when nothing is
 *  behind it — the account not existing is a fact about the world, not a
 *  per-deploy setting, so this is not read from `EXPO_PUBLIC_*`. */
export const BILLING_LIVE = false;

/** Whether the Pro checkout action may actually be pressed. Pure function
 *  (no rendering) so both branches are unit-testable directly, including
 *  the one — `billingLive: true` — that today's real `BILLING_LIVE` never
 *  reaches: this precedence is meant to already be correct for the day
 *  `BILLING_LIVE` flips, not just for today's `false`. */
export function canCheckoutNow(billingLive: boolean, hasWorkspace: boolean): boolean {
  return billingLive && hasWorkspace;
}

/** The Pro card's checkout button label for the given state. "Not live" is
 *  checked before "no workspace" because it's the more fundamental
 *  blocker — independent of which workspace (if any) is active, there is
 *  still no Stripe account for a checkout to reach (Gate G3). Never returns
 *  a label that reads as a working purchase unless `canCheckoutNow` for the
 *  same two inputs is also true. */
export function checkoutCtaLabel(billingLive: boolean, hasWorkspace: boolean): string {
  if (!billingLive) return "Checkout isn't available yet";
  if (!hasWorkspace) return "Sign in to a workspace to upgrade";
  return "Upgrade to Pro";
}

/** Renders a PLAN_LIMITS count as display copy, spelling out the UNLIMITED
 *  sentinel (`Number.POSITIVE_INFINITY` — see planLimits.ts) as the word
 *  "Unlimited" rather than the raw number: `String(Infinity)` is
 *  `"Infinity"`, and a pricing page that printed that would be a visible
 *  defect. */
function describeCount(value: number, singular: string, plural: string): string {
  if (value === UNLIMITED) return `Unlimited ${plural}`;
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * One plan's feature list, built ENTIRELY from `PLAN_LIMITS[plan]` — no
 * figure here is a retyped literal, so this can never quietly drift from
 * what the plan table actually says (which is as far as "agreement" can
 * go for `workspaces`; see the omission below).
 *
 * Two deliberate choices, both required reading before touching this list:
 *  - `workspaces` is NOT rendered anywhere. `PLAN_LIMITS[plan].workspaces`
 *    exists as a number, but nothing enforces it: firestore.rules permits
 *    unlimited workspace creation, and rules have no way to count a user's
 *    existing workspaces to deny a create. Listing "1 workspace" here would
 *    be a claim this app does not back up — the same omission already made
 *    in app/ai-usage.tsx's usage dashboard.
 *  - `collaboratorsPerBoard` is phrased "per board", never "per workspace"
 *    or bare "collaborators" — the cap genuinely applies board-by-board
 *    (each board's own `roles` map), not to a workspace's total membership.
 */
export function planFeatures(plan: Plan): string[] {
  const limits: PlanLimits = PLAN_LIMITS[plan];
  return [
    describeCount(limits.boards, "board", "boards"),
    describeCount(limits.sessionsPerPeriod, "session per month", "sessions per month"),
    describeCount(limits.aiCallsPerPeriod, "AI call per month", "AI calls per month"),
    `${describeCount(limits.collaboratorsPerBoard, "collaborator", "collaborators")} per board`,
  ];
}

export interface PlanCardCopy {
  id: Plan;
  label: string;
  priceLabel: string;
  /** User-visible caveat rendered directly beside `priceLabel`. Only the
   *  Pro card carries one today — Free's "Free" and Edu's "Granted to
   *  verified schools" are not numeric placeholders needing a caveat. */
  priceNote?: string;
  tagline: string;
  features: string[];
  /** Only Pro carries a checkout action. Free is what a new workspace
   *  already starts on (the `createWorkspace` callable stamps `plan: "free"`
   *  on every workspace it writes, and firestore.rules deny a client create
   *  outright), so there is nothing to "subscribe" to. Edu is
   *  granted out of band by an operator, never through Stripe — the webhook
   *  deliberately never writes `plan: "edu"` in either direction
   *  (functions/src/http/stripeWebhook.ts#decidePlanWrite) — so a
   *  self-serve button on that card would point at a checkout flow that
   *  cannot grant it. */
  ctaLabel?: string;
}

/** Free listed first (honest default: it's what every workspace already
 *  has), then Pro (the only plan this page can actually sell), then Edu
 *  (informational only — see PlanCardCopy.ctaLabel). */
export const PLAN_CARDS: PlanCardCopy[] = [
  {
    id: "free",
    label: "Free",
    priceLabel: "Free",
    tagline: "Get started — no payment required.",
    features: planFeatures("free"),
  },
  {
    id: "pro",
    label: "Pro",
    priceLabel: PENDING_PRO_PRICE_LABEL,
    priceNote: PRICE_PROVISIONAL_NOTE,
    tagline: "For teams that have outgrown the free limits.",
    features: planFeatures("pro"),
    ctaLabel: "Upgrade to Pro",
  },
  {
    id: "edu",
    label: "Edu",
    priceLabel: "Granted to verified schools",
    tagline: "For verified schools and classrooms — granted by BOARD, not purchased here.",
    features: planFeatures("edu"),
  },
];
