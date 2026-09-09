import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Animated } from "react-native";
import * as boardService from "../services/boardService";
import * as friendService from "../services/friendService";
import * as sessionService from "../services/sessionService";
import * as activityService from "../services/activityService";
import { getWorkspace } from "../services/workspaceService";
import { MentionMember } from "../lib/mentions";
import { captureException } from "../lib/errorReporting";
import {
  Board,
  BackgroundTemplate,
  BoardRole,
  Session,
  Workspace,
} from "../types";

/**
 * The board *document* — everything about the board record itself, as opposed to
 * the content drawn on it (Month 5/6 Task 1, extracted verbatim from
 * `app/board/[id].tsx`).
 *
 * Owns the doc load (plus the Phase 6 workspace resolution and the Phase 10
 * @-mention roster it seeds), the effective per-board role, the debounced
 * `updatedAt` bump and its "Saved" toast, the optimistic patches applied when
 * membership / admin / background change, and the admin-owned session lifecycle.
 *
 * Like the other board hooks it takes only plain data and screen-owned callbacks,
 * so it composes with anything. It is called first in the screen because the role
 * flags and `scheduleSave` feed the element model.
 */

/** The minimum shape this hook needs from the signed-in auth user. */
export interface BoardDocumentUser {
  uid: string;
}

export interface BoardDocumentOptions {
  user: BoardDocumentUser | null;
  /** Display name recorded against a session-ended activity entry. */
  displayName: string;
  /**
   * Read-only embed mode. An embed viewer is intentionally a non-member with no
   * join path, so the deep-link join prompt is suppressed.
   */
  embedMode: boolean;
  /** Rasterize the whole canvas — the final image frozen onto an ended session. */
  captureBoard: () => Promise<string | null>;
  /** The board no longer exists; the screen navigates away. */
  onNotFound: () => void;
  /** The viewer isn't a member yet — prompt them to join with this invite code. */
  onJoinPrompt: (inviteCode?: string) => void;
  /** Surface a user-facing failure in the screen's error banner. */
  onError: (message: string) => void;
}

export interface BoardDocument {
  board: Board | null;
  /** The board's workspace, for per-board role resolution. Null for legacy boards. */
  boardWorkspace: Workspace | null;
  /** Workspace members resolved for @-mention autocomplete. Empty when none. */
  mentionMembers: MentionMember[];
  loading: boolean;
  /** Re-read the board doc (after joining via a deep link, say). */
  reload: () => void;

  // Roles (Phase 6)
  isAdmin: boolean;
  effectiveRole: BoardRole | undefined;
  /** Editors write canvas content. Advisory — the security rules enforce it. */
  canEdit: boolean;
  /** Commenters (and editors) may comment; pure viewers cannot. */
  canComment: boolean;

  // Saving
  /** Debounced bump of the board's `updatedAt`. */
  scheduleSave: () => void;
  /** Write immediately and flash the "Saved" toast. */
  saveNow: () => Promise<void>;
  /** Drives the "Saved" toast's opacity. */
  saveOpacity: Animated.Value;
  showSaveToast: () => void;

  // Optimistic local patches (the board doc isn't subscribed — remote members
  // pick these up on their next load).
  addMember: (uid: string) => void;
  setAdmin: (newAdminId: string) => void;
  setAccess: (access: { members: string[]; roles: Record<string, BoardRole> }) => void;
  setBackground: (template: BackgroundTemplate) => void;

  // Session lifecycle
  activeSession: Session | null;
  endingSession: boolean;
  refreshActiveSession: () => Promise<void>;
  endSession: () => Promise<void>;
}

export function useBoardDocument(
  boardId: string,
  opts: BoardDocumentOptions
): BoardDocument {
  const {
    user,
    displayName,
    embedMode,
    captureBoard,
    onNotFound,
    onJoinPrompt,
    onError,
  } = opts;

  const [board, setBoard] = useState<Board | null>(null);
  // Phase 6 — the board's workspace, fetched for per-board role resolution (the
  // role floor). Null for legacy boards or while loading.
  const [boardWorkspace, setBoardWorkspace] = useState<Workspace | null>(null);
  // Phase 10 — workspace members resolved to {uid, displayName} for @-mention
  // autocomplete in the comment composer. Empty for legacy/no-workspace boards.
  const [mentionMembers, setMentionMembers] = useState<MentionMember[]>([]);
  const [loading, setLoading] = useState(true);

  // Active admin-owned session for this board (drives End Session button)
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [endingSession, setEndingSession] = useState(false);

  // Save toast animation
  const saveOpacity = useRef(new Animated.Value(0)).current;
  // Auto-save debounce
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadBoard = async () => {
    try {
      setLoading(true);
      const boardData = await boardService.getBoard(boardId);

      if (!boardData) {
        Alert.alert("Not Found", "This board no longer exists.");
        onNotFound();
        return;
      }

      setBoard(boardData);

      // Phase 6 — resolve the board's workspace for per-board role math. Best-effort:
      // a failure (or a legacy board with no workspaceId) leaves the floor unset and
      // the resolver falls back to the legacy "any member edits" behavior.
      if (boardData.workspaceId) {
        getWorkspace(boardData.workspaceId)
          .then((ws) => {
            setBoardWorkspace(ws);
            // Phase 10 — resolve workspace member uids to display names for the
            // @-mention autocomplete. Best-effort: a failure just leaves the list
            // empty (no autocomplete), it never blocks the board.
            if (ws) {
              friendService
                .getUsersByIds(Object.keys(ws.members))
                .then((users) =>
                  setMentionMembers(
                    users.map((u) => ({ uid: u.uid, displayName: u.displayName }))
                  )
                )
                .catch(() => setMentionMembers([]));
            } else {
              setMentionMembers([]);
            }
          })
          .catch(() => {
            setBoardWorkspace(null);
            setMentionMembers([]);
          });
      } else {
        setBoardWorkspace(null);
        setMentionMembers([]);
      }

      // Deep-link gate: if the viewer isn't a member yet, prompt them to join.
      // Never in embed mode — an embed viewer is intentionally a non-member and
      // has no join path; the prompt would be a dead end.
      if (!embedMode && user && !boardData.members.includes(user.uid)) {
        onJoinPrompt(boardData.inviteCode);
      }
    } catch {
      Alert.alert("Error", "Failed to load board");
    } finally {
      setLoading(false);
    }
  };

  // Load board data on mount
  useEffect(() => {
    if (!boardId) return;
    loadBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  // Clear debounce timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Derived
  const isAdmin = !!user && !!board && user.uid === board.adminId;
  // Phase 6 — effective per-board role. Editors write canvas content; viewers/
  // commenters are read-only (the toolbar editing tools are hidden for them, and
  // the security rules enforce it server-side regardless).
  const effectiveRole: BoardRole | undefined =
    user && board
      ? boardService.effectiveBoardRole(board, boardWorkspace, user.uid)
      : undefined;

  // Debounced save — updates the board's updatedAt timestamp
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await boardService.updateBoard(boardId, {});
      } catch {
        // Silent fail for timestamp update
      }
    }, 2000);
  }, [boardId]);

  const showSaveToast = () => {
    saveOpacity.setValue(1);
    Animated.timing(saveOpacity, {
      toValue: 0,
      duration: 1500,
      delay: 800,
      useNativeDriver: true,
    }).start();
  };

  const saveNow = async () => {
    try {
      await boardService.updateBoard(boardId, {});
      showSaveToast();
    } catch {
      onError("Failed to save board.");
    }
  };

  // --- Optimistic local patches ---

  const addMember = (uid: string) => {
    if (uid && board) {
      setBoard((prev) =>
        prev ? { ...prev, members: [...new Set([...prev.members, uid])] } : prev
      );
    }
  };

  const setAdmin = (newAdminId: string) => {
    setBoard((prev) => (prev ? { ...prev, adminId: newAdminId } : prev));
  };

  const setAccess = (access: { members: string[]; roles: Record<string, BoardRole> }) => {
    setBoard((prev) => (prev ? { ...prev, ...access } : prev));
  };

  // Phase 12: change the board's background template. Optimistic local patch +
  // persist (the board doc isn't subscribed, mirroring title/admin — remote
  // members pick up the change on their next load).
  const setBackground = (template: BackgroundTemplate) => {
    setBoard((prev) => (prev ? { ...prev, backgroundTemplate: template } : prev));
    boardService
      .updateBoard(boardId, { backgroundTemplate: template })
      .catch((e) => {
        captureException(e, { op: "board.setBackground" });
        onError("Failed to change background.");
      });
  };

  // --- Session lifecycle ---

  // Find an admin-owned active session for this board.
  // Use the user-scoped query (rules-compatible) and filter client-side by board.
  const refreshActiveSession = useCallback(async () => {
    if (!boardId || !user) return;
    try {
      const sessions = await sessionService.getSessionsForUser(user.uid);
      const mine = sessions.find(
        (s) => s.boardId === boardId && s.status === "active" && s.createdById === user.uid
      );
      setActiveSession(mine ?? null);
    } catch (err) {
      console.warn("[board] refreshActiveSession failed:", err);
    }
  }, [boardId, user]);

  useEffect(() => {
    refreshActiveSession();
  }, [refreshActiveSession]);

  const endSession = async () => {
    if (!activeSession) return;
    setEndingSession(true);
    try {
      // Phase 3: unified capture — web rasterizes the DOM <svg>, native uses
      // react-native-svg's toDataURL. Both go through captureBoardImage.
      const snapshot = await captureBoard();
      console.log(
        "[end-session] snapshot=",
        snapshot ? `${Math.round(snapshot.length / 1024)}KB` : "null"
      );
      // Phase 4: a single lifecycle transition stamps endedAt, freezes the
      // participant snapshot, and persists the final canvas image together.
      const participants = await sessionService.resolveParticipantSnapshot(activeSession);
      await sessionService.endSession(activeSession.id, { participants, snapshot });
      // Phase 8: record the session end in the workspace activity feed
      // (fire-and-forget; logging never blocks ending the session).
      activityService.logSessionEnded({
        workspaceId: activeSession.workspaceId || board?.workspaceId || "",
        boardId: activeSession.boardId,
        sessionId: activeSession.id,
        actorId: user?.uid ?? "",
        actorName: displayName,
        participantCount: activeSession.participantIds.length,
        title: activeSession.title,
      });
      setActiveSession(null);
      showSaveToast();
    } catch {
      onError("Failed to end session.");
    } finally {
      setEndingSession(false);
    }
  };

  return {
    board,
    boardWorkspace,
    mentionMembers,
    loading,
    reload: loadBoard,

    isAdmin,
    effectiveRole,
    canEdit: boardService.canEditBoardRole(effectiveRole),
    canComment: boardService.canCommentBoardRole(effectiveRole),

    scheduleSave,
    saveNow,
    saveOpacity,
    showSaveToast,

    addMember,
    setAdmin,
    setAccess,
    setBackground,

    activeSession,
    endingSession,
    refreshActiveSession,
    endSession,
  };
}
