import { useCallback, useEffect, useRef, useState } from "react";
import { Point, Viewport } from "../lib/viewport";
import { toggleFollow, wouldCreateCycle, type FollowMap } from "../lib/followMode";
import * as presenceService from "../services/presenceService";
import * as cursorService from "../services/cursorService";
import { captureException } from "../lib/errorReporting";
import { BoardPresence } from "../types";
import type { Tool } from "./useBoardTools";

/**
 * Board collaboration state (Month 5/6 Task 1 — extracted verbatim from
 * `app/board/[id].tsx`).
 *
 * Owns presence (join / subscribe / leave), the Phase 6 cursor side channel, and
 * Phase 7 follow mode with both of its cycle guards. Cursor publishing is
 * side-effect-only — it never sets state, so a pointer move never re-renders the
 * element tree (Appendix A.4 hard rule).
 *
 * The camera itself stays in the screen's `useViewport`: this hook reports the
 * leader's broadcast viewport through `onLeaderViewport` rather than driving a
 * controller it was handed, so it composes with anything.
 *
 * ⚠ BEFORE YOU TOUCH `onLeaderViewport`: its identity is **intentionally
 * unstable** and that instability is load-bearing. See the long comment on the
 * follow subscription below. Memoizing it — or hoisting the caller's inline arrow
 * into a `useCallback` while adding presenter features — changes follow-mode
 * behaviour. Task 14 must decide that deliberately, not incidentally.
 */

/** The minimum shape this hook needs from the signed-in auth user. */
export interface CollabUser {
  uid: string;
}

export interface BoardCollabOptions {
  /** Display name published with presence + every cursor frame. */
  displayName: string;
  /** Email published with presence. */
  email: string;
  /** The active tool, published so remote cursors render the right glyph. */
  activeTool: Tool;
  /** The live camera — broadcast so followers track non-pointer moves. */
  viewport: Viewport;
  /**
   * Read-only embed mode. An embed identity has no write rights to presence or
   * cursors, so both are suppressed entirely.
   */
  embedMode: boolean;
  /**
   * Drive the camera toward the leader's broadcast viewport while following.
   *
   * ⚠ Callers pass a **fresh closure every render** on purpose — this is a
   * dependency of the follow subscription and its instability is load-bearing.
   * Do not memoize it without reading the comment on that effect first.
   */
  onLeaderViewport: (viewport: Viewport) => void;
}

export interface BoardCollab {
  presence: BoardPresence[];
  /** The presence user whose camera we're mirroring, or null. */
  followingId: string | null;
  /** Publish the local pointer to the cursor side channel (throttled in the service). */
  publishPointer: (p: Point) => void;
  /** Stop following (own gesture, leader left, etc.). */
  exitFollow: () => void;
  /** Avatar tap → toggle follow on that user. */
  toggleFollowUser: (targetId: string) => void;
}

export function useBoardCollab(
  boardId: string,
  user: CollabUser | null,
  opts: BoardCollabOptions
): BoardCollab {
  const { displayName, email, activeTool, viewport, embedMode, onLeaderViewport } = opts;

  // Presence state
  const [presence, setPresence] = useState<BoardPresence[]>([]);

  // Phase 7 — follow mode. The presence user whose camera we're mirroring (or
  // null). `lastPointerRef` holds the latest board-space pointer so a viewport
  // broadcast can re-send the cursor position even when only the camera moved.
  const [followingId, setFollowingId] = useState<string | null>(null);
  const lastPointerRef = useRef<Point>({ x: 0, y: 0 });
  // Gates the viewport broadcast until the pointer has actually moved once, so a
  // user who only opens the board doesn't publish a phantom cursor at (0,0).
  const hasPointerRef = useRef(false);

  // Presence: join on mount, subscribe to updates, leave on unmount. Skipped in
  // embed mode — the read-only embed identity has no write rights to presence.
  useEffect(() => {
    if (!boardId || !user || embedMode) return;

    presenceService
      .joinBoard(boardId, user.uid, displayName, email)
      .catch((e) => captureException(e, { op: "board.joinPresence" }));

    const unsubscribe = presenceService.subscribeToBoardPresence(boardId, setPresence);

    return () => {
      unsubscribe();
      presenceService
        .leaveBoard(boardId, user.uid)
        .catch((e) => captureException(e, { op: "board.leavePresence" }));
      // Phase 6: clear the ephemeral cursor doc on leave so it doesn't linger
      // (Firestore has no onDisconnect; stale cursors are also filtered on read).
      cursorService
        .removeCursor(boardId, user.uid)
        .catch((e) => captureException(e, { op: "board.removeCursor" }));
    };
    // `displayName`/`email` are read at join time only — re-joining on a profile
    // rename is not the original behaviour, so they stay out of the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, user]);

  // Phase 6: publish the local pointer to the cursor side channel. Throttled
  // inside cursorService (~20Hz) and side-effect-only — it never sets state, so
  // a pointer move never re-renders the element tree (Appendix A.4 hard rule).
  const publishPointer = useCallback(
    (p: Point) => {
      if (!boardId || !user || embedMode) return;
      lastPointerRef.current = p;
      hasPointerRef.current = true;
      cursorService.publishCursor(boardId, user.uid, {
        displayName,
        x: p.x,
        y: p.y,
        tool: activeTool,
        // Don't broadcast a viewport while following — ours is just a mirror of
        // the leader's, and re-broadcasting it is what would sustain an A↔B
        // oscillation (Phase 7 cycle guard, primary layer).
        viewport: followingId ? undefined : viewport,
        following: followingId,
      });
    },
    [boardId, user, displayName, activeTool, viewport, followingId, embedMode]
  );

  // Phase 7 — broadcast our viewport when it changes from our own pan/zoom, so
  // followers track moves that aren't pointer-driven (pinch, fling, zoom buttons).
  // Suppressed while following: that viewport is a mirror, not our intent.
  useEffect(() => {
    if (!boardId || !user || embedMode || followingId || !hasPointerRef.current) return;
    cursorService.publishCursor(boardId, user.uid, {
      displayName,
      x: lastPointerRef.current.x,
      y: lastPointerRef.current.y,
      tool: activeTool,
      viewport,
      following: null,
    });
  }, [viewport, boardId, user, displayName, activeTool, followingId, embedMode]);

  // Stop following (own gesture, leader left, etc.). Stable so it can be wired
  // into the canvas gesture/tap and zoom-control handlers without re-creating.
  const exitFollow = useCallback(() => setFollowingId(null), []);

  // Avatar tap → toggle follow on that user (the subscription's cycle guard
  // catches the A↔B case once both viewports are visible).
  const toggleFollowUser = useCallback(
    (targetId: string) => {
      setFollowingId((cur) => toggleFollow(cur, targetId, user?.uid ?? ""));
    },
    [user?.uid]
  );

  // Phase 7 — while following, open a transient cursor subscription that drives
  // the camera toward the leader's broadcast viewport. It's the only extra
  // listener and lives only for the duration of the follow (within the A.6
  // listener budget). Cursor jitter still never touches the element tree —
  // this re-renders only via the viewport, exactly as a manual pan/zoom does.
  //
  // ⚠ `onLeaderViewport` IS INTENTIONALLY AN UNSTABLE DEPENDENCY. DO NOT MEMOIZE IT.
  //
  // Before the Month 5/6 Task 1 split, this effect depended on the whole
  // `useViewport` controller, and `useViewport` returns a fresh object literal on
  // every render (see `src/hooks/useViewport.ts` — the object is new even though
  // every method on it is a stable `useCallback`). So this subscription was torn
  // down and re-created on *every render* while following — roughly 60x/second
  // during a follow ease, because the ease itself calls `setViewport` per frame.
  //
  // That churn is a pre-existing perf bug. It was deliberately preserved, not
  // fixed, because Task 1 was a pure refactor: the callers therefore pass a fresh
  // closure each render (`onLeaderViewport: (v) => viewportCtl.animateTo(v)` in
  // `app/board/[id].tsx`) specifically to reproduce it.
  //
  // Stabilizing it is not a no-op. Each resubscribe makes Firestore re-deliver the
  // current snapshot, which calls `onLeaderViewport` again and re-bases the
  // easeOutCubic glide from the *current* camera toward the same target — so the
  // follower's approach curve today is a chain of restarted eases, not one 250ms
  // ease. Stabilizing gives a single clean ease: better, but a visible change to
  // how following feels.
  //
  // Task 14 (presenter mode) owns this decision. Fix it on purpose, with the
  // easing change acknowledged — not incidentally, by tidying a dependency array
  // or hoisting the caller's arrow into a `useCallback`.
  useEffect(() => {
    if (!boardId || !followingId || !user) return;
    const unsub = cursorService.subscribeToCursors(boardId, (cursors) => {
      const leader = cursors.find((c) => c.userId === followingId);
      if (!leader) return;
      // Secondary cycle guard: if the leader (transitively) follows us, break the
      // follow so the two cameras can't chase each other.
      const followMap: FollowMap = {};
      for (const c of cursors) followMap[c.userId] = c.following ?? null;
      if (wouldCreateCycle(followMap, user.uid, followingId)) {
        setFollowingId(null);
        return;
      }
      if (leader.viewport) onLeaderViewport(leader.viewport);
    });
    return unsub;
  }, [boardId, followingId, user, onLeaderViewport]);

  // Stop following if the leader drops out of presence (left the board).
  useEffect(() => {
    if (!followingId) return;
    if (!presence.some((p) => p.userId === followingId)) setFollowingId(null);
  }, [presence, followingId]);

  return {
    presence,
    followingId,
    publishPointer,
    exitFollow,
    toggleFollowUser,
  };
}
