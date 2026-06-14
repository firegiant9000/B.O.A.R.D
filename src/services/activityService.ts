import {
  collection,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit as limitTo,
  serverTimestamp,
  onSnapshot,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { ActivityEvent, ActivityTargetType, ActivityVerb } from "../types";

// Phase 8 (Month 3, roadmap item 8). Append-only activity feed.
//
// Read pattern (decided + documented per the phase plan):
//   - Single source of truth: `workspaces/{wsId}/activity/{eventId}`.
//   - Workspace feed: the subcollection ordered by `createdAt` desc (newest-first).
//   - Per-board history: the SAME subcollection filtered `where('boardId','==',…)`
//     ordered by `createdAt` desc. `boardId` is denormalized onto every event for
//     this query (composite index in firestore.indexes.json).
// We deliberately do NOT mirror events into `boards/{id}/activity`: a single write
// keeps the append-only rule trivial and removes the consistency drift two copies
// would invite. The cost is one composite index, which is cheap.
//
// Migration tolerance: an event with no workspaceId can't be addressed (there is
// no `workspaces//activity` path), so `append` is a no-op when `workspaceId` is
// empty — legacy boards predating Phase 2 simply don't log until Phase 9 stamps
// them. Callers append fire-and-forget (see `safeAppend`) so a failed/no-op log
// never breaks the mutation that triggered it.

const DEFAULT_FEED_LIMIT = 50;

function activityRef(workspaceId: string) {
  return collection(db, "workspaces", workspaceId, "activity");
}

function mapEvent(id: string, data: any): ActivityEvent {
  return {
    id,
    actorId: data.actorId ?? "",
    actorName: data.actorName ?? "Someone",
    verb: (data.verb ?? "board.created") as ActivityVerb,
    targetType: (data.targetType ?? "board") as ActivityTargetType,
    targetId: data.targetId ?? "",
    workspaceId: data.workspaceId ?? "",
    boardId: data.boardId ?? undefined,
    meta: data.meta ?? {},
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

export type NewActivityEvent = {
  actorId: string;
  actorName: string;
  verb: ActivityVerb;
  targetType: ActivityTargetType;
  targetId: string;
  workspaceId: string;
  boardId?: string;
  meta?: Record<string, any>;
};

/**
 * Appends one event to its workspace's activity log. Resolves to the new event id,
 * or `null` when `workspaceId` is empty (legacy/unscoped — nothing to write to).
 * The append-only rule rejects any later edit/delete of the doc.
 */
export async function append(event: NewActivityEvent): Promise<string | null> {
  if (!event.workspaceId) return null;
  const payload: Record<string, any> = {
    actorId: event.actorId,
    actorName: event.actorName,
    verb: event.verb,
    targetType: event.targetType,
    targetId: event.targetId,
    workspaceId: event.workspaceId,
    meta: event.meta ?? {},
    createdAt: serverTimestamp(),
  };
  if (event.boardId) payload.boardId = event.boardId;
  const ref = await addDoc(activityRef(event.workspaceId), payload);
  return ref.id;
}

/**
 * Fire-and-forget wrapper for call sites: appends without letting a logging failure
 * surface to the user. The triggering mutation has already committed by the time we
 * log, so a dropped event is acceptable; we report it to the console only.
 */
export async function safeAppend(event: NewActivityEvent): Promise<void> {
  try {
    await append(event);
  } catch (err) {
    console.warn("[activity] append failed:", err);
  }
}

// ── convenience builders (one per verb) ───────────────────────────────────────
// Keep event construction in one place so the shape stays consistent across the
// scattered choke points (board create, comment, session end).

export function logBoardCreated(args: {
  workspaceId: string;
  boardId: string;
  actorId: string;
  actorName: string;
  title: string;
}): Promise<void> {
  return safeAppend({
    actorId: args.actorId,
    actorName: args.actorName,
    verb: "board.created",
    targetType: "board",
    targetId: args.boardId,
    workspaceId: args.workspaceId,
    boardId: args.boardId,
    meta: { title: args.title },
  });
}

export function logCommentCreated(args: {
  workspaceId: string;
  boardId: string;
  commentId: string;
  actorId: string;
  actorName: string;
  anchorElementId: string;
}): Promise<void> {
  return safeAppend({
    actorId: args.actorId,
    actorName: args.actorName,
    verb: "comment.created",
    targetType: "comment",
    targetId: args.commentId,
    workspaceId: args.workspaceId,
    boardId: args.boardId,
    meta: { anchorElementId: args.anchorElementId },
  });
}

export function logSessionEnded(args: {
  workspaceId: string;
  boardId: string;
  sessionId: string;
  actorId: string;
  actorName: string;
  participantCount: number;
  title?: string;
}): Promise<void> {
  return safeAppend({
    actorId: args.actorId,
    actorName: args.actorName,
    verb: "session.ended",
    targetType: "session",
    targetId: args.sessionId,
    workspaceId: args.workspaceId,
    boardId: args.boardId,
    meta: { participantCount: args.participantCount, title: args.title ?? "" },
  });
}

// ── reads ─────────────────────────────────────────────────────────────────────

/** One-shot read of a workspace's activity, newest-first. */
export async function getWorkspaceActivity(
  workspaceId: string,
  max: number = DEFAULT_FEED_LIMIT
): Promise<ActivityEvent[]> {
  const q = query(
    activityRef(workspaceId),
    orderBy("createdAt", "desc"),
    limitTo(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => mapEvent(d.id, d.data()));
}

/** One-shot read of a single board's activity history, newest-first. */
export async function getBoardActivity(
  workspaceId: string,
  boardId: string,
  max: number = DEFAULT_FEED_LIMIT
): Promise<ActivityEvent[]> {
  const q = query(
    activityRef(workspaceId),
    where("boardId", "==", boardId),
    orderBy("createdAt", "desc"),
    limitTo(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => mapEvent(d.id, d.data()));
}

/** Realtime subscription to a workspace's activity, newest-first. */
export function subscribeToWorkspaceActivity(
  workspaceId: string,
  onChange: (events: ActivityEvent[]) => void,
  max: number = DEFAULT_FEED_LIMIT
): () => void {
  const q = query(
    activityRef(workspaceId),
    orderBy("createdAt", "desc"),
    limitTo(max)
  );
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => mapEvent(d.id, d.data())));
  });
}

/** Realtime subscription to one board's activity history, newest-first. */
export function subscribeToBoardActivity(
  workspaceId: string,
  boardId: string,
  onChange: (events: ActivityEvent[]) => void,
  max: number = DEFAULT_FEED_LIMIT
): () => void {
  const q = query(
    activityRef(workspaceId),
    where("boardId", "==", boardId),
    orderBy("createdAt", "desc"),
    limitTo(max)
  );
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => mapEvent(d.id, d.data())));
  });
}
