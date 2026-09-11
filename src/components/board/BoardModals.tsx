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
import ColorPickerModal from "../ColorPickerModal";
import StrokeWidthModal from "../StrokeWidthModal";
import type { BoardDocument } from "../../hooks/useBoardDocument";
import type { BoardComments, ElementBoxResolver } from "../../hooks/useBoardComments";
import type { BoardAI } from "../../hooks/useBoardAI";
import type { BoardPresence, Plan } from "../../types";
import type { UpsellResource } from "../upsellCopy";

/**
 * The board's dialog layer (Month 5/6 Task 1 — extracted verbatim from
 * `app/board/[id].tsx`).
 *
 * Every board-level dialog, in the order the screen declared them: the deep-link
 * join prompt, the share sheet, the activity history, the shortcuts cheat sheet,
 * the background picker, the comment thread panel, the session composer, the
 * diagram prompt, and (Month 5, ROADMAP item 12) the colour and stroke-width
 * pickers. All are React Native `<Modal>`s, which render above the parent view
 * hierarchy, so their relative order is what matters — and that is preserved
 * exactly.
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

  /** The plan-limit upsell, driven by whichever create/AI action on this
   *  screen last hit a quota denial (session create, or one of the three AI
   *  affordances via `ai`). Null hides it. */
  upsellResource: UpsellResource | null;
  onDismissUpsell: () => void;
  /** StartSessionModal caught a quota denial (isQuotaDenial — the server's
   *  own resource-exhausted rejection, or the client-side pre-flight's own
   *  QuotaExceededError, which carries no code): close the session composer
   *  and show the upsell in its place. */
  onSessionQuotaExceeded: () => void;

  // Month 5 — colour + stroke polish (ROADMAP items 12 + 14). Both modals
  // are opened from a "Colour"/"Width" pill in `Toolbar`/`PenOptionsBar`;
  // visibility stays screen state, same convention as every other modal here.
  colorPickerVisible: boolean;
  onCloseColorPicker: () => void;
  activeColor: string;
  activeAlpha: number;
  onChangeColor: (hex: string, alpha: number) => void;
  recentColors: string[];
  /** The board's workspace plan — the advisory Pro gate `ColorPickerModal`
   *  reads for the swatch-palette badge (see
   *  `workspaceService.ts#canUseCustomPalette`'s header). */
  plan: Plan;
  /** Whether the CALLER may write workspace-doc fields beyond its name (see
   *  `ColorPickerModal`'s identical prop doc — firestore.rules restricts
   *  `swatches` writes to workspace owner/admin regardless of plan). */
  canManageWorkspace: boolean;
  workspaceSwatches: string[];
  onAddSwatch: (hex: string) => void;
  /** A free-plan member tapped the swatch row's "Pro" badge — routes to the
   *  SAME upsell machinery as the session/AI quota denials above
   *  (`upsellResource="customPalette"`), rather than a bespoke modal. Mirrors
   *  `AudioAffordance`'s `onUpgradeRequested`. */
  onRequestPaletteUpgrade: () => void;

  widthPickerVisible: boolean;
  onCloseWidthPicker: () => void;
  activeStrokeWidth: number;
  onChangeStrokeWidth: (w: number) => void;

  /**
   * Month 5 — true while an active, unpaused presenter locks out everyone
   * else's new content creation (`useBoardCollab`'s
   * `presenterLocksContentCreation`; always false on the presenter's own
   * client). The single narrow addition to this layer's prop contract: it
   * gates `DiagramPromptModal`'s "Draw" button, the one content-creation
   * surface this component itself owns — `generateDiagram` writes a whole
   * batch of elements and spends AI quota, and the modal can already be open
   * when a presentation starts (it isn't tied to canvas gesture state), so
   * gating only the header button that opens it (`BoardHeader`,
   * `app/board/[id].tsx`) left this "already open" case reachable. UI-only
   * affordance, same as every other presenter-lock check in this codebase —
   * no Firestore rule backs it.
   */
  presenterLocksContentCreation: boolean;
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
  colorPickerVisible,
  onCloseColorPicker,
  activeColor,
  activeAlpha,
  onChangeColor,
  recentColors,
  plan,
  canManageWorkspace,
  workspaceSwatches,
  onAddSwatch,
  onRequestPaletteUpgrade,
  widthPickerVisible,
  onCloseWidthPicker,
  activeStrokeWidth,
  onChangeStrokeWidth,
  presenterLocksContentCreation,
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

      {/* Phase 12 — text → diagram prompt sheet. Month 5: `onGenerate` is
          gated (not `visible`/`onClose`) so a prompt already open when a
          presentation starts can still be seen and closed, just not
          submitted — see the `presenterLocksContentCreation` prop doc. */}
      {ai.diagramEnabled && (
        <DiagramPromptModal
          visible={ai.diagramOpen}
          prompt={ai.diagramPrompt}
          busy={ai.diagramBusy}
          onChangePrompt={ai.setDiagramPrompt}
          onGenerate={presenterLocksContentCreation ? undefined : ai.generateDiagram}
          onClose={ai.closeDiagram}
        />
      )}

      {/* Month 5 — colour + stroke polish (ROADMAP item 12). Hex/alpha
          picker, recent colours, and the per-workspace swatch palette
          (item 14's Pro badge). */}
      <ColorPickerModal
        visible={colorPickerVisible}
        onClose={onCloseColorPicker}
        color={activeColor}
        alpha={activeAlpha}
        onChange={onChangeColor}
        recentColors={recentColors}
        plan={plan}
        canManageWorkspace={canManageWorkspace}
        workspaceSwatches={workspaceSwatches}
        onAddSwatch={onAddSwatch}
        onUpgradeRequested={onRequestPaletteUpgrade}
      />

      <StrokeWidthModal
        visible={widthPickerVisible}
        onClose={onCloseWidthPicker}
        strokeWidth={activeStrokeWidth}
        onChange={onChangeStrokeWidth}
      />

      {/* Plan-limit upsell, for session create (above) and the three AI
          affordances (`ai`, via useBoardAI's onQuotaExceeded bridge callback),
          and now the custom-palette Pro badge above. Rendered only once
          there's an actual resource to show — no placeholder `resource`
          fallback paired with a false `visible`. */}
      {upsellResource && (
        <UpsellModal
          visible
          resource={upsellResource}
          plan={doc.boardWorkspace?.plan}
          workspaceId={doc.board?.workspaceId}
          onDismiss={onDismissUpsell}
        />
      )}
    </>
  );
}
