import { useCallback, useEffect, useRef, useState } from "react";
import { Point, Viewport } from "../lib/viewport";
import { toggleFollow, wouldCreateCycle, type FollowMap } from "../lib/followMode";
import { resolveViewportSource } from "../lib/presenter";
import * as presenceService from "../services/presenceService";
import * as cursorService from "../services/cursorService";
import { captureException } from "../lib/errorReporting";
import { BoardPresence, CursorPresence } from "../types";
import type { Tool } from "./useBoardTools";

/**
 * Board collaboration state (Month 5/6 Task 1 — extracted verbatim from
 * `app/board/[id].tsx`; Month 5 added presenter mode).
 *
 * Owns presence (join / subscribe / leave), the Phase 6 cursor side channel,
 * Phase 7 follow mode with both of its cycle guards, and Month 5 presenter
 * mode (see `src/lib/presenter.ts#resolveViewportSource` for the precedence
 * between an active presenter and an individual follow choice). Cursor
 * *publishing* is side-effect-only — it never sets state, so a pointer move
 * never re-renders the element tree (Appendix A.4 hard rule). The cursor
 * *subscription* below does set state, but only `activePresenter`
 * (present/absent/paused) — it is compared before every `setActivePresenter`
 * call so unrelated cursor churn (anyone's x/y jitter) does not also trigger
 * a re-render.
 *
 * The camera itself stays in the screen's `useViewport`: this hook reports
 * the resolved viewport source through `onLeaderViewport` rather than
 * driving a controller it was handed, so it composes with anything.
 *
 * Month 5's decision on `onLeaderViewport`'s churn (previously flagged here,
 * in a three-place warning, as "intentionally unstable — do not memoize"):
 * FIXED. The callback is now read through `onLeaderViewportRef` (assigned
 * fresh every render, read only from inside the cursor-subscription
 * callback — the same latest-ref idiom `src/hooks/useViewport.ts` already
 * uses for `viewportRef`), so it is no longer a dependency of that effect.
 * Callers may still pass a fresh closure every render (harmless now) or a
 * memoized one — it makes no behavioural difference either way. See the long
 * comment on the cursor-subscription effect below for why this was fixed
 * rather than kept, and what it changes about the follow/presenter camera
 * ease.
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
   * Drive the camera toward the resolved viewport source (an active,
   * unpaused presenter, or the individually-followed leader — see
   * `src/lib/presenter.ts#resolveViewportSource`).
   *
   * Month 5: this is now read through a ref inside the hook rather than
   * listed as an effect dependency, so its identity no longer matters — pass
   * a fresh closure every render or a memoized one, either is fine. (It was
   * previously a load-bearing *unstable* dependency; see the file-level
   * comment above for why that changed.)
   */
  onLeaderViewport: (viewport: Viewport) => void;
}

/** Who (if anyone but the caller) is presenting right now — audience-facing. */
export interface ActivePresenter {
  userId: string;
  displayName: string;
  /** True while the presenter has paused (releases viewports, keeps the banner). */
  paused: boolean;
}

export interface BoardCollab {
  presence: BoardPresence[];
  /** The presence user whose camera we're mirroring, or null. */
  followingId: string | null;
  /** Publish the local pointer to the cursor side channel (throttled in the service). */
  publishPointer: (p: Point) => void;
  /** Stop following (own gesture, leader left, etc.). */
  exitFollow: () => void;
  /** Avatar tap → toggle follow on that user. No-op while presenting. */
  toggleFollowUser: (targetId: string) => void;
  /** Am I presenting right now? */
  isPresenting: boolean;
  /** Is my own presentation paused? Meaningless when `isPresenting` is false. */
  isPresenterPaused: boolean;
  /**
   * Who (if anyone but me) is presenting, for the audience banner. Stays
   * non-null through a pause — see the long comment on the cursor
   * subscription effect below for why viewport-following and
   * banner-visibility are tracked separately rather than both coming out of
   * `resolveViewportSource`.
   */
  activePresenter: ActivePresenter | null;
  /**
   * True while someone *other* than me is presenting and hasn't paused —
   * always false on the presenter's own client (`activePresenter` excludes
   * self). The single source of truth for every caller that needs to lock
   * out new content creation while a presentation is live; computed once
   * here instead of re-derived from `activePresenter` at each call site.
   * Named for the boundary it enforces (no new content), not "drawing" —
   * it also gates duplicate and the AI/auto-perfect accept actions, which
   * create content without drawing anything.
   */
  presenterLocksContentCreation: boolean;
  /** Start presenting: overrides every viewer's individual follow choice. */
  startPresenting: () => void;
  /** Stop presenting: viewers fall back to their individual follow choice. */
  stopPresenting: () => void;
  /** Pause: releases every viewer's viewport but keeps the audience banner up. */
  pausePresenting: () => void;
  /** Resume a paused presentation. */
  resumePresenting: () => void;
}

/** Referential-equality-ish compare so an unchanged presenter never triggers a re-render. */
function samePresenter(a: ActivePresenter | null, b: ActivePresenter | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.userId === b.userId && a.displayName === b.displayName && a.paused === b.paused;
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

  // Month 5 — presenter mode. `isPresenting`/`isPresenterPaused` are MY OWN
  // state; `activePresenter` is who (if anyone but me) is presenting, derived
  // from the cursor subscription below.
  const [isPresenting, setIsPresenting] = useState(false);
  const [isPresenterPaused, setIsPresenterPaused] = useState(false);
  const [activePresenter, setActivePresenter] = useState<ActivePresenter | null>(null);

  // Latest-ref idiom (matches `viewportRef` in `src/hooks/useViewport.ts`):
  // assigned fresh every render, read only inside the cursor-subscription
  // effect's callback below, so that effect never needs `onLeaderViewport` in
  // its dependency array. See the file-level comment for the decision.
  const onLeaderViewportRef = useRef(onLeaderViewport);
  onLeaderViewportRef.current = onLeaderViewport;

  // Month 5 — the last viewport actually forwarded to `onLeaderViewport`, so
  // the cursor-subscription effect below can skip calling it again when the
  // resolved source's viewport hasn't changed. See that effect's long
  // comment for why this is necessary: the subscription is collection-wide
  // (it maps every doc in the board's cursors collection), so its callback
  // fires on *any* participant's cursor write, not only the resolved
  // source's — up to 20 Hz per other participant. And even the source's own
  // writes repeat the same viewport: while they're actively drawing or
  // pointing (not panning), `publishPointer` still republishes their
  // *current* viewport on every throttled ~20Hz pointer-move write, unchanged
  // frame after frame. Without this dedupe, `animateTo` — which
  // unconditionally re-bases its ease from the current camera
  // (`useViewport.ts`) — would restart a fresh glide toward that same
  // unchanged target on every one of those deliveries: the exact "stutter of
  // restarted eases" the old per-render-resubscribe bug produced, just from
  // a different root cause.
  const lastAppliedViewportRef = useRef<Viewport | null>(null);

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
        // oscillation (Phase 7 cycle guard, primary layer). `followingId` is
        // always null while presenting (see `startPresenting`), so this still
        // broadcasts our viewport whenever we're the presenter.
        viewport: followingId ? undefined : viewport,
        following: followingId,
        presenting: isPresenting,
        presenterPaused: isPresenterPaused,
      });
    },
    [
      boardId,
      user,
      displayName,
      activeTool,
      viewport,
      followingId,
      embedMode,
      isPresenting,
      isPresenterPaused,
    ]
  );

  // Phase 7 — broadcast our viewport when it changes from our own pan/zoom, so
  // followers (and, since Month 5, the whole audience while presenting) track
  // moves that aren't pointer-driven (pinch, fling, zoom buttons). Suppressed
  // while following someone else: that viewport is a mirror, not our intent.
  useEffect(() => {
    if (!boardId || !user || embedMode || followingId || !hasPointerRef.current) return;
    cursorService.publishCursor(boardId, user.uid, {
      displayName,
      x: lastPointerRef.current.x,
      y: lastPointerRef.current.y,
      tool: activeTool,
      viewport,
      following: null,
      presenting: isPresenting,
      presenterPaused: isPresenterPaused,
    });
  }, [
    viewport,
    boardId,
    user,
    displayName,
    activeTool,
    followingId,
    embedMode,
    isPresenting,
    isPresenterPaused,
  ]);

  // Stop following (own gesture, leader left, etc.). Stable so it can be wired
  // into the canvas gesture/tap and zoom-control handlers without re-creating.
  const exitFollow = useCallback(() => setFollowingId(null), []);

  // Avatar tap → toggle follow on that user (the subscription's cycle guard
  // catches the A↔B case once both viewports are visible). No-op while
  // presenting: presenting is itself the camera source for the room, so
  // following someone else at the same time would fight our own broadcast.
  const toggleFollowUser = useCallback(
    (targetId: string) => {
      if (isPresenting) return;
      setFollowingId((cur) => toggleFollow(cur, targetId, user?.uid ?? ""));
    },
    [user?.uid, isPresenting]
  );

  // Month 5 — presenter mode actions. Each publishes an immediate cursor frame
  // (not a per-frame write: this is one write per discrete start/stop/pause/
  // resume action) so the room learns of the change without waiting on the
  // next pointer move. The regular `publishPointer` / viewport-broadcast paths
  // above (and `setDoc`'s full-document replace — see cursorService) carry
  // `presenting`/`presenterPaused` on every subsequent write so the flag
  // doesn't silently drop off on the presenter's next ordinary cursor update.
  const startPresenting = useCallback(() => {
    if (!boardId || !user || embedMode) return;
    setIsPresenting(true);
    setIsPresenterPaused(false);
    setFollowingId(null); // Presenting is the camera source, not a follower.
    hasPointerRef.current = true; // Let a viewport-only pan broadcast immediately.
    cursorService.publishCursor(boardId, user.uid, {
      displayName,
      x: lastPointerRef.current.x,
      y: lastPointerRef.current.y,
      tool: activeTool,
      viewport,
      following: null,
      presenting: true,
      presenterPaused: false,
    });
  }, [boardId, user, embedMode, displayName, activeTool, viewport]);

  const stopPresenting = useCallback(() => {
    if (!boardId || !user || embedMode) return;
    setIsPresenting(false);
    setIsPresenterPaused(false);
    cursorService.publishCursor(boardId, user.uid, {
      displayName,
      x: lastPointerRef.current.x,
      y: lastPointerRef.current.y,
      tool: activeTool,
      viewport,
      following: null,
      presenting: false,
      presenterPaused: false,
    });
  }, [boardId, user, embedMode, displayName, activeTool, viewport]);

  const pausePresenting = useCallback(() => {
    if (!boardId || !user || embedMode || !isPresenting) return;
    setIsPresenterPaused(true);
    cursorService.publishCursor(boardId, user.uid, {
      displayName,
      x: lastPointerRef.current.x,
      y: lastPointerRef.current.y,
      tool: activeTool,
      viewport,
      following: null,
      presenting: true,
      presenterPaused: true,
    });
  }, [boardId, user, embedMode, isPresenting, displayName, activeTool, viewport]);

  const resumePresenting = useCallback(() => {
    if (!boardId || !user || embedMode || !isPresenting) return;
    setIsPresenterPaused(false);
    cursorService.publishCursor(boardId, user.uid, {
      displayName,
      x: lastPointerRef.current.x,
      y: lastPointerRef.current.y,
      tool: activeTool,
      viewport,
      following: null,
      presenting: true,
      presenterPaused: false,
    });
  }, [boardId, user, embedMode, isPresenting, displayName, activeTool, viewport]);

  // Phase 7 / Month 5 — subscribe to the board's cursors to resolve who (if
  // anyone) our camera should mirror, and whether the audience banner should
  // be showing. This runs whenever we're a live participant, not only while
  // `followingId` is set: presenter mode (case 1 of the precedence rule in
  // `src/lib/presenter.ts`) can pull anyone's camera, including someone who
  // never chose to follow anybody. Before Month 5 this listener opened only
  // during a manual follow; it is now open for the lifetime of the board
  // visit — mirroring the always-on cursor subscription `CursorLayer`
  // (`src/components/CursorLayer.tsx`) already keeps for rendering remote
  // pointers, so this is a second listener on the same collection, not a
  // novel cost in kind.
  //
  // ⚠ MONTH 5's DECISION ON `onLeaderViewport` CHURN — READ BEFORE CHANGING
  // THIS EFFECT'S DEPENDENCY ARRAY.
  //
  // Before Task 1's screen split, this effect depended on the whole
  // `useViewport` controller, which returns a fresh object literal every
  // render even though each of its methods is a stable `useCallback` — so the
  // subscription was torn down and re-created on *every render* while
  // following, roughly 60x/second during a follow ease (the ease itself calls
  // `setViewport` per frame). Task 1 preserved that churn deliberately (a
  // pure refactor must not change behaviour) and left the decision to fix or
  // keep it to this task.
  //
  // DECISION: fixed, not kept. `onLeaderViewport` is now called through
  // `onLeaderViewportRef` (declared above, assigned fresh every render)
  // instead of being listed in this effect's dependency array, so the
  // subscription no longer cares whether the caller's closure is stable. It
  // now only re-subscribes on an actual state change (`boardId`, `user`,
  // `embedMode`, `followingId`), not on every render.
  //
  // Why fix it rather than keep it: Month 5 widens this same effect to run
  // for the entire board visit rather than only during a manual follow (see
  // above), so the old per-render churn would now cost a teardown/recreate on
  // *every* render for *every* board occupant, not just an active follower —
  // exactly the "adds render pressure on top of an already-churning listener"
  // risk the task brief called out. Fixing it here removes that multiplier
  // instead of compounding it, at effectively no cost: the caller's inline
  // arrow in `app/board/[id].tsx` can stay exactly as it is.
  //
  // Behavioural difference this accepts: `animateTo`
  // (`src/hooks/useViewport.ts`) re-bases its easeOutCubic glide from the
  // *current* camera every time it's called. Under the old churn, each
  // spurious resubscribe re-delivered Firestore's current snapshot, which
  // called `onLeaderViewport` again with the *same* target and restarted the
  // ease from wherever the in-flight ease had gotten to — a chain of
  // restarted 250ms eases that never quite reaches a clean stop, rather than
  // one ease per genuine target change. With the fix, `onLeaderViewport`
  // fires only when the leader's cursor doc actually changes (their real
  // ~20Hz throttled writes), so the follower's camera now runs one continuous
  // ease per real target update instead of a stutter of restarts. Net effect:
  // follow-mode and presenter-mode camera motion should look *smoother*, not
  // different in destination or duration — `FOLLOW_EASE_MS` and the easing
  // curve itself are untouched.
  useEffect(() => {
    if (!boardId || !user || embedMode) return;
    const unsub = cursorService.subscribeToCursors(boardId, (cursors: CursorPresence[]) => {
      // Phase 7 cycle guard (precedence case 4): unchanged, still applies to
      // a manual follow choice regardless of whether a presenter is also
      // active.
      if (followingId) {
        const followMap: FollowMap = {};
        for (const c of cursors) followMap[c.userId] = c.following ?? null;
        if (wouldCreateCycle(followMap, user.uid, followingId)) {
          setFollowingId(null);
          return;
        }
      }

      // Drop cursors idle past the staleness window before any presenter or
      // viewport-source decision — `resolveViewportSource` relies on this
      // (see its "ignores a stale presenter cursor" test): a crashed
      // client's un-cleaned-up doc must not hold the room's camera or banner
      // hostage.
      const now = Date.now();
      const live = cursors.filter((c) => now - c.updatedAt < cursorService.CURSOR_STALE_MS);

      // Presenter detection is tracked separately from
      // `resolveViewportSource`'s return value on purpose: case 2 (a paused
      // presenter) must keep the audience banner up while releasing the
      // viewport, and a function that returns a single viewport-source id
      // can't carry both facts at once.
      const presenterCursor = live.find((c) => c.presenting && c.userId !== user.uid);
      const nextPresenter: ActivePresenter | null = presenterCursor
        ? {
            userId: presenterCursor.userId,
            displayName: presenterCursor.displayName,
            paused: !!presenterCursor.presenterPaused,
          }
        : null;
      setActivePresenter((prev) => (samePresenter(prev, nextPresenter) ? prev : nextPresenter));

      const sourceId = resolveViewportSource(live, user.uid, followingId);
      if (!sourceId) return;
      const source = live.find((c) => c.userId === sourceId);
      if (!source?.viewport) return;
      // Dedupe against the last viewport we actually forwarded — see the
      // long comment on `lastAppliedViewportRef` above for why this matters:
      // this callback fires far more often than the source's viewport
      // actually changes, and every unnecessary call restarts `animateTo`'s
      // ease from scratch.
      const last = lastAppliedViewportRef.current;
      if (
        last &&
        last.x === source.viewport.x &&
        last.y === source.viewport.y &&
        last.scale === source.viewport.scale
      ) {
        return;
      }
      lastAppliedViewportRef.current = source.viewport;
      onLeaderViewportRef.current(source.viewport);
    });
    return unsub;
  }, [boardId, user, embedMode, followingId]);

  // Stop following if the leader drops out of presence (left the board).
  useEffect(() => {
    if (!followingId) return;
    if (!presence.some((p) => p.userId === followingId)) setFollowingId(null);
  }, [presence, followingId]);

  // Single source of truth for "someone else is presenting, unpaused" — see
  // the `BoardCollab` field doc. `activePresenter` already excludes self (the
  // cursor-subscription effect above filters `c.userId !== user.uid`), so
  // this is never true on the presenter's own client.
  const presenterLocksContentCreation = !!activePresenter && !activePresenter.paused;

  return {
    presence,
    followingId,
    publishPointer,
    exitFollow,
    toggleFollowUser,
    isPresenting,
    isPresenterPaused,
    activePresenter,
    presenterLocksContentCreation,
    startPresenting,
    stopPresenting,
    pausePresenting,
    resumePresenting,
  };
}
