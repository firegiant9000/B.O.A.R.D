// Presenter mode precedence (Month 5/6 Task 14). Pure so it's unit-testable
// without a live cursor subscription — mirrors the style of
// `src/lib/followMode.ts`, which it composes with rather than replaces: this
// module does not itself guard against a follow cycle. `wouldCreateCycle`
// still runs wherever `followingId` is chosen/kept (`src/hooks/useBoardCollab.ts`),
// independent of presenter state.
//
// `resolveViewportSource` is a cross-task contract: both the laser-pointer
// task and the follow-mode camera driver in `useBoardCollab.ts` read it, so
// its signature and precedence are fixed here.

/** The minimum cursor shape this module needs to resolve precedence. */
export interface PresenterCursor {
  userId: string;
  /** True while this author is presenting to the whole board. */
  presenting?: boolean;
  /** True while the presenter above has paused (releases viewports). */
  presenterPaused?: boolean;
}

/**
 * Resolve whose viewport (if anyone's) `selfUid`'s camera should mirror right
 * now.
 *
 * Precedence:
 *  1. An unpaused, active presenter — anyone but the caller — overrides every
 *     individual follow choice, including "following nobody".
 *  2. A paused presenter releases viewport control: this function falls
 *     through to case 3 exactly as if there were no presenter. (The
 *     presenter's *identity*, so an audience banner can stay up through the
 *     pause, is a separate, stateful concern this pure function does not
 *     carry — a function returning one viewport-source id can't also carry
 *     "but keep showing a banner for someone else". See the long comment on
 *     `useBoardCollab`'s cursor-subscription effect for where that lives.)
 *  3. With no active, unpaused presenter, the caller's individual follow
 *     choice applies — but only if that target actually has a live cursor in
 *     `cursors`. An absent target has no viewport to mirror, so there is
 *     nothing to resolve to.
 *  4. `wouldCreateCycle` is not consulted here: it guards the *act* of
 *     choosing to follow someone, not this read-time precedence resolution.
 *     It still runs at the point `followingId` is set/kept.
 *
 * `cursors` is expected to already be filtered for staleness by the caller (a
 * cursor doc idle past `CURSOR_STALE_MS` is the subscriber's job to drop
 * before calling this) — this function does no time-based filtering of its
 * own, so an empty array never "resurrects" a presenter or a followed target
 * that isn't actually live.
 */
export function resolveViewportSource(
  cursors: PresenterCursor[],
  selfUid: string,
  followingUid: string | null
): string | null {
  const presenter = cursors.find((c) => c.presenting && c.userId !== selfUid);
  if (presenter && !presenter.presenterPaused) {
    return presenter.userId;
  }
  if (followingUid && cursors.some((c) => c.userId === followingUid)) {
    return followingUid;
  }
  return null;
}
