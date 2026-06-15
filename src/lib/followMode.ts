// Follow-user mode state machine (Month 4, Phase 7). Pure so the toggle and the
// cycle guard are unit-testable without a live cursor subscription. The board
// screen drives the camera (useViewport.animateTo) from these results; nothing
// here touches Firestore or React.

/** Map of userId → the userId they are currently following (or null). */
export type FollowMap = Record<string, string | null | undefined>;

/**
 * Tapping a presence avatar toggles follow: following the same user again stops,
 * a different user switches. You can never follow yourself.
 */
export function toggleFollow(
  current: string | null,
  targetId: string,
  selfId: string
): string | null {
  if (!targetId || targetId === selfId) return current;
  return current === targetId ? null : targetId;
}

/**
 * Would following `targetId` create a cycle that loops back to `selfId`? Walks
 * the follow chain (target → who target follows → …); a chain that reaches self
 * means our camera would mirror someone whose camera mirrors us — an oscillation.
 * The `seen` set bounds the walk against a pre-existing cycle not involving self.
 */
export function wouldCreateCycle(
  followMap: FollowMap,
  selfId: string,
  targetId: string
): boolean {
  let cur: string | null | undefined = targetId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === selfId) return true;
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = followMap[cur];
  }
  return false;
}

/**
 * Resolve a follow request against the cycle guard: compute the toggled target,
 * then refuse it (keep `current`) if it would close a loop back to self.
 */
export function resolveFollow(
  current: string | null,
  targetId: string,
  selfId: string,
  followMap: FollowMap
): string | null {
  const next = toggleFollow(current, targetId, selfId);
  if (next && wouldCreateCycle(followMap, selfId, next)) return current;
  return next;
}
