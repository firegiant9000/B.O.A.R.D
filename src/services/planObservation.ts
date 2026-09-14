import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Plan } from "../types";
import { track } from "./analyticsService";

// Month 6 — the client half of ROADMAP.md:685's `upgrade_completed`.
//
// WHAT THIS EVENT HONESTLY IS. It records that this client OBSERVED a
// workspace's `plan` change from unpaid to Pro. It is NOT a confirmed payment,
// and nothing here has seen one. The authoritative completion signal is written
// server-side by the Stripe webhook (functions/src/http/stripeWebhook.ts); this
// module only watches the resulting field on the workspace document. That is
// the only seam available client-side, because as
// functions/src/callable/createCheckoutSession.ts:16-17 states plainly, "There
// is no Stripe account behind this yet — no product, no live price, no webhook
// endpoint — so no payment actually completes anywhere today." Until that gate
// is met, this event CANNOT be verified end-to-end by anyone: there is no
// payment to make, so there is no transition to watch. Read the number it
// produces as "clients that saw a workspace become Pro", never as "purchases".
//
// THE FAILURE MODE THIS MODULE EXISTS TO PREVENT is over-counting, and it is
// not a matter of noise. "If the plan is Pro, emit" fires on every app start
// for every paying customer forever, so the series it produces is a count of
// how often paying customers open the app — retention — reported under the name
// `upgrade_completed`. A conversion metric that goes UP when nobody converts is
// worse than no metric, because it reads as success. Two independent rules stop
// that, and both are pinned by planObservation.test.ts:
//
//   1. NEVER ON FIRST SIGHT. A workspace this device has never observed before
//      reports nothing, whatever its plan. No transition was witnessed, so
//      none is claimed. This is what excludes an existing paying customer
//      installing on a new device — and, less obviously, every EXTRA workspace
//      a Pro owner creates, since functions/src/callable/createWorkspace.ts's
//      `resolveOwnerPlan` makes such a workspace be born "pro" rather than
//      upgraded into it.
//   2. AT MOST ONCE PER WORKSPACE, EVER. A durable marker, written before the
//      event is emitted, makes a second emission impossible for that workspace
//      even across an app restart, a downgrade, and a later re-subscription.
//
// The disclosed cost of rule 2: a genuine win-back (Pro -> free -> Pro) is
// counted once, not twice. Accepted — a metric that can only under-report is
// recoverable from the billing data; one that silently inflates is not.
//
// KEYED BY WORKSPACE, AND DELIBERATELY *NOT* ALSO BY UID — which is the
// opposite of what src/services/upsellCadence.ts does with its own AsyncStorage
// marker, so the difference is worth being explicit about. That module keys by
// uid because this app runs on shared classroom tablets
// (src/components/onboarding/onboardingStorage.ts and src/lib/pinnedBoards.ts
// both say so) and how hard to push a SPECIFIC PERSON is a per-person fact. The
// fact recorded here is a property of the WORKSPACE, not of whoever happened to
// be signed in when it changed. Adding uid to this key would make two members
// of one workspace signing in on the same tablet each report the same single
// conversion — reintroducing the exact double-count this module exists to
// prevent, on the shared-device path where it is most likely. Sharing the
// marker between accounts on one device leaks nothing: it records only that a
// workspace id was seen on a given plan, and every member of that workspace can
// already read its plan.
//
// DEVICE-LOCAL, like upsellCadence's counter and for the same reasons, with the
// same honest cost stated rather than hidden: one workspace converting while
// two of its members' devices are both watching is reported twice. Fixing that
// properly means emitting from the webhook server-side, which is the correct
// end state and is blocked behind the same unmet Stripe gate as everything else
// here. It is not worth a Firestore read-plus-write on every app start to
// half-fix it client-side.
//
// NEVER REJECTS, AND FAILS *CLOSED* ON THE EMIT. Callers are render effects, so
// a throw here would surface as an unhandled rejection during an ordinary app
// start. Every storage error resolves to "do nothing". Note the asymmetry with
// upsellCadence, which fails soft toward its gentler answer: here the marker is
// written FIRST and the event is emitted only if that write succeeded, because
// the cheap error is losing one conversion and the expensive one is emitting an
// event that can never be marked and therefore repeats on every launch.

/** Last plan this device saw for a workspace. Absent means "never observed",
 *  which is a meaningful state here (see rule 1 above), not merely "empty". */
const seenKey = (workspaceId: string) => `@board/planSeen:${workspaceId}`;

/** Set once `upgrade_completed` has been emitted for a workspace. Its presence
 *  is the whole of the permanent dedupe; its value is never read. */
const firedKey = (workspaceId: string) => `@board/upgradeReported:${workspaceId}`;

const PLANS: readonly Plan[] = ["free", "pro", "edu"];

/**
 * Reads a stored plan back. Returns null — "never observed", i.e. the silent
 * answer — for anything that cannot be a plan we wrote. Membership against the
 * real union rather than a shape check: a value that isn't one of these cannot
 * be reasoned about as a transition at all, and guessing would be the one
 * mistake this module cannot afford.
 */
function parsePlan(raw: string | null): Plan | null {
  return raw !== null && (PLANS as readonly string[]).includes(raw) ? (raw as Plan) : null;
}

/**
 * Whether `plan` is one a workspace can only reach by paying. Only "pro"
 * qualifies: "edu" is granted out of band by an operator and is never reachable
 * through self-serve checkout — createCheckoutSession resolves STRIPE_PRO_PRICE_ID
 * and nothing else, and stripeWebhook.ts:494 refuses to move an edu workspace at
 * all. Counting an edu grant as a completed upgrade would mix operator
 * decisions into the paid-conversion number ROADMAP.md's exit criteria ("3+
 * paying") is read from.
 */
function isPaid(plan: Plan): boolean {
  return plan === "pro";
}

/**
 * Records `plan` as this device's latest observation of `workspaceId` and, the
 * first time that observation is a transition from unpaid to paid, emits
 * `upgrade_completed` exactly once for that workspace, forever.
 *
 * Safe to call on every workspace resolve — it writes only when the observed
 * plan actually differs from the stored one, and short-circuits on a single
 * read once a workspace has already been reported.
 *
 * Never rejects. See this module's header for what the event does and does not
 * mean, and why it fails closed rather than soft.
 */
export async function observeWorkspacePlan(
  workspaceId: string,
  plan: Plan
): Promise<void> {
  // An embed identity has no workspace of its own, and a caller mid-load may
  // have no id yet. Neither is an anonymous bucket: with no workspace there is
  // nothing to deduplicate against, so a shared fallback key would pool
  // unrelated workspaces into one marker and report the first of them only.
  if (!workspaceId) return;

  try {
    // One read on the common path for a workspace already reported: once the
    // marker exists nothing below can change any outcome.
    if (await AsyncStorage.getItem(firedKey(workspaceId))) return;

    const seen = parsePlan(await AsyncStorage.getItem(seenKey(workspaceId)));

    if (seen !== plan) {
      await AsyncStorage.setItem(seenKey(workspaceId), plan);
    }

    // `seen === null` is rule 1: never on first sight. It is deliberately NOT
    // folded into `!isPaid(seen)` via a default of "free" — that default is
    // precisely the bug, since it would assert a free-to-Pro transition for
    // every workspace this device is merely meeting for the first time.
    if (seen === null || isPaid(seen) || !isPaid(plan)) return;

    // Marker before event: see the header's fail-closed note. A rejection here
    // leaves the emit unreached, and the next observation retries the whole
    // decision from a still-consistent store.
    await AsyncStorage.setItem(firedKey(workspaceId), "1");

    // Both properties are closed unions from src/types — no raw workspace id,
    // no uid, nothing a user authored. The workspace id appears only in the
    // device-local storage keys above, never in an event.
    track("upgrade_completed", { fromPlan: seen, toPlan: plan });
  } catch {
    // Storage unavailable, storage full, or the seam itself threw. Report
    // nothing and leave whatever is on disk intact: a transient error must
    // neither invent a conversion nor destroy the record that prevents one
    // being invented later.
  }
}
