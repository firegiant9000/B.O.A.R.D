import { PLAN_LIMITS, UNLIMITED, type PlanLimits } from "./planLimits";
import type { Plan } from "../types";

// Shared, price-bearing pricing copy — read by BOTH web-only billing
// surfaces: the pricing page (app/pricing.web.tsx) and the web upsell modal
// (src/components/UpsellModal.tsx). Consolidated into one file so those two
// surfaces can never drift into quoting two different placeholder prices —
// the same reasoning the plan gives for limits ("a page that disagrees with
// the enforced limits is worse than no page") applies just as much to price.
//
// This module must NEVER be imported by src/components/UpsellModal.native.tsx
// or src/components/upsellCopy.ts — see UpsellModal.native.tsx's own header
// comment for the store-compliance invariant (no price, no checkout
// affordance, reachable from a native build) this file's PRICE constant
// would violate if it ever reached that file's import graph.
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
  tagline: string;
  features: string[];
  /** Only Pro carries a checkout action. Free is what a new workspace
   *  already starts on (src/services/workspaceService.ts#createWorkspace
   *  defaults to `plan: "free"`, and firestore.rules reject a client
   *  stamping anything else), so there is nothing to "subscribe" to. Edu is
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
