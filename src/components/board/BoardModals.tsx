import React from "react";
import JoinBoardModal from "../JoinBoardModal";
import ShareBoardModal from "../ShareBoardModal";
import BoardHistoryPanel from "../BoardHistoryPanel";
import ShortcutsCheatSheet from "../ShortcutsCheatSheet";
import BackgroundPicker from "../BackgroundPicker";
import CommentThreadPanel from "../CommentThreadPanel";
import StartSessionModal from "../StartSessionModal";
import DiagramPromptModal from "../DiagramPromptModal";
import type { BoardDocument } from "../../hooks/useBoardDocument";
import type { BoardElements } from "../../hooks/useBoardElements";
import type { BoardTools } from "../../hooks/useBoardTools";
import type { BoardCollab } from "../../hooks/useBoardCollab";
import type { BoardComments } from "../../hooks/useBoardComments";
import type { BoardAI } from "../../hooks/useBoardAI";

/**
 * The board's dialog layer (Month 5/6 Task 1 — extracted verbatim from
 * `app/board/[id].tsx`).
 *
 * Every board-level dialog, in the order the screen declared them: the deep-link
 * join prompt, the share sheet, the activity history, the shortcuts cheat sheet,
 * the background picker, the comment thread panel, the session composer and the
 * diagram prompt. All eight are React Native `<Modal>`s, which render above the
 * parent view hierarchy, so their relative order is what matters — and that is
 * preserved exactly.
 *
 * Visibility stays screen state (the header and the canvas open these), so this
 * component only renders; it holds none of it.
 */

interface BoardModalsProps {
  boardId: string;
  currentUserId: string;
  /** Display name used as the session's admin name. */
  adminName: string;

  doc: BoardDocument;
  /** Only for the comment panel's "detached" check (the anchor box resolver). */
  elements: BoardElements;
  tools: BoardTools;
  collab: BoardCollab;
  comments: BoardComments;
  ai: BoardAI;

  joinVisible: boolean;
  joinInviteCode?: string;
  onJoined: () => void;
  onJoinCancel: () => void;

  shareVisible: boolean;
  onCloseShare: () => void;

  historyVisible: boolean;
  onCloseHistory: () => void;

  bgPickerVisible: boolean;
  onCloseBgPicker: () => void;

  sessionVisible: boolean;
  onCloseSession: () => void;
}

export default function BoardModals({
  boardId,
  currentUserId,
  adminName,
  doc,
  elements,
  tools,
  collab,
  comments,
  ai,
  joinVisible,
  joinInviteCode,
  onJoined,
  onJoinCancel,
  shareVisible,
  onCloseShare,
  historyVisible,
  onCloseHistory,
  bgPickerVisible,
  onCloseBgPicker,
  sessionVisible,
  onCloseSession,
}: BoardModalsProps) {
  const activeComment = comments.activeComment;
  const activeCommentDetached =
    !!activeComment &&
    elements.boxOfElement(activeComment.anchorElementId, activeComment.anchorKind) === null;

  return (
    <>
      <JoinBoardModal
        visible={joinVisible}
        initialCode={joinInviteCode}
        onClose={onJoinCancel}
        onJoined={onJoined}
      />

      <ShareBoardModal
        visible={shareVisible}
        boardId={boardId}
        inviteCode={doc.board?.inviteCode ?? ""}
        members={doc.board?.members ?? []}
        currentUserId={currentUserId}
        workspaceId={doc.board?.workspaceId ?? ""}
        ownerId={doc.board?.ownerId ?? ""}
        roles={doc.board?.roles ?? {}}
        isAdmin={doc.isAdmin}
        onClose={onCloseShare}
        onMemberAdded={doc.addMember}
        onAccessChanged={doc.setAccess}
      />

      <BoardHistoryPanel
        visible={historyVisible}
        workspaceId={doc.board?.workspaceId ?? ""}
        boardId={boardId}
        onClose={onCloseHistory}
      />

      {/* Keyboard-shortcuts cheat sheet (opened with `?`) */}
      <ShortcutsCheatSheet
        visible={tools.cheatSheetVisible}
        onClose={tools.hideCheatSheet}
      />

      {/* Background-template picker (Phase 12) */}
      <BackgroundPicker
        visible={bgPickerVisible}
        active={doc.board?.backgroundTemplate ?? "blank"}
        onSelect={doc.setBackground}
        onClose={onCloseBgPicker}
      />

      {/* Comment thread / new-comment composer (Phase 7) */}
      <CommentThreadPanel
        visible={comments.panelVisible}
        comment={activeComment}
        currentUserId={currentUserId}
        isAdmin={doc.isAdmin}
        canComment={doc.canComment}
        busy={comments.busy}
        detached={activeCommentDetached}
        members={doc.mentionMembers}
        onCreate={comments.create}
        onReply={comments.reply}
        onToggleResolve={comments.toggleResolve}
        onDelete={comments.remove}
        onClose={comments.closePanel}
      />

      {doc.isAdmin && (
        <StartSessionModal
          visible={sessionVisible}
          boardId={boardId}
          workspaceId={doc.board?.workspaceId ?? ""}
          boardTitle={doc.board?.title ?? "Board"}
          adminId={currentUserId}
          adminName={adminName}
          presenceUsers={collab.presence}
          onClose={onCloseSession}
          onSessionCreated={() => {
            onCloseSession();
            doc.refreshActiveSession();
          }}
        />
      )}

      {/* Phase 12 — text → diagram prompt sheet. */}
      {ai.diagramEnabled && (
        <DiagramPromptModal
          visible={ai.diagramOpen}
          prompt={ai.diagramPrompt}
          busy={ai.diagramBusy}
          onChangePrompt={ai.setDiagramPrompt}
          onGenerate={ai.generateDiagram}
          onClose={ai.closeDiagram}
        />
      )}
    </>
  );
}
