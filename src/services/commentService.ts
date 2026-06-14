import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
  updateDoc,
  onSnapshot,
  arrayUnion,
  writeBatch,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { Comment, CommentAnchorKind, CommentReply } from "../types";
import { randomCode } from "../lib/secureRandom";
import { extractMentionUids } from "../lib/mentions";

// Phase 7 (Month 3, roadmap item 7). Comments anchored to canvas elements, with
// inline reply threads + resolve/reopen. Mirrors the shapeService subcollection
// pattern: one doc per comment under `boards/{id}/comments`, an ordered realtime
// subscription, and a `mapCommentDoc` that defaults legacy/partial docs so the
// rest of the app can treat every field as present.
//
// Replies live in the comment doc's `replies` array (a thread is small and is
// always read whole), so a reply is one updateDoc(arrayUnion) — no subcollection
// round-trip. Reply timestamps are epoch-ms numbers because serverTimestamp() is
// rejected inside array elements (see CommentReply).

// Alphabet for client-generated reply ids (replies live in an array, so they need
// a locally-unique id rather than a Firestore doc id).
const REPLY_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

const ANCHOR_KINDS: CommentAnchorKind[] = ["path", "shape", "text", "note", "image"];

function readAnchorKind(v: any): CommentAnchorKind {
  return ANCHOR_KINDS.includes(v) ? v : "shape";
}

function mapReply(data: any): CommentReply {
  return {
    id: data?.id ?? "",
    authorId: data?.authorId ?? "",
    authorName: data?.authorName ?? "User",
    body: data?.body ?? "",
    mentions: Array.isArray(data?.mentions) ? data.mentions : [],
    createdAtMs: typeof data?.createdAtMs === "number" ? data.createdAtMs : 0,
  };
}

function mapCommentDoc(id: string, data: any): Comment | null {
  if (!data || !data.anchorElementId) return null;
  const replies: CommentReply[] = Array.isArray(data.replies) ? data.replies.map(mapReply) : [];
  // Replies are appended via arrayUnion and so may not arrive ordered; sort them
  // oldest-first to match the thread display.
  replies.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return {
    id,
    boardId: data.boardId ?? "",
    anchorElementId: data.anchorElementId,
    anchorKind: readAnchorKind(data.anchorKind),
    offsetX: typeof data.offsetX === "number" ? data.offsetX : 0,
    offsetY: typeof data.offsetY === "number" ? data.offsetY : 0,
    authorId: data.authorId ?? "",
    authorName: data.authorName ?? "User",
    body: data.body ?? "",
    mentions: Array.isArray(data.mentions) ? data.mentions : [],
    replies,
    resolved: !!data.resolved,
    createdAt: data.createdAt?.toDate() ?? new Date(),
    updatedAt: data.updatedAt?.toDate() ?? data.createdAt?.toDate() ?? new Date(),
  };
}

export type NewComment = {
  anchorElementId: string;
  anchorKind: CommentAnchorKind;
  offsetX: number;
  offsetY: number;
  authorId: string;
  authorName: string;
  body: string;
};

/**
 * Creates a comment anchored to an element. Resolves to the new comment id.
 * `mentions` (the uids of any @-mentioned members, Phase 10) is parsed from the
 * body and denormalized so the notification fan-out doesn't re-parse.
 */
export async function addComment(boardId: string, input: NewComment): Promise<string> {
  const ref = collection(db, "boards", boardId, "comments");
  const docRef = await addDoc(ref, {
    boardId,
    anchorElementId: input.anchorElementId,
    anchorKind: input.anchorKind,
    offsetX: input.offsetX,
    offsetY: input.offsetY,
    authorId: input.authorId,
    authorName: input.authorName,
    body: input.body,
    mentions: extractMentionUids(input.body),
    replies: [],
    resolved: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

/**
 * Appends a reply to a comment thread. The reply id + timestamp are generated
 * client-side (epoch ms) because arrayUnion can't carry serverTimestamp(); the
 * comment's `updatedAt` is bumped server-side so threads sort by recent activity.
 */
export async function addReply(
  boardId: string,
  commentId: string,
  reply: { authorId: string; authorName: string; body: string; createdAtMs: number }
): Promise<CommentReply> {
  const entry: CommentReply = {
    id: randomCode(16, REPLY_ID_CHARS),
    authorId: reply.authorId,
    authorName: reply.authorName,
    body: reply.body,
    mentions: extractMentionUids(reply.body),
    createdAtMs: reply.createdAtMs,
  };
  await updateDoc(doc(db, "boards", boardId, "comments", commentId), {
    replies: arrayUnion(entry),
    updatedAt: serverTimestamp(),
  });
  return entry;
}

/** Marks a comment resolved or reopens it. */
export async function setResolved(
  boardId: string,
  commentId: string,
  resolved: boolean
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId, "comments", commentId), {
    resolved,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteComment(boardId: string, commentId: string): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId, "comments", commentId));
}

/** Deletes every comment on a board, in 500-doc batches (board clear/delete). */
export async function clearBoardComments(boardId: string): Promise<void> {
  const snap = await getDocs(collection(db, "boards", boardId, "comments"));
  for (let i = 0; i < snap.docs.length; i += 500) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 500).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

export async function getComment(boardId: string, commentId: string): Promise<Comment | null> {
  const snap = await getDoc(doc(db, "boards", boardId, "comments", commentId));
  if (!snap.exists()) return null;
  return mapCommentDoc(snap.id, snap.data());
}

/** Realtime subscription to a board's comments, ordered oldest-first. */
export function subscribeToBoardComments(
  boardId: string,
  onChange: (comments: Comment[]) => void
): () => void {
  const q = query(collection(db, "boards", boardId, "comments"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snapshot) => {
    const comments = snapshot.docs
      .map((d) => mapCommentDoc(d.id, d.data()))
      .filter((c): c is Comment => c !== null);
    onChange(comments);
  });
}

/**
 * Timestamp (epoch ms) of the most recent activity in a thread — the latest of
 * the comment's own creation and its replies. Drives the client-side unread
 * marker (a comment is unread when this is newer than the viewer's last-seen
 * time and the activity isn't theirs).
 */
export function lastActivityMs(comment: Comment): number {
  const replyMax = comment.replies.reduce((m, r) => Math.max(m, r.createdAtMs), 0);
  return Math.max(comment.createdAt.getTime(), comment.updatedAt.getTime(), replyMax);
}
