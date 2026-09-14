import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Bounds } from "../lib/viewport";
import type { CommentPin } from "../components/CommentPinLayer";
import * as commentService from "../services/commentService";
import * as activityService from "../services/activityService";
import { notifyMentions } from "../services/notificationService";
import { extractMentionUids } from "../lib/mentions";
import { captureException } from "../lib/errorReporting";
import { Comment, CommentAnchorKind } from "../types";

/**
 * Board comments (Month 5/6 Task 1 — extracted verbatim from `app/board/[id].tsx`).
 *
 * Owns the realtime thread set, the open thread (or a pending new-comment
 * anchor), the in-flight write gate, and the client-side unread baseline. Unread
 * is client-side: a comment is unread when its latest activity is newer than the
 * viewer's last-seen baseline (persisted per board to AsyncStorage) and the
 * activity isn't the viewer's own.
 *
 * Pin *geometry* stays a join with the element model, so `pinsFrom` takes a
 * `boxOf` resolver rather than reading elements directly — the screen memoizes
 * over it, which is what keeps panning from recomputing pins.
 */

/** The minimum shape this hook needs from the signed-in auth user. */
export interface CommentsUser {
  uid: string;
}

/** A new comment's anchor: an element plus the tap offset inside its box. */
export interface PendingCommentAnchor {
  anchorElementId: string;
  anchorKind: CommentAnchorKind;
  offsetX: number;
  offsetY: number;
}

/** Resolves an element id to its current board-space box, or null when detached. */
export type ElementBoxResolver = (elId: string, kind?: string) => Bounds | null;

export interface BoardCommentsOptions {
  user: CommentsUser | null;
  /** Display name stamped on new comments/replies and the activity feed. */
  authorName: string;
  /** The board's workspace id (empty string for legacy boards) — activity feed. */
  workspaceId: string;
  /** The board's title, used in the @-mention notification body. */
  boardTitle: string;
  /** Surface a user-facing failure in the screen's error banner. */
  onError: (message: string) => void;
}

export interface BoardComments {
  comments: Comment[];
  activeCommentId: string | null;
  /** The open thread, resolved from `activeCommentId`. Null when none is open. */
  activeComment: Comment | null;
  pendingAnchor: PendingCommentAnchor | null;
  /** True while a comment write is in flight. */
  busy: boolean;
  /** True when the thread panel (an open thread or a new-comment composer) shows. */
  panelVisible: boolean;

  /** Resolve every comment to a screen pin at its anchored element. */
  pinsFrom: (boxOf: ElementBoxResolver) => CommentPin[];

  openThread: (commentId: string) => void;
  closePanel: () => void;
  /** Start a new comment anchored to an element. */
  beginAnchor: (anchor: PendingCommentAnchor) => void;

  create: (body: string) => Promise<void>;
  reply: (body: string) => Promise<void>;
  toggleResolve: () => Promise<void>;
  remove: () => Promise<void>;

  /** Delete every comment on the board (composed with the element clear). */
  clearBoardComments: () => Promise<void>;
  /** Drop the local thread set and close the panel (after a successful clear). */
  resetLocal: () => void;
}

export function useBoardComments(
  boardId: string,
  opts: BoardCommentsOptions
): BoardComments {
  const { user, authorName, workspaceId, boardTitle, onError } = opts;

  // Phase 7 — comments. The realtime thread set, the currently-open thread (or a
  // pending new-comment anchor), and a busy flag for in-flight writes.
  const [comments, setComments] = useState<Comment[]>([]);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<PendingCommentAnchor | null>(null);
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentsViewedAt, setCommentsViewedAt] = useState(0);

  // Phase 7 — realtime comments + the per-board unread baseline (AsyncStorage).
  useEffect(() => {
    if (!boardId) return;
    return commentService.subscribeToBoardComments(boardId, setComments);
  }, [boardId]);

  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    AsyncStorage.getItem(`comments-viewed:${boardId}`)
      .then((v) => {
        if (!cancelled) setCommentsViewedAt(v ? Number(v) || 0 : 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  // Persist the unread baseline to "now" so currently-visible activity reads as
  // seen. Coarse but cheap (no per-comment write): opening any thread clears the
  // board's unread markers.
  const markCommentsViewed = useCallback(() => {
    const now = Date.now();
    setCommentsViewedAt(now);
    AsyncStorage.setItem(`comments-viewed:${boardId}`, String(now)).catch(() => {});
  }, [boardId]);

  const openThread = (commentId: string) => {
    setPendingAnchor(null);
    setActiveCommentId(commentId);
    markCommentsViewed();
  };

  const closePanel = () => {
    setActiveCommentId(null);
    setPendingAnchor(null);
  };

  const beginAnchor = (anchor: PendingCommentAnchor) => {
    setActiveCommentId(null);
    setPendingAnchor(anchor);
  };

  const activeComment = activeCommentId
    ? comments.find((c) => c.id === activeCommentId) ?? null
    : null;

  // Resolve every comment to a screen pin at its anchored element. Detached
  // comments (anchor deleted) get no pin. Numbering is creation order over the
  // full set so it stays stable as pins appear/disappear. Memoized on the
  // comment set so the caller can memoize over it and panning never recomputes.
  const pinsFrom = useCallback(
    (boxOf: ElementBoxResolver): CommentPin[] => {
      const out: CommentPin[] = [];
      comments.forEach((c, i) => {
        const box = boxOf(c.anchorElementId, c.anchorKind);
        if (!box) return;
        const last = commentService.lastActivityMs(c);
        out.push({
          id: c.id,
          x: box.minX + c.offsetX,
          y: box.minY + c.offsetY,
          number: i + 1,
          resolved: c.resolved,
          unread: last > commentsViewedAt && c.authorId !== user?.uid,
        });
      });
      return out;
    },
    [comments, commentsViewedAt, user?.uid]
  );

  const create = async (body: string) => {
    if (!pendingAnchor || !user) return;
    setCommentBusy(true);
    try {
      const newId = await commentService.addComment(boardId, {
        ...pendingAnchor,
        authorId: user.uid,
        authorName,
        body,
      });
      // Phase 8: log the new comment to the workspace activity feed (fire-and-forget).
      activityService.logCommentCreated({
        workspaceId,
        boardId,
        commentId: newId,
        actorId: user.uid,
        actorName: authorName,
        anchorElementId: pendingAnchor.anchorElementId,
      });
      // Phase 10: fan @-mentions out to push + in-app notifications (fire-and-forget).
      const mentionUids = extractMentionUids(body);
      if (mentionUids.length > 0) {
        notifyMentions({
          mentionUids,
          actorId: user.uid,
          actorName: authorName,
          boardId,
          boardTitle,
          commentId: newId,
          body,
        });
      }
      setPendingAnchor(null);
      setActiveCommentId(newId);
      markCommentsViewed();
    } catch (e) {
      captureException(e, { op: "board.addComment" });
      onError("Failed to add comment.");
    } finally {
      setCommentBusy(false);
    }
  };

  const reply = async (body: string) => {
    if (!activeCommentId || !user) return;
    setCommentBusy(true);
    try {
      await commentService.addReply(boardId, activeCommentId, {
        authorId: user.uid,
        authorName,
        body,
        createdAtMs: Date.now(),
      });
      // Phase 10: fan @-mentions in the reply out to notifications (fire-and-forget).
      const mentionUids = extractMentionUids(body);
      if (mentionUids.length > 0) {
        notifyMentions({
          mentionUids,
          actorId: user.uid,
          actorName: authorName,
          boardId,
          boardTitle,
          commentId: activeCommentId,
          body,
        });
      }
      markCommentsViewed();
    } catch (e) {
      captureException(e, { op: "board.replyComment" });
      onError("Failed to add reply.");
    } finally {
      setCommentBusy(false);
    }
  };

  const toggleResolve = async () => {
    if (!activeComment) return;
    setCommentBusy(true);
    try {
      await commentService.setResolved(boardId, activeComment.id, !activeComment.resolved);
    } catch (e) {
      captureException(e, { op: "board.resolveComment" });
      onError("Failed to update comment.");
    } finally {
      setCommentBusy(false);
    }
  };

  const remove = async () => {
    if (!activeComment) return;
    setCommentBusy(true);
    try {
      await commentService.deleteComment(boardId, activeComment.id);
      closePanel();
    } catch (e) {
      captureException(e, { op: "board.deleteComment" });
      onError("Failed to delete comment.");
    } finally {
      setCommentBusy(false);
    }
  };

  const clearBoardComments = () => commentService.clearBoardComments(boardId);

  const resetLocal = () => {
    setComments([]);
    closePanel();
  };

  return {
    comments,
    activeCommentId,
    activeComment,
    pendingAnchor,
    busy: commentBusy,
    panelVisible: !!activeComment || !!pendingAnchor,
    pinsFrom,
    openThread,
    closePanel,
    beginAnchor,
    create,
    reply,
    toggleResolve,
    remove,
    clearBoardComments,
    resetLocal,
  };
}
