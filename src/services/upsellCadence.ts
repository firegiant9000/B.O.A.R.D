import AsyncStorage from "@react-native-async-storage/async-storage";
import type { UpsellResource, UpsellVariant } from "../components/upsellCopy";

// How often a user has already been shown the plan-limit notice for a given
// gate, and therefore how hard this one should push. ROADMAP.md:608 (item 14)
// is binding: "Skip on first attempt; harder push on second." Read literally,
// "skip" means showing nothing at all the first time — that was considered and
// rejected, because a user who hits the board cap and gets a silent failure
// with no explanation reads it as a bug rather than as restraint. What ships
// instead:
//
//   - first attempt at a gate  -> "soft":  name the limit, explain what
//                                          happened, offer nothing else.
//   - second and later         -> "hard":  today's full modal.
//
// This is PRESENTATION CADENCE ONLY. Nothing here decides what is allowed —
// the quota path (src/services/quotaService.ts, and the server-side gates in
// functions/src/ai/usage.ts) has already denied the action by the time any of
// this runs. Changing these numbers changes how a denial is worded, never
// whether it happens.
//
// WHY DEVICE-LOCAL, NOT SERVER-BACKED. The count lives in AsyncStorage rather
// than on the user's Firestore document because it is cosmetic. A Firestore
// read plus a write on every gate hit would buy cross-device consistency for a
// decision about tone, at the cost of billable operations and a network round
// trip on a path the user is already annoyed to be on. The honest costs of
// that choice, both of which are accepted rather than unnoticed:
//
//   1. A user on two devices gets the soft notice once on each, so their
//      genuine second encounter with a gate is presented as their first.
//   2. The inverse, on a shared device: this key is NOT scoped by uid, the way
//      src/components/onboarding/onboardingStorage.ts and
//      src/lib/pinnedBoards.ts scope theirs. On the shared classroom tablets
//      those two modules were written for, the second person to sign in
//      inherits the first person's count and can be pushed hard on a gate they
//      have never personally hit. Scoping by uid would fix that and cost only
//      threading a uid through; it is left out here because the cadence
//      decision was specified as per-device, and because the board screen's
//      uid is `""` for embed sessions, which would give every anonymous embed
//      viewer one shared bucket anyway. Worth revisiting if the tablet case
//      becomes real.
//
// FAILS SOFT, NEVER CLOSED. Every storage error resolves to "soft". A broken
// or unavailable store must never be the thing that escalates someone to the
// full sell, and nothing in this module ever rejects — the caller is on a
// render path.

/**
 * The attempt number at which the notice stops being gentle. `2` is
 * ROADMAP.md:608's "harder push on second", named rather than inlined so the
 * counter's saturation point below and the escalation test cannot drift apart.
 */
export const HARD_PUSH_AT_ATTEMPT = 2;

const key = (resource: UpsellResource) => `@board/upsellAttempt:${resource}`;

/**
 * Reads a stored counter back. Returns 0 — "no prior attempt", i.e. the gentle
 * answer — for anything that cannot be a count we wrote.
 *
 * `Number`, not `parseInt`: `parseInt("1.9")` is `1` and `parseInt("7abc")` is
 * `7`, so a partially-garbage value would be silently accepted as a real count
 * and could escalate someone on their genuine first attempt. A value that
 * merely exceeds what this build writes (a larger count from a future build)
 * is NOT garbage and is honoured, which is why this can't just reject anything
 * outside the range this build produces.
 */
function parseAttemptCount(raw: string | null): number {
  if (raw === null) return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Records one encounter with `resource`'s gate and resolves how this one
 * should be presented. Counters are per-resource and independent: burning the
 * AI-call allowance twice must not make the first session-cap notice a hard
 * push, because that gate is genuinely new to the user.
 *
 * Never rejects. Callers are render paths that set component state from the
 * result; a throw here would surface as an unhandled rejection in the middle
 * of a quota denial the user is already dealing with.
 */
export async function recordUpsellAttempt(resource: UpsellResource): Promise<UpsellVariant> {
  let prior: number;
  try {
    prior = parseAttemptCount(await AsyncStorage.getItem(key(resource)));
  } catch {
    // Read failed, so the real count is unknown. Return the gentle answer AND
    // write nothing: overwriting with "1" here would let a transient read
    // error silently reset a user's cadence, handing them an extra soft notice
    // every time the store hiccuped. Doing nothing leaves the stored count
    // intact for the next attempt, which is the one that can still escalate.
    return "soft";
  }

  // Saturating, not unbounded. Nothing distinguishes a third encounter from a
  // thirtieth — both are "hard" — so the counter stops at the threshold. That
  // keeps the stored value bounded, and (below) lets a user who keeps hitting
  // the same gate stop writing to disk entirely.
  const next = Math.min(prior + 1, HARD_PUSH_AT_ATTEMPT);
  if (next > prior) {
    try {
      await AsyncStorage.setItem(key(resource), String(next));
    } catch {
      // Best-effort, exactly like onboardingStorage's own persist. A failed
      // write just means this attempt isn't remembered, so the user may get
      // one more gentle notice than they strictly should — the safe direction
      // to fail in.
    }
  }

  return next >= HARD_PUSH_AT_ATTEMPT ? "hard" : "soft";
}
