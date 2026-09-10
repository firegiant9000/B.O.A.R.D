import React from "react";
import JoinBoardModal from "../JoinBoardModal";
import ShareBoardModal from "../ShareBoardModal";
import BoardHistoryPanel from "../BoardHistoryPanel";
import ShortcutsCheatSheet from "../ShortcutsCheatSheet";
import BackgroundPicker from "../BackgroundPicker";
import CommentThreadPanel from "../CommentThreadPanel";
import StartSessionModal from "../StartSessionModal";
import DiagramPromptModal from "../DiagramPromptModal";
import UpsellModal from "../UpsellModal";
import type { BoardDocument } from "../../hooks/useBoardDocument";
import type { BoardComments, ElementBoxResolver } from "../../hooks/useBoardComments";
import type { BoardAI } from "../../hooks/useBoardAI";
import type { BoardPresence } from "../../types";
import type { QuotaResource } from "../../services/quotaService";

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
 *
 * It takes `doc`, `comments` and `ai` as composed objects because it genuinely
 * uses most of each. Everything it needs from the element model, the tool state
 * and collaboration is narrow enough to arrive as scalars, which keeps this layer
 * out of those hooks' blast radius.
 */

interface BoardModalsProps {
  boardId: string;
  currentUserId: string;
  /** Display name used as the session's admin name. */
  adminName: string;

  doc: BoardDocument;
  comments: BoardComments;
  ai: BoardAI;

  /** Resolves the open comment's anchor box — null means the thread is detached. */
  boxOfElement: ElementBoxResolver;
  /** Presence roster offered as session invitees. */
  presence: BoardPresence[];
  cheatSheetVisible: boolean;
  onCloseCheatSheet: () => void;

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

  /** Task 11: the plan-limit upsell, driven by whichever create/AI action on
   *  this screen last hit resource-exhausted (session create, or one of the
   *  three AI affordances via `ai`). Null hides it. */
  upsellResource: QuotaResource | null;
  onDismissUpsell: () => void;
  /** StartSessionModal caught resource-exhausted: close the session composer
   *  and show the upsell in its place. */
  onSessionQuotaExceeded: () => void;
}

export default function BoardModals({
  boardId,
  currentUserId,
  adminName,
  doc,
  comments,
  ai,
  boxOfElement,
  presence,
  cheatSheetVisible,
  onCloseCheatSheet,
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
  upsellResource,
  onDismissUpsell,
  onSessionQuotaExceeded,
}: BoardModalsProps) {
  const activeComment = comments.activeComment;
  const activeCommentDetached =
    !!activeComment &&
    boxOfElement(activeComment.anchorElementId, activeComment.anchorKind) === null;

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
        visible={cheatSheetVisible}
        onClose={onCloseCheatSheet}
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
          presenceUsers={presence}
          plan={doc.boardWorkspace?.plan}
          onClose={onCloseSession}
          onSessionCreated={() => {
            onCloseSession();
            doc.refreshActiveSession();
          }}
          onQuotaExceeded={onSessionQuotaExceeded}
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

      {/* Task 11 — plan-limit upsell, for session create (above) and the three
          AI affordances (`ai`, via useBoardAI's onQuotaExceeded bridge callback). */}
      <UpsellModal
        visible={!!upsellResource}
        resource={upsellResource ?? "board"}
        workspaceId={doc.board?.workspaceId}
        onDismiss={onDismissUpsell}
      />
    </>
  );
}
