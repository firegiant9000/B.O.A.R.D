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
      // Firestore rejects `undefined` fields, so viewport/following are only
      // spread in when present — keeping the doc shape stable for legacy readers.
      setDoc(cursorRef(boardId, userId), {
        userId,
        displayName: payload.displayName,
        x: payload.x,
        y: payload.y,
        tool: payload.tool,
        updatedAt: Date.now(),
        ...(payload.viewport ? { viewport: payload.viewport } : {}),
        ...(payload.following !== undefined ? { following: payload.following } : {}),
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

export function subscribeToCursors(
  boardId: string,
  cb: (cursors: CursorPresence[]) => void
): Unsubscribe {
  return active.subscribe(boardId, cb);
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
