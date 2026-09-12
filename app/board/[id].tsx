import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Toolbar from "../../src/components/Toolbar";
import ShapeOptionsBar from "../../src/components/ShapeOptionsBar";
import OfflineBanner from "../../src/components/OfflineBanner";
import PenOptionsBar from "../../src/components/PenOptionsBar";
import BoardHeader from "../../src/components/board/BoardHeader";
import BoardCanvas from "../../src/components/board/BoardCanvas";
import BoardModals from "../../src/components/board/BoardModals";
import { useAuth } from "../../src/hooks/useAuth";
import { useViewport } from "../../src/hooks/useViewport";
import type { SelectionAnchor } from "../../src/hooks/useSelection";
import { useBoardDocument } from "../../src/hooks/useBoardDocument";
import { useBoardElements } from "../../src/hooks/useBoardElements";
import { useBoardTools } from "../../src/hooks/useBoardTools";
import { useBoardCollab } from "../../src/hooks/useBoardCollab";
import { useBoardAI } from "../../src/hooks/useBoardAI";
import { useBoardComments } from "../../src/hooks/useBoardComments";
import { useBoardReactions } from "../../src/hooks/useBoardReactions";
import { useBoardPolls } from "../../src/hooks/useBoardPolls";
import type { NewPollInput } from "../../src/components/board/PollComposer";
import type { CommandName } from "../../src/lib/shortcuts";
import { Point, Bounds, screenToBoard, boardToScreen } from "../../src/lib/viewport";
import * as friendService from "../../src/services/friendService";
import * as workspaceService from "../../src/services/workspaceService";
import { isBoardQaConfigured } from "../../src/services/boardQaService";
import type { UpsellResource } from "../../src/components/upsellCopy";
import { captureException } from "../../src/lib/errorReporting";
import { captureBoardImage, captureSelectionImage } from "../../src/utils/canvasCapture";
import type { EmbedScope } from "../../src/types";

// Feature flag for the Phase 2 pan/zoom transform. Off => identity viewport and
// drawing only (pre-Phase-2 behavior) as a quick rollback if parity regresses.
const ENABLE_PAN_ZOOM = true;

// Screen-space padding around a captured selection region (OCR / explain).
const SELECTION_CAPTURE_PAD = 12;

/**
 * Phase 8 — `embedMode` renders the board chrome-stripped for an embeddable
 * iframe (the embed route at app/embed/b/[id].tsx passes it, along with `id` via
 * the same route param). The header, share/session controls and join prompt stay
 * hidden in embed mode regardless of scope — those are host-account actions with
 * no place inside a third-party iframe.
 *
 * Month 5 — `embedScope` (also from the embed route, itself resolved from the
 * server-verified token exchange; see that file's header) decides the rest.
 * `"view"` (the default) keeps the original Phase 8 behavior: no board-member
 * role can produce a `canEdit` of true for an embed identity (its uid is never in
 * `board.members` — see `effectiveBoardRole`), so the toolbar and drawing tools
 * stay hidden. `"edit"` additionally shows the toolbar and enables the canvas
 * writes `firestore.rules`' `isEmbedEditor` allows (paths/notes/shapes/text
 * elements) via the local `embedCanEdit` below — a UI decision layered on top of
 * `doc.canEdit`, not a change to what that field means for a real member.
 * The image-insert and manual-Save BUTTONS stay hidden in an embed at any
 * scope (`canInsertImage` / `canManualSave` on `Toolbar`): `images`/`audio`
 * are excluded from `isEmbedEditor` because their bytes are member-gated in
 * `storage.rules`, and the board DOCUMENT (what Save writes) is excluded too —
 * so either button would only ever produce a write Firestore refuses to
 * record. Canvas content still persists per-element the moment it's drawn;
 * neither button gates that. NOT closed by this: `useBoardElements`'s
 * Cmd/Ctrl+V image paste (the DOM `paste` listener, and `shortcutPaste` on
 * native) has no role gate at all today, for anyone — a real read-only viewer
 * can already trigger it, embed or not. This is a pre-existing gap this task
 * did not introduce and does not fix; it just means hiding the button is a
 * partial mitigation for an embed-edit session, not a guarantee `images`
 * writes never get attempted.
 *
 * Live cursors for an edit-scope embed: `useBoardCollab`'s `embedEditable`
 * option (derived below as `embedEditScope`) lets that session publish its own
 * cursor, which `CursorLayer` (never `embedMode`-gated) already renders for
 * every other participant — so a second editor's pointer IS visible while they
 * draw. What stays suppressed for an embed at ANY scope, deliberately: the
 * `presence/{userId}` avatar-bar join (nothing renders it — `BoardHeader` is
 * always hidden here) and presenter/follow mode (no controls to host it,
 * unrelated to what "attribution" means for this task). See Month 5's Google
 * Meet add-on shell notes (web/meet-addon/README.md) for what that leaves
 * unverified without a live host.
 *
 * Month 5/6 Task 1 decomposed this screen. Each concern now lives in its own hook
 * under `src/hooks/` — `useBoardDocument` (the board record, roles, saving,
 * sessions), `useBoardElements` (content + selection + writes), `useBoardTools`,
 * `useBoardCollab`, `useBoardComments`, `useBoardAI` — and the canvas stage,
 * header and overlay layers under `src/components/board/`. No hook takes another
 * hook's return value: this screen is the single composition point, passing plain
 * data and its own callbacks down.
 */
export default function BoardScreen(
  { embedMode = false, embedScope = "view" }: { embedMode?: boolean; embedScope?: EmbedScope } = {}
) {
  const { id, session } = useLocalSearchParams<{ id: string; session?: string }>();
  const router = useRouter();
  const { user, userProfile } = useAuth();

  // `?session={id}` half of the deep-link contract (boardapp://board/{id}?session={id}):
  // open the board, then hand off to that session once. Guarded so it fires a
  // single time per arrival, not on every re-render.
  const handledSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (session && handledSessionRef.current !== session) {
      handledSessionRef.current = session;
      router.push(`/session/${session}`);
    }
  }, [session, router]);

  // Blocked users. Screen state rather than hook state: the element model filters
  // by it, and the presence bar / cursor layer read it too.
  const [blockedIds, setBlockedIds] = useState<string[]>([]);

  // Month 5 (ROADMAP items 12 + 14) — the workspace's custom swatch palette,
  // mirrored from `doc.boardWorkspace` and optimistically appended to by
  // `handleAddSwatch` below (see that effect's own comment for why).
  const [workspaceSwatches, setWorkspaceSwatches] = useState<string[]>([]);

  // Inline text-edit lifecycle. Screen state because the element model, the
  // shortcut suppression and the culling window all key off it.
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  // Canvas layout size, for culling and for centring new content
  const [canvasSize, setCanvasSize] = useState({ width: 300, height: 500 });

  // Dismissible error banner
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Month 6 — dismissible SUCCESS banner. Distinct from errorMessage (which is
  // styled red with an alert icon) so a genuine confirmation — today, only
  // "Make flashcards" landing new cards in the caller's own deck — never
  // reads as an error to the user.
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Modals: deep-link join, share, session, history, background picker
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [deepLinkCode, setDeepLinkCode] = useState<string | undefined>();
  const [sessionModalVisible, setSessionModalVisible] = useState(false);
  const [shareBoardModalVisible, setShareBoardModalVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [bgPickerVisible, setBgPickerVisible] = useState(false);
  // Month 5 (ROADMAP item 12) — the custom colour picker and stroke-width
  // picker, opened from Toolbar/PenOptionsBar's "Colour"/"Width" pills.
  const [colorPickerVisible, setColorPickerVisible] = useState(false);
  const [widthPickerVisible, setWidthPickerVisible] = useState(false);
  // Month 6 — polls, quiz sequencing, dot voting. Opened from Toolbar's
  // "Insert poll" button, same convention as the pickers above.
  const [pollComposerVisible, setPollComposerVisible] = useState(false);
  // Month 6 — board Q&A chat, opened from the header's "ask this board"
  // button. Same screen-owned visibility convention as every dialog above.
  const [boardQaVisible, setBoardQaVisible] = useState(false);
  // The plan-limit upsell shown instead of a generic error when session
  // create or an AI affordance is denied for being over its cap.
  const [upsellResource, setUpsellResource] = useState<UpsellResource | null>(null);

  // Ref to the underlying SVG element on web, for canvas snapshot capture
  const canvasSvgRef = useRef<any>(null);

  // Web Shift/Alt tracking. Screen-owned because two subsystems read it: the
  // shape tool (constrain) and the transform gesture (non-uniform corner resize).
  const shiftHeldRef = useRef(false);
  const altHeldRef = useRef(false);
  const onModifiers = useCallback((m: { shift: boolean; alt: boolean }) => {
    shiftHeldRef.current = m.shift;
    altHeldRef.current = m.alt;
  }, []);
  const isShiftHeld = useCallback(() => shiftHeldRef.current, []);
  const isAltHeld = useCallback(() => altHeldRef.current, []);

  // Viewport (pan/zoom). Identity viewport keeps board-space === screen-space,
  // so pre-existing strokes render unchanged at default zoom.
  const viewportCtl = useViewport();
  const { viewport } = viewportCtl;

  // Viewer identity, resolved once for presence, cursors and comment authorship.
  const displayName = userProfile?.displayName ?? user?.email ?? "User";
  const userEmail = userProfile?.email ?? user?.email ?? "";

  const showError = useCallback((message: string) => setErrorMessage(message), []);

  // The resolved shortcut commands, kept on a ref (reassigned every render,
  // below) so the stable keyboard listeners always see the latest handlers
  // without re-binding — the same indirection the screen used before the split.
  const shortcutCommandsRef = useRef<Partial<Record<CommandName, () => void>>>({});
  const onShortcutCommand = useCallback((name: CommandName) => {
    shortcutCommandsRef.current[name]?.();
  }, []);

  // Safe navigation: fall back to Boards tab when there is no history to pop
  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/(tabs)");
    }
  };

  // --- Composed board state ---

  const doc = useBoardDocument(id!, {
    user,
    displayName,
    embedMode,
    captureBoard: () => captureBoardImage(canvasSvgRef.current),
    onNotFound: goBack,
    onJoinPrompt: (inviteCode) => {
      setDeepLinkCode(inviteCode);
      setJoinModalVisible(true);
    },
    onError: showError,
  });

  const tools = useBoardTools({
    userId: user?.uid,
    enabled: !!doc.board,
    editingTextId,
    onModifiers,
    onCommand: onShortcutCommand,
  });

  const elements = useBoardElements(id!, viewport, {
    userId: user?.uid,
    canvasSize,
    blockedIds,
    editingTextId,
    isAdmin: doc.isAdmin,
    isAltHeld,
    onEditText: setEditingTextId,
    onActivateSelectTool: tools.activateSelect,
    onScheduleSave: doc.scheduleSave,
    onError: showError,
  });

  // Month 5 — resolved before `useBoardCollab` (which needs it as an input,
  // not an output) and reused below for `embedCanEdit`. True only for an
  // edit-scope embed session: `embedMode` plus a token exchange that actually
  // resolved to `scope: "edit"` (see app/embed/b/[id].tsx).
  const embedEditScope = embedMode && embedScope === "edit";

  const collab = useBoardCollab(id!, user, {
    displayName,
    email: userEmail,
    activeTool: tools.activeTool,
    viewport,
    embedMode,
    embedEditable: embedEditScope,
    // Month 5 resolved the churn question this closure used to raise: the hook
    // now reads `onLeaderViewport` through a ref rather than listing it as an
    // effect dependency, so its identity no longer matters — this inline arrow
    // can stay exactly as it is, fresh every render, memoized or not. Full
    // rationale on the cursor-subscription effect in
    // `src/hooks/useBoardCollab.ts`.
    onLeaderViewport: (v) => viewportCtl.animateTo(v),
  });

  // Month 5 — the toolbar/pen-options `canEdit` used everywhere below. For a
  // real member this is exactly `doc.canEdit` (unchanged from Phase 6),
  // gated by the presenter lock same as before. For an embed session it
  // ignores `doc.canEdit` entirely (that field reflects `board.members`,
  // which an embed identity is never in — see this file's header comment)
  // and instead reflects `embedEditScope` above. `collab.presenterLocksContentCreation`
  // is always false in embed mode (presenter mode is part of what
  // `useBoardCollab` still suppresses there regardless of scope), so folding
  // it into one expression changes nothing for the embed path and keeps a
  // single formula instead of two near-duplicates at each call site.
  const embedCanEdit = embedMode
    ? embedEditScope && !collab.presenterLocksContentCreation
    : doc.canEdit && !collab.presenterLocksContentCreation;

  // Month 5 — while someone *else* is presenting and hasn't paused, the
  // audience's own content-creation tools/actions are disabled:
  // `collab.presenterLocksContentCreation` is always false on the
  // presenter's own client (`activePresenter` excludes self — see
  // `useBoardCollab`'s cursor-subscription effect), so this never locks out
  // the presenter themselves. This is a client-side affordance only — no
  // Firestore rule backs it (presenter state isn't part of the write-role
  // model), so it stops the toolbar, gesture handlers, AI affordances and
  // keyboard shortcuts from offering content creation, not a still-connected
  // client from writing directly. Single source of truth, read here (not
  // re-derived) so this screen, `BoardCanvas` and `BoardHeader` can never
  // compute two different answers to the same question.
  //
  // If a presentation starts (or resumes) while this viewer's own tool is
  // still a drawing tool from before, snap back to Select rather than leaving
  // a hidden-but-still-active pen tool armed.
  useEffect(() => {
    if (!collab.presenterLocksContentCreation) return;
    if (tools.activeTool === "pen" || tools.activeTool === "eraser" || tools.activeTool === "shape" || tools.activeTool === "text") {
      tools.setActiveTool("select");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab.presenterLocksContentCreation]);

  const comments = useBoardComments(id!, {
    user,
    authorName: displayName,
    workspaceId: doc.board?.workspaceId ?? "",
    boardTitle: doc.board?.title ?? "a board",
    onError: showError,
  });

  // Month 6 — reactions.
  const reactions = useBoardReactions(id!, {
    user,
    onError: showError,
  });

  // Month 6 — polls, quiz sequencing, dot voting.
  const polls = useBoardPolls(id!, {
    user,
    onError: showError,
  });

  // New polls are centered in the CURRENT viewport (board-space), same
  // "insert near what the viewer is looking at" default as pasting from the
  // clipboard — a poll has no natural anchor point of its own the way a
  // text-tool tap or a shape drag does, so there is no gesture to place it
  // from in the first place.
  const handleCreatePoll = (input: NewPollInput) => {
    const center = screenToBoard(viewport, {
      x: canvasSize.width / 2,
      y: canvasSize.height / 2,
    });
    polls.create({ ...input, x: center.x, y: center.y });
    setPollComposerVisible(false);
  };

  // Adopt newly created elements: switch to select, select them, schedule a save.
  const adoptElements = (
    ids: string[],
    o?: { anchor?: SelectionAnchor; edit?: boolean }
  ) => {
    tools.activateSelect();
    elements.selection.setMany(ids, o?.anchor ?? "elements");
    if (o?.edit) setEditingTextId(ids[0]);
    doc.scheduleSave();
  };

  // Rasterize a board-space region: web rasterizes the DOM <svg>, native uses
  // react-native-svg's toDataURL. Both go through captureSelectionImage.
  const captureRegion = (u: Bounds) => {
    const tl = boardToScreen(viewport, { x: u.minX, y: u.minY });
    const br = boardToScreen(viewport, { x: u.maxX, y: u.maxY });
    const pad = SELECTION_CAPTURE_PAD;
    return captureSelectionImage(
      canvasSvgRef.current,
      {
        x: tl.x - pad,
        y: tl.y - pad,
        width: br.x - tl.x + pad * 2,
        height: br.y - tl.y + pad * 2,
      },
      canvasSize
    );
  };

  const ai = useBoardAI(id!, {
    selectionUnion: elements.selectionUnion,
    captureRegion,
    selectedPathIds: elements.selectedPathIds,
    selectionText: elements.selectionText,
    viewportCenter: () =>
      screenToBoard(viewport, { x: canvasSize.width / 2, y: canvasSize.height / 2 }),
    createTextElement: (spec) =>
      elements.saveTextElement({
        boardId: id!,
        userId: user?.uid ?? "",
        color: tools.activeColor,
        ...spec,
      }),
    createDiagram: (build, ox, oy) =>
      elements.createDiagram(build, ox, oy, {
        color: tools.activeColor,
        strokeWidth: tools.activeStrokeWidth,
      }),
    adopt: adoptElements,
    onError: showError,
    // The three AI affordances share one "aiCall" resource — the generic
    // AI-call quota (src/services/quotaService.ts#QuotaResource) all of
    // OCR/explain/diagram gate through the same choke point on.
    onQuotaExceeded: () => setUpsellResource("aiCall"),
    // Month 6 — flashcards are saved to the CALLER's own deck
    // (`users/{uid}/decks/...`), never board-scoped, so the affordance needs
    // the uid even though nothing else this bridge does.
    uid: user?.uid ?? "",
    boardTitle: doc.board?.title ?? "Board",
    onFlashcardsGenerated: (deckName, count) =>
      setSuccessMessage(
        `Added ${count} flashcard${count === 1 ? "" : "s"} to your "${deckName}" deck.`
      ),
  });

  // Resolve every comment to a pin at its anchored element. Memoized over the
  // comment set + the element boxes so panning never recomputes pins.
  const commentPins = useMemo(
    () => comments.pinsFrom(elements.boxOfElement),
    [comments.pinsFrom, elements.boxOfElement]
  );

  // --- Camera commands ---

  const canvasCenter = (): Point => ({
    x: canvasSize.width / 2,
    y: canvasSize.height / 2,
  });
  // Manual camera commands take back control from follow mode (Phase 7).
  const handleZoomIn = () => { collab.exitFollow(); viewportCtl.zoomAtPoint(1.25, canvasCenter()); };
  const handleZoomOut = () => { collab.exitFollow(); viewportCtl.zoomAtPoint(0.8, canvasCenter()); };
  const handleFitToContent = () => { collab.exitFollow(); viewportCtl.fit(elements.contentBounds(), canvasSize); };
  const handleResetViewport = () => { collab.exitFollow(); viewportCtl.reset(); };
  // Any of the follower's own camera commands take back control and exit follow.
  const handleGestureStart = useCallback(() => {
    collab.exitFollow();
    viewportCtl.stopFling();
  }, [collab.exitFollow, viewportCtl]);

  // --- Screen-level effects ---

  // Load blocked IDs on mount
  useEffect(() => {
    if (!user) return;
    friendService
      .getBlockedIds(user.uid)
      .then(setBlockedIds)
      .catch((e) => captureException(e, { op: "board.getBlockedIds" }));
  }, [user]);

  // Drop a stroke selection when leaving the select tool.
  useEffect(() => {
    if (tools.activeTool !== "select") elements.selection.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools.activeTool, elements.selection.clear]);

  // Month 5 (ROADMAP item 12) — mirror the workspace's swatch palette into
  // local state whenever the workspace (re)loads, same optimistic-update
  // shape as `handleBlockUser` below: `doc.boardWorkspace` is a one-time
  // fetch (useBoardDocument.ts), not a live subscription, so a swatch this
  // viewer just added has to be reflected here directly rather than waiting
  // on a refetch that will never come on its own.
  useEffect(() => {
    setWorkspaceSwatches(doc.boardWorkspace?.swatches ?? []);
  }, [doc.boardWorkspace]);

  // --- Actions that span hooks ---

  const handleBlockUser = (userId: string) => {
    setBlockedIds((prev) => [...prev, userId]);
  };

  // Month 5 (ROADMAP items 12 + 14) — optimistic add, then a fire-and-forget
  // persist (mirrors `handleBlockUser`'s own local-first shape). Both gates
  // (plan via `canUseCustomPalette`, workspace role via `canManageWorkspace`
  // below — firestore.rules' `workspaces/{id}` update rule restricts
  // `swatches` to owner/admin regardless of plan) live in `ColorPickerModal`;
  // by the time this runs the caller has already decided the write is
  // allowed, so a real permission-denied here (a role changed mid-session,
  // say) still only reaches `captureException`, not the user — the local
  // optimistic add would then silently revert on the next
  // `doc.boardWorkspace` refresh, which is an acceptable failure mode for a
  // rare race, not a user-facing error path worth building here.
  // Month 6 — board Q&A citations. A cited element id only means something if
  // the reader can go and look at it, so the panel asks the screen (which owns
  // the live element sets) whether each one is still there. `boxOfElement`
  // returns null for an element that no longer exists — and also for one whose
  // author this viewer has blocked, which reads as "deleted" here. That is the
  // right answer for this purpose: blocked content is content you have chosen
  // not to be shown, and pointing a citation at it would undo that choice.
  const isCitationLive = useCallback(
    (elementId: string, canvasKind: string) =>
      elements.boxOfElement(elementId, canvasKind) !== null,
    [elements]
  );

  // Tapping a live citation selects it on the canvas, so it picks up the
  // selection overlay and the reader can see which element the answer came
  // from. The panel stays open — checking a citation should not cost you the
  // conversation.
  const handleSelectCitation = useCallback(
    (elementId: string, canvasKind: string) => {
      if (elements.boxOfElement(elementId, canvasKind) === null) return;
      tools.activateSelect();
      elements.selection.select(elementId);
    },
    [elements, tools]
  );

  const handleAddSwatch = (hex: string) => {
    setWorkspaceSwatches((prev) => (prev.includes(hex) ? prev : [...prev, hex]));
    const workspaceId = doc.board?.workspaceId;
    if (!workspaceId) return;
    workspaceService
      .addWorkspaceSwatch(workspaceId, hex)
      .catch((e) => captureException(e, { op: "board.addWorkspaceSwatch" }));
  };

  const handleDeleteSelected = async () => {
    const ids = [...elements.selection.selectedIds];
    if (ids.length === 0) return;
    elements.selection.clear();
    setEditingTextId(null);
    await elements.deleteSelected(ids);
  };

  const deselectAll = () => {
    elements.selection.clear();
    setEditingTextId(null);
  };

  const handleClear = async () => {
    try {
      await Promise.all([
        elements.clearBoardElements(),
        comments.clearBoardComments(),
        reactions.clearBoardReactions(),
        polls.clearBoardPolls(),
      ]);
      elements.resetLocalElements();
      comments.resetLocal();
      reactions.resetLocal();
      polls.resetLocal();
      setEditingTextId(null);
      elements.selection.clear();
      doc.scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to clear board");
    }
  };

  const handleDeepLinkJoined = () => {
    setJoinModalVisible(false);
    setDeepLinkCode(undefined);
    // Reload so the members array and content reflect the new membership
    doc.reload();
  };

  const handleDeepLinkCancel = () => {
    setJoinModalVisible(false);
    setDeepLinkCode(undefined);
    goBack();
  };

  // The shortcut command table. Reassigned every render (the ref indirection
  // above keeps the keyboard listeners stable) so each command always runs
  // against the current state.
  shortcutCommandsRef.current = {
    undo: elements.undo,
    redo: elements.redo,
    selectAll: elements.selectAllVisible,
    copy: elements.copySelected,
    // Month 5 — the same content-creation lock as the equivalent buttons
    // (BoardCanvas's duplicate action, BoardOverlayLayer): both shortcuts
    // write new elements, so both are gated while a presentation locks
    // content creation. `onShortcutCommand` calls this table with `?.()`, so
    // an undefined entry is already a silent no-op — no separate disabled
    // state to wire for a keystroke.
    paste: collab.presenterLocksContentCreation ? undefined : elements.shortcutPaste,
    duplicate: collab.presenterLocksContentCreation ? undefined : elements.duplicateSelected,
    delete: handleDeleteSelected,
    deselect: deselectAll,
    bringToFront: elements.bringToFront,
    sendToBack: elements.sendToBack,
    zoomIn: handleZoomIn,
    zoomOut: handleZoomOut,
    zoom100: viewportCtl.reset,
    zoomFit: handleFitToContent,
    help: tools.toggleCheatSheet,
  };

  if (doc.loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  const currentUserInfo = {
    uid: user?.uid ?? "",
    displayName,
    email: userEmail,
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Header — hidden in embed mode so the board fills the parent frame. */}
      {!embedMode && (
        <BoardHeader
          boardId={id!}
          boardTitle={doc.board?.title ?? "Board"}
          onBack={goBack}
          memberUids={doc.board?.members ?? []}
          currentUserId={user?.uid}
          presence={collab.presence}
          currentUser={currentUserInfo}
          blockedIds={blockedIds}
          onBlock={handleBlockUser}
          ownerId={doc.board?.ownerId}
          adminId={doc.board?.adminId}
          onAdminChanged={doc.setAdmin}
          followingId={collab.followingId}
          onFollow={collab.toggleFollowUser}
          onOpenBackgroundPicker={() => setBgPickerVisible(true)}
          onOpenHistory={() => setHistoryVisible(true)}
          diagramEnabled={ai.diagramEnabled}
          onOpenDiagram={collab.presenterLocksContentCreation ? undefined : ai.openDiagram}
          boardQaEnabled={isBoardQaConfigured()}
          onOpenBoardQa={() => setBoardQaVisible(true)}
          onShare={() => setShareBoardModalVisible(true)}
          isAdmin={doc.isAdmin}
          hasActiveSession={!!doc.activeSession}
          endingSession={doc.endingSession}
          onEndSession={doc.endSession}
          onStartSession={() => setSessionModalVisible(true)}
          isPresenting={collab.isPresenting}
          isPresenterPaused={collab.isPresenterPaused}
          onStartPresenting={collab.startPresenting}
          onStopPresenting={collab.stopPresenting}
          onPausePresenting={collab.pausePresenting}
          onResumePresenting={collab.resumePresenting}
        />
      )}

      {/* Save toast */}
      <Animated.View style={[styles.saveToast, { opacity: doc.saveOpacity }]} pointerEvents="none">
        <Ionicons name="checkmark-circle" size={14} color="#16a34a" />
        <Text style={styles.saveToastText}>Saved</Text>
      </Animated.View>

      {/* Offline / syncing banner (Phase 6) */}
      <OfflineBanner />

      {/* Error banner */}
      {errorMessage && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={15} color="#b91c1c" />
          <Text style={styles.errorBannerText}>{errorMessage}</Text>
          <TouchableOpacity onPress={() => setErrorMessage(null)}>
            <Ionicons name="close" size={15} color="#b91c1c" />
          </TouchableOpacity>
        </View>
      )}

      {/* Success banner (Month 6 — e.g. "Make flashcards" landing new cards
          in the caller's own deck). Deliberately a separate, green-styled
          banner from errorBanner above — never piggyback a confirmation on
          the error banner's red styling. */}
      {successMessage && (
        <View style={styles.successBanner}>
          <Ionicons name="checkmark-circle-outline" size={15} color="#166534" />
          <Text style={styles.successBannerText}>{successMessage}</Text>
          <TouchableOpacity onPress={() => setSuccessMessage(null)}>
            <Ionicons name="close" size={15} color="#166534" />
          </TouchableOpacity>
        </View>
      )}

      {/* Canvas + overlays + canvas-anchored affordances */}
      <BoardCanvas
        boardId={id!}
        currentUserId={user?.uid}
        isAdmin={doc.isAdmin}
        backgroundTemplate={doc.board?.backgroundTemplate ?? "blank"}
        blockedIds={blockedIds}
        plan={doc.boardWorkspace?.plan ?? "free"}
        canEdit={doc.canEdit}
        canComment={doc.canComment}
        enablePanZoom={ENABLE_PAN_ZOOM}
        viewport={viewport}
        canvasSize={canvasSize}
        onLayoutSize={setCanvasSize}
        canvasRef={canvasSvgRef}
        elements={elements}
        tools={tools}
        collab={collab}
        ai={ai}
        comments={comments}
        commentPins={commentPins}
        reactions={reactions}
        polls={polls}
        editingTextId={editingTextId}
        onEditText={setEditingTextId}
        isShiftHeld={isShiftHeld}
        onDeleteSelected={handleDeleteSelected}
        onPanBy={viewportCtl.panBy}
        onZoomAtPoint={viewportCtl.zoomAtPoint}
        onFling={viewportCtl.fling}
        onGestureStart={handleGestureStart}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onResetViewport={handleResetViewport}
        onFitToContent={handleFitToContent}
        onError={showError}
      />

      {/* Contextual shape options (Phase 7) — only while the shape tool is active */}
      {tools.activeTool === "shape" && (
        <ShapeOptionsBar
          activeKind={tools.activeShapeKind}
          onSelectKind={tools.setActiveShapeKind}
          fillEnabled={tools.shapeFillEnabled}
          onToggleFill={tools.toggleShapeFill}
          dashed={tools.shapeDashed}
          onToggleDashed={tools.toggleShapeDashed}
          snapGrid={tools.snapGrid}
          onCycleSnap={tools.cycleSnap}
          arrowheadEnd={tools.shapeArrowheadEnd}
          onCycleArrowhead={tools.cycleArrowhead}
          eyedropperArmed={tools.eyedropperArmed}
          onToggleEyedropper={tools.toggleEyedropper}
        />
      )}

      {/* Contextual pen options (Phase 9; Month 5 — ROADMAP item 12 added
          the variant/colour/width/eyedropper pills) — only while the pen
          tool is active and the viewer can edit (`embedCanEdit` folds in the
          embed-scope case; see this file's header comment). */}
      {tools.activeTool === "pen" && embedCanEdit && (
        <PenOptionsBar
          mode={tools.shapeRecMode}
          onCycleMode={tools.cycleShapeRecMode}
          activePenStyle={tools.activePenStyle}
          onSelectPenStyle={tools.setActivePenStyle}
          activeColor={tools.activeColor}
          onOpenColorPicker={() => setColorPickerVisible(true)}
          activeStrokeWidth={tools.activeStrokeWidth}
          onOpenWidthPicker={() => setWidthPickerVisible(true)}
          eyedropperArmed={tools.eyedropperArmed}
          onToggleEyedropper={tools.toggleEyedropper}
        />
      )}

      {/* Toolbar — hidden for a view-scope embed; shown for a real member or an
          edit-scope embed (`embedCanEdit`; see this file's header comment). */}
      {(!embedMode || embedCanEdit) && (
        <Toolbar
          activeTool={tools.activeTool}
          activeColor={tools.activeColor}
          activeStrokeWidth={tools.activeStrokeWidth}
          isAdmin={doc.isAdmin}
          canEdit={embedCanEdit}
          canComment={doc.canComment}
          canInsertImage={!embedMode}
          canManualSave={!embedMode}
          onToolChange={tools.setActiveTool}
          onColorChange={(color) => {
            // Fix round 1, item 7: chooseColor (not the bare setActiveColor)
            // so the 8 quick dots feed the recent-colours row too — before
            // this, `chooseColor`'s own doc claimed to be "the one entry
            // point every colour choice should go through" while this, the
            // single most common way to pick a colour, bypassed it entirely.
            tools.chooseColor(color);
            elements.applyColor(color);
          }}
          onStrokeWidthChange={(w) => {
            tools.setActiveStrokeWidth(w);
            elements.applyStrokeWidth(w);
          }}
          onOpenColorPicker={() => setColorPickerVisible(true)}
          onOpenWidthPicker={() => setWidthPickerVisible(true)}
          onInsertImage={elements.insertImage}
          onInsertPoll={() => setPollComposerVisible(true)}
          canInsertPoll={!embedMode}
          onUndo={elements.undo}
          onRedo={elements.redo}
          canRedo={elements.canRedo}
          onClear={handleClear}
          onSave={doc.saveNow}
        />
      )}

      <BoardModals
        boardId={id!}
        currentUserId={user?.uid ?? ""}
        adminName={displayName}
        doc={doc}
        comments={comments}
        ai={ai}
        boxOfElement={elements.boxOfElement}
        presence={collab.presence}
        cheatSheetVisible={tools.cheatSheetVisible}
        onCloseCheatSheet={tools.hideCheatSheet}
        joinVisible={joinModalVisible}
        joinInviteCode={deepLinkCode}
        onJoined={handleDeepLinkJoined}
        onJoinCancel={handleDeepLinkCancel}
        shareVisible={shareBoardModalVisible}
        onCloseShare={() => setShareBoardModalVisible(false)}
        canvasRef={canvasSvgRef}
        boardElements={{
          paths: elements.paths,
          shapes: elements.shapes,
          texts: elements.texts,
          notes: elements.notes,
          images: elements.images,
          audioNotes: elements.audioNotes,
        }}
        getContentBounds={elements.contentBounds}
        historyVisible={historyVisible}
        onCloseHistory={() => setHistoryVisible(false)}
        bgPickerVisible={bgPickerVisible}
        onCloseBgPicker={() => setBgPickerVisible(false)}
        sessionVisible={sessionModalVisible}
        onCloseSession={() => setSessionModalVisible(false)}
        upsellResource={upsellResource}
        onDismissUpsell={() => setUpsellResource(null)}
        onSessionQuotaExceeded={() => {
          setSessionModalVisible(false);
          setUpsellResource("session");
        }}
        colorPickerVisible={colorPickerVisible}
        onCloseColorPicker={() => setColorPickerVisible(false)}
        activeColor={tools.activeColor}
        activeAlpha={tools.activeAlpha}
        onChangeColor={(hex, alpha) => {
          tools.chooseColor(hex);
          tools.setActiveAlpha(alpha);
          elements.applyColor(hex);
          // Fix round 1, item 2: alpha used to change only the active
          // default for NEW strokes — dragging it with elements already
          // selected was a no-op on their actual content. applyOpacity
          // mirrors applyColor/applyStrokeWidth's own "recolor the
          // selection" behavior, scoped to pen paths only (see that
          // function's own comment).
          elements.applyOpacity(alpha);
        }}
        recentColors={tools.recentColors}
        plan={doc.boardWorkspace?.plan ?? "free"}
        canManageWorkspace={workspaceService.canManageMembers(
          doc.boardWorkspace ? workspaceService.getWorkspaceRole(doc.boardWorkspace, user?.uid ?? "") : undefined
        )}
        workspaceSwatches={workspaceSwatches}
        onAddSwatch={handleAddSwatch}
        onRequestPaletteUpgrade={() => setUpsellResource("customPalette")}
        widthPickerVisible={widthPickerVisible}
        onCloseWidthPicker={() => setWidthPickerVisible(false)}
        activeStrokeWidth={tools.activeStrokeWidth}
        onChangeStrokeWidth={(w) => {
          tools.setActiveStrokeWidth(w);
          elements.applyStrokeWidth(w);
        }}
        presenterLocksContentCreation={collab.presenterLocksContentCreation}
        pollComposerVisible={pollComposerVisible}
        onClosePollComposer={() => setPollComposerVisible(false)}
        onCreatePoll={handleCreatePoll}
        boardQaEnabled={isBoardQaConfigured()}
        boardQaVisible={boardQaVisible}
        onCloseBoardQa={() => setBoardQaVisible(false)}
        isCitationLive={isCitationLive}
        onSelectCitation={handleSelectCitation}
        onBoardQaQuotaExceeded={() => {
          setBoardQaVisible(false);
          setUpsellResource("boardQa");
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fef2f2",
    borderBottomWidth: 1,
    borderBottomColor: "#fecaca",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorBannerText: {
    flex: 1,
    fontSize: 13,
    color: "#b91c1c",
  },
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f0fdf4",
    borderBottomWidth: 1,
    borderBottomColor: "#bbf7d0",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  successBannerText: {
    flex: 1,
    fontSize: 13,
    color: "#166534",
  },
  saveToast: {
    position: "absolute",
    top: 110,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#f0fdf4",
    borderWidth: 1,
    borderColor: "#bbf7d0",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    zIndex: 100,
  },
  saveToastText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#16a34a",
  },
});
