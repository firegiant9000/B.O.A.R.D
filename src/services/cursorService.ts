import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { CursorPresence } from "../types";
import { throttle, type Throttled } from "../lib/throttle";
import type { LaserPing } from "../lib/laser";

/**
 * Live cursors (Month 4, Phase 6 — ephemeral side channel).
 *
 * Cursor positions are written to `boards/{id}/cursors/{uid}` — deliberately NOT
 * the path/element collections — so cursor jitter stays off the persisted-state
 * listeners and never re-renders the element tree (Appendix A.4 hard rule). The
 * transport is kept behind a narrow interface so a realtime vendor (Ably /
 * Liveblocks) can drop in later behind the same three calls with a Firestore
 * fallback if Firestore proves too laggy at scale (roadmap risk row).
 */

export interface CursorPayload {
  displayName: string;
  /** Board-space pointer position. */
  x: number;
  y: number;
  /** Active tool, for the per-cursor icon. */
  tool: string;
  /** Phase 7: the author's viewport, so a follower can mirror their pan/zoom. */
  viewport?: { x: number; y: number; scale: number };
  /** Phase 7: who this author is following (for the cross-client cycle guard). */
  following?: string | null;
  /**
   * Month 5 (presenter mode): true while this author is presenting to the
   * whole board. Additive field on this same ephemeral payload — presenter
   * mode is deliberately NOT a second realtime channel. See
   * `src/lib/presenter.ts#resolveViewportSource` for the precedence between
   * an active presenter and an individual follow choice.
   */
  presenting?: boolean;
  /**
   * Month 5: true while the presenter above has paused. A pause releases
   * every viewer's viewport but does not itself clear `presenting` — the
   * audience banner stays up through a pause.
   */
  presenterPaused?: boolean;
  /**
   * Month 5 (laser pointer): the author's most recently sampled point while
   * using the laser tool. Like `presenting`/`presenterPaused`, this is an
   * additive field on the same ephemeral payload — the laser is deliberately
   * NOT a second realtime channel, and it never touches the path/element
   * collections (there is no persistence path for it at all — see
   * `writerFor` below). `src/lib/laser.ts` builds the fading multi-point
   * trail reader-side from a stream of these; this field itself only ever
   * carries the single latest point (`setDoc`'s full-document replace can't
   * hold more — see the comment on `writerFor`).
   */
  ping?: LaserPing;
}

// ~20Hz write ceiling. The render side throttles independently (~12Hz) in the
// CursorLayer, so this only bounds Firestore write volume (the free-tier risk).
export const CURSOR_WRITE_INTERVAL_MS = 50;

// Firestore has no RTDB-style onDisconnect, so a hard tab close leaves a stale
// cursor doc behind. Subscribers hide any cursor not refreshed within this
// window; the clean-unmount path still deletes the doc outright.
export const CURSOR_STALE_MS = 10000;

export interface CursorTransport {
  publish(boardId: string, userId: string, payload: CursorPayload): void;
  subscribe(
    boardId: string,
    cb: (cursors: CursorPresence[]) => void
  ): Unsubscribe;
  remove(boardId: string, userId: string): Promise<void>;
}

function cursorRef(boardId: string, userId: string) {
  return doc(db, "boards", boardId, "cursors", userId);
}

// One throttle per board+user so the write rate is bounded per cursor rather
// than globally, and a `remove` can cancel exactly that cursor's pending write.
const writers = new Map<string, Throttled<[CursorPayload]>>();

function writerFor(boardId: string, userId: string): Throttled<[CursorPayload]> {
  const key = `${boardId}:${userId}`;
  let w = writers.get(key);
  if (!w) {
    w = throttle((payload: CursorPayload) => {
      // Ephemeral: a dropped cursor frame is harmless, so writes never surface
      // an error or block — they're fire-and-forget.
      // Firestore rejects `undefined` fields, so viewport/following/presenting
      // are only spread in when present — keeping the doc shape stable for
      // legacy readers. `setDoc` (no `{ merge: true }`) replaces the whole
      // doc each write, so omitting `presenting`/`presenterPaused` here (they
      // are only ever truthy) is exactly how a presenter's own next
      // pointer-move write clears a stale `presenting: true` after they stop.
      setDoc(cursorRef(boardId, userId), {
        userId,
        displayName: payload.displayName,
        x: payload.x,
        y: payload.y,
        tool: payload.tool,
        updatedAt: Date.now(),
        ...(payload.viewport ? { viewport: payload.viewport } : {}),
        ...(payload.following !== undefined ? { following: payload.following } : {}),
        ...(payload.presenting ? { presenting: true } : {}),
        ...(payload.presenterPaused ? { presenterPaused: true } : {}),
        // Month 5 (laser pointer): never persisted anywhere else — this is
        // the one write a ping ever takes part in, on the same ephemeral doc
        // as everything above. Omitted whenever absent, exactly like the
        // other optional fields (Firestore rejects `undefined`).
        ...(payload.ping ? { ping: payload.ping } : {}),
      }).catch(() => {});
    }, CURSOR_WRITE_INTERVAL_MS);
    writers.set(key, w);
  }
  return w;
}

export const firestoreTransport: CursorTransport = {
  publish(boardId, userId, payload) {
    writerFor(boardId, userId)(payload);
  },
  subscribe(boardId, cb) {
    return onSnapshot(collection(db, "boards", boardId, "cursors"), (snap) => {
      const cursors: CursorPresence[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          userId: data.userId ?? d.id,
          displayName: data.displayName ?? "User",
          x: typeof data.x === "number" ? data.x : 0,
          y: typeof data.y === "number" ? data.y : 0,
          tool: data.tool ?? "pen",
          updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
          viewport:
            data.viewport &&
            typeof data.viewport.x === "number" &&
            typeof data.viewport.y === "number" &&
            typeof data.viewport.scale === "number"
              ? data.viewport
              : undefined,
          following: typeof data.following === "string" ? data.following : null,
          // Month 5: tolerate a pre-presenter-mode doc (field absent) by
          // defaulting to false rather than leaving it undefined.
          presenting: data.presenting === true,
          presenterPaused: data.presenterPaused === true,
          // Month 5 (laser pointer): tolerate an absent or malformed `ping`
          // (a pre-laser doc, or a partial write) by leaving it undefined
          // rather than passing a shape `activeTrail`/`appendPing` don't
          // expect.
          ping:
            data.ping &&
            typeof data.ping.x === "number" &&
            typeof data.ping.y === "number" &&
            typeof data.ping.t === "number"
              ? { x: data.ping.x, y: data.ping.y, t: data.ping.t }
              : undefined,
        };
      });
      cb(cursors);
    });
  },
  async remove(boardId, userId) {
    const key = `${boardId}:${userId}`;
    writers.get(key)?.cancel();
    writers.delete(key);
    await deleteDoc(cursorRef(boardId, userId)).catch(() => {});
  },
};

let active: CursorTransport = firestoreTransport;

/** Swap the cursor transport (e.g. to Ably/Liveblocks). Defaults to Firestore. */
export function setCursorTransport(transport: CursorTransport): void {
  active = transport;
}

export function publishCursor(
  boardId: string,
  userId: string,
  payload: CursorPayload
): void {
  active.publish(boardId, userId, payload);
}

/**
 * Month 5 (A.6 listener budget) — one real `onSnapshot` per board, fanned out
 * to every local subscriber, reference-counted so the underlying listener
 * tears down only once the last one detaches.
 *
 * Before this, every caller of `subscribeToCursors` opened its own
 * `onSnapshot`. `CursorLayer` already holds one permanently for rendering
 * remote pointers; once `useBoardCollab`'s follow/presenter-detection
 * subscription became always-on for the whole board visit (not just during a
 * manual follow), a normal board visit opened two cursor listeners per user
 * against Appendix A.6's budget of one. Multiplexing here — rather than in
 * each caller — means both keep their existing single call to
 * `subscribeToCursors` and both keep working unmodified; the laser-pointer
 * feature planned alongside presenter mode (`docs/month-5-phases.md`,
 * Phase 6) becomes a third subscriber on this same channel for free.
 *
 * The first subscriber on a board is added to the fan-out set *before* the
 * underlying `active.subscribe` call so a transport that invokes its callback
 * synchronously (Firestore's `onSnapshot` delivers its cached snapshot
 * immediately on a fresh listener) still reaches it. A *later* subscriber
 * joining an already-active board gets that same immediate-delivery
 * guarantee via `lastCursors`: onSnapshot's real contract is "every listener
 * gets the current snapshot right away, then updates" — without replaying
 * it here, a second local subscriber (say `useBoardCollab`'s follow/presenter
 * effect mounting after `CursorLayer` already opened the one real listener)
 * would otherwise see nothing until somebody's next cursor write.
 */
interface CursorSubscriptionEntry {
  unsubscribe: Unsubscribe;
  listeners: Set<(cursors: CursorPresence[]) => void>;
  lastCursors: CursorPresence[] | null;
  /**
   * Month 5 fix round — set once every local listener has detached. `active
   * .subscribe` below can invoke its callback synchronously (the same
   * cached-snapshot delivery the comment above relies on), and if the sole
   * subscriber reacts to that first delivery by unsubscribing right there,
   * the teardown branch in the returned closure runs *before*
   * `active.subscribe` has returned — so `entry.unsubscribe` is still the
   * `() => {}` placeholder below, and calling it tears down nothing. Without
   * this flag that leaves the real underlying `onSnapshot` listener open
   * forever with no local listener left to feed it: a leaked hot listener,
   * the exact cost risk this multiplexing exists to bound. Checked once
   * `active.subscribe` returns so that case tears the real listener down
   * immediately instead.
   */
  detached: boolean;
}
const cursorSubscriptions = new Map<string, CursorSubscriptionEntry>();

export function subscribeToCursors(
  boardId: string,
  cb: (cursors: CursorPresence[]) => void
): Unsubscribe {
  const existing = cursorSubscriptions.get(boardId);
  if (existing) {
    existing.listeners.add(cb);
    if (existing.lastCursors) cb(existing.lastCursors);
  } else {
    const listeners = new Set<(cursors: CursorPresence[]) => void>([cb]);
    const entry: CursorSubscriptionEntry = {
      unsubscribe: () => {},
      listeners,
      lastCursors: null,
      detached: false,
    };
    cursorSubscriptions.set(boardId, entry);
    const realUnsubscribe = active.subscribe(boardId, (cursors) => {
      entry.lastCursors = cursors;
      // Snapshot before iterating: a listener that unsubscribes itself (or
      // another) synchronously during this fan-out must not mutate the set
      // while it's still being iterated.
      for (const listener of [...listeners]) listener(cursors);
    });
    if (entry.detached) {
      // See the `detached` field doc: the sole subscriber already tore this
      // entry down (synchronously, during the call above) before this real
      // unsubscribe existed to run — run it now instead of leaking it.
      // `entry.unsubscribe` is not the right thing to assign at this point:
      // the entry is already out of `cursorSubscriptions`, so nothing will
      // ever read it again.
      realUnsubscribe();
    } else {
      entry.unsubscribe = realUnsubscribe;
    }
  }

  return () => {
    const e = cursorSubscriptions.get(boardId);
    if (!e || !e.listeners.has(cb)) return; // already detached — idempotent
    e.listeners.delete(cb);
    if (e.listeners.size === 0) {
      e.detached = true;
      cursorSubscriptions.delete(boardId);
      e.unsubscribe();
    }
  };
}

export function removeCursor(boardId: string, userId: string): Promise<void> {
  return active.remove(boardId, userId);
}

/**
 * Pure render-list filter: drops the viewer's own cursor, blocked users, and any
 * cursor gone stale relative to `now`. Kept pure so it's unit-testable without a
 * live subscription.
 */
export function visibleCursors(
  cursors: CursorPresence[],
  selfId: string | undefined,
  blockedIds: string[],
  now: number
): CursorPresence[] {
  return cursors.filter(
    (c) =>
      c.userId !== selfId &&
      !blockedIds.includes(c.userId) &&
      now - c.updatedAt < CURSOR_STALE_MS
  );
}
