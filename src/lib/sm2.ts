/**
 * SuperMemo SM-2 spaced-repetition algorithm
 *
 * Month 6 — scheduling implementation for the study system. Pure arithmetic,
 * no I/O, no side effects. Time comes in as a parameter so reviews are
 * deterministic and testable.
 */

export const MIN_EASE = 1.3;

/** A study card with its current scheduling state.
 *
 *  Month 6 — Callers loading cards from storage must validate that all numeric
 *  fields (repetitions, intervalDays, easeFactor, dueAtMs) are finite. If passed
 *  a corrupted card with NaN for easeFactor, `review()` does not catch it;
 *  Math.max(1.3, NaN) silently returns NaN, which propagates into the returned
 *  ease, interval and due date. Validation is the caller's responsibility. */
export interface Card {
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  dueAtMs: number;
}

export const INITIAL_CARD: Card = Object.freeze({
  repetitions: 0,
  intervalDays: 0,
  easeFactor: 2.5,
  dueAtMs: 0,
});

/**
 * Schedules the next review for a card using the SM-2 algorithm.
 *
 * Quality scale: 0 = complete blackout, 5 = perfect response
 * Quality < 3 resets the card; >= 3 advances the schedule.
 *
 * Ease factor is updated by the formula:
 *   EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))
 * and floored at MIN_EASE (1.3).
 *
 * Intervals follow the pattern: 1 day, 6 days, then previous * new_EF (rounded).
 *
 * Caller must ensure the input card's numeric fields are finite (not NaN or
 * Infinity); this function does not validate them. See Card interface docs.
 */
export function review(card: Card, quality: number, now: number): Card {
  // Validate quality: must be integer 0-5, not NaN or Infinity
  if (!Number.isFinite(quality) || !Number.isInteger(quality) || quality < 0 || quality > 5) {
    throw new Error("Quality must be an integer between 0 and 5");
  }

  // Calculate new ease factor using SM-2 formula
  const delta = (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const newEF = Math.max(MIN_EASE, card.easeFactor + (0.1 - delta));

  // Quality < 3: reset the card
  if (quality < 3) {
    return {
      repetitions: 0,
      intervalDays: 1,
      easeFactor: newEF,
      dueAtMs: now + 1 * 86_400_000,
    };
  }

  // Calculate new interval based on repetition count
  let newInterval: number;
  if (card.repetitions === 0) {
    newInterval = 1;
  } else if (card.repetitions === 1) {
    newInterval = 6;
  } else {
    // Third review and beyond: multiply previous interval by new ease factor
    newInterval = Math.round(card.intervalDays * newEF);
  }

  return {
    repetitions: card.repetitions + 1,
    intervalDays: newInterval,
    easeFactor: newEF,
    dueAtMs: now + newInterval * 86_400_000,
  };
}
