import React from "react";
import JoinBoardModal from "../JoinBoardModal";
import ShareBoardModal from "../ShareBoardModal";
import BoardHistoryPanel from "../BoardHistoryPanel";
import ShortcutsCheatSheet from "../ShortcutsCheatSheet";
import BackgroundPicker from "../BackgroundPicker";
import CommentThreadPanel from "../CommentThreadPanel";
import BoardQaPanel from "../BoardQaPanel";
import StartSessionModal from "../StartSessionModal";
import DiagramPromptModal from "../DiagramPromptModal";
import UpsellModal from "../UpsellModal";
import ColorPickerModal from "../ColorPickerModal";
import StrokeWidthModal from "../StrokeWidthModal";
import PollComposer, { NewPollInput } from "./PollComposer";
import MathComposerHost from "./MathComposerHost";
import CodeComposerHost from "./CodeComposerHost";
import type { BoardDocument } from "../../hooks/useBoardDocument";
import type { BoardComments, ElementBoxResolver } from "../../hooks/useBoardComments";
import type { BoardAI } from "../../hooks/useBoardAI";
import type { BoardPresence, CodeLanguage, Plan } from "../../types";
import type { UpsellResource } from "../upsellCopy";
import type { Bounds } from "../../lib/viewport";
import type { BoardElementSets } from "../../lib/svgExport";

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
  // Month 6 (ROADMAP A3) — board export (PNG/PDF), surfaced from
  // ShareBoardModal. See that component's own prop docs; these are passed
  // straight through, unconverted, from the screen's `useBoardElements` /
  // canvas ref — the export decisions themselves live in the modal.
  canvasRef: { current: any };
  boardElements: BoardElementSets;
  getContentBounds: () => Bounds | null;

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

  // Month 6 — poll composer (Toolbar's "Insert poll" button opens this).
  // Visibility stays screen state, same convention as every other modal here.
  pollComposerVisible: boolean;
  onClosePollComposer: () => void;
  onCreatePoll: (input: NewPollInput) => void;

  // Month 6 — the equation composer. Opened two ways: Toolbar's equation
  // button (insert, `mathEditingId` null) and a tap on an already-selected
  // math element (edit, `mathEditingId` set). MathComposerHost owns the busy
  // flag and the error copy; only visibility and the edited id are screen
  // state, matching every other modal here.
  mathComposerVisible: boolean;
  mathEditingId: string | null;
  /** The edited element's current LaTeX, or null when inserting. */
  mathInitialLatex: string | null;
  onCloseMathComposer: () => void;
  onCreateMath: (latex: string) => Promise<unknown>;
  onUpdateMath: (elementId: string, latex: string) => Promise<unknown>;

  // Month 6 — the code composer. Opened two ways: Toolbar's code button
  // (insert, `codeEditingId` null) and a tap on an already-selected code
  // element (edit, `codeEditingId` set) — mirrors the equation composer's
  // props exactly. CodeComposerHost owns the busy flag and the error copy.
  codeComposerVisible: boolean;
  codeEditingId: string | null;
  /** The edited element's current source, or null when inserting. */
  codeInitialCode: string | null;
  /** The edited element's current language, or null when inserting. */
  codeInitialLanguage: CodeLanguage | null;
  onCloseCodeComposer: () => void;
  onCreateCode: (code: string, language: CodeLanguage) => Promise<unknown>;
  onUpdateCode: (elementId: string, code: string, language: CodeLanguage) => Promise<unknown>;

  // Month 6 — board Q&A chat panel (BoardHeader's "ask this board" button
  // opens it). Only rendered when the feature is configured, the same shape as
  // the diagram prompt above.
  boardQaEnabled: boolean;
  boardQaVisible: boolean;
  onCloseBoardQa: () => void;
  /** Whether a cited element is still on the board — the board screen's live
   *  element sets answer this. Receives the CANVAS kind (`text`, not
   *  `textElement`); the panel does that translation. */
  isCitationLive: (elementId: string, canvasKind: string) => boolean;
  /** Tapping a live citation: the screen selects that element on the canvas. */
  onSelectCitation: (elementId: string, canvasKind: string) => void;
  /** The workspace is out of board questions — the server said so via
   *  `details.reason`. Routes to the same upsell as every other quota denial. */
  onBoardQaQuotaExceeded: () => void;

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
  canvasRef,
  boardElements,
  getContentBounds,
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
  pollComposerVisible,
  onClosePollComposer,
  mathComposerVisible,
  mathEditingId,
  mathInitialLatex,
  onCloseMathComposer,
  onCreateMath,
  onUpdateMath,
  codeComposerVisible,
  codeEditingId,
  codeInitialCode,
  codeInitialLanguage,
  onCloseCodeComposer,
  onCreateCode,
  onUpdateCode,
  onCreatePoll,
  boardQaEnabled,
  boardQaVisible,
  onCloseBoardQa,
  isCitationLive,
  onSelectCitation,
  onBoardQaQuotaExceeded,
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
        boardTitle={doc.board?.title ?? "Board"}
        canvasRef={canvasRef}
        boardElements={boardElements}
        getContentBounds={getContentBounds}
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

      {/* Month 6 — the poll-creation form (Toolbar's "Insert poll" button). */}
      <PollComposer
        visible={pollComposerVisible}
        onCancel={onClosePollComposer}
        onSubmit={onCreatePoll}
      />

      {/* Month 6 — the equation composer (Toolbar's equation button to
          insert, a tap on an already-selected equation to edit). */}
      <MathComposerHost
        visible={mathComposerVisible}
        editingId={mathEditingId}
        initialLatex={mathInitialLatex}
        onCreate={onCreateMath}
        onUpdate={onUpdateMath}
        onClose={onCloseMathComposer}
      />

      {/* Month 6 — the code composer (Toolbar's code button to insert, a tap
          on an already-selected code element to edit). */}
      <CodeComposerHost
        visible={codeComposerVisible}
        editingId={codeEditingId}
        initialCode={codeInitialCode}
        initialLanguage={codeInitialLanguage}
        onCreate={onCreateCode}
        onUpdate={onUpdateCode}
        onClose={onCloseCodeComposer}
      />

      {/* Month 6 — board Q&A chat. Mounted only when configured, so a build
          with the feature off never loads the panel's callable wiring at all. */}
      {boardQaEnabled && (
        <BoardQaPanel
          visible={boardQaVisible}
          boardId={boardId}
          onClose={onCloseBoardQa}
          isCitationLive={isCitationLive}
          onSelectCitation={onSelectCitation}
          onQuotaExceeded={onBoardQaQuotaExceeded}
        />
      )}

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
