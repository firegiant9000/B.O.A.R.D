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
import type { CommandName } from "../../src/lib/shortcuts";
import { Point, Bounds, screenToBoard, boardToScreen } from "../../src/lib/viewport";
import * as friendService from "../../src/services/friendService";
import type { QuotaResource } from "../../src/services/quotaService";
import { captureException } from "../../src/lib/errorReporting";
import { captureBoardImage, captureSelectionImage } from "../../src/utils/canvasCapture";

// Feature flag for the Phase 2 pan/zoom transform. Off => identity viewport and
// drawing only (pre-Phase-2 behavior) as a quick rollback if parity regresses.
const ENABLE_PAN_ZOOM = true;

// Screen-space padding around a captured selection region (OCR / explain).
const SELECTION_CAPTURE_PAD = 12;

/**
 * Phase 8 — `embedMode` renders the board chrome-stripped and read-only for an
 * embeddable iframe (the embed route at app/embed/b/[id].tsx passes it). The board
 * reads the same `id` route param either way. Editing is already gated by role
 * (an embed identity is not a board member, so `canEdit` is false), but embed mode
 * additionally hides the header + toolbar and suppresses presence/cursor writes
 * and the join prompt, which an embed viewer has no rights to.
 *
 * Month 5/6 Task 1 decomposed this screen. Each concern now lives in its own hook
 * under `src/hooks/` — `useBoardDocument` (the board record, roles, saving,
 * sessions), `useBoardElements` (content + selection + writes), `useBoardTools`,
 * `useBoardCollab`, `useBoardComments`, `useBoardAI` — and the canvas stage,
 * header and overlay layers under `src/components/board/`. No hook takes another
 * hook's return value: this screen is the single composition point, passing plain
 * data and its own callbacks down.
 */
export default function BoardScreen({ embedMode = false }: { embedMode?: boolean } = {}) {
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

  // Inline text-edit lifecycle. Screen state because the element model, the
  // shortcut suppression and the culling window all key off it.
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  // Canvas layout size, for culling and for centring new content
  const [canvasSize, setCanvasSize] = useState({ width: 300, height: 500 });

  // Dismissible error banner
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Modals: deep-link join, share, session, history, background picker
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [deepLinkCode, setDeepLinkCode] = useState<string | undefined>();
  const [sessionModalVisible, setSessionModalVisible] = useState(false);
  const [shareBoardModalVisible, setShareBoardModalVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [bgPickerVisible, setBgPickerVisible] = useState(false);
  // The plan-limit upsell shown instead of a generic error when session
  // create or an AI affordance is denied for being over its cap.
  const [upsellResource, setUpsellResource] = useState<QuotaResource | null>(null);

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

  const collab = useBoardCollab(id!, user, {
    displayName,
    email: userEmail,
    activeTool: tools.activeTool,
    viewport,
    embedMode,
    // ⚠ Deliberately a fresh closure every render — DO NOT hoist into a
    // `useCallback` or pass `viewportCtl.animateTo` directly. Before this
    // refactor the follow subscription's effect listed the whole `useViewport`
    // controller, which is a new object literal on every render, so the cursor
    // listener was torn down and re-created each render while following. Keeping
    // this identity unstable reproduces that exactly. The churn is a pre-existing
    // perf bug — flagged, not fixed here, because this task must not change
    // behaviour. Full rationale (and what stabilizing it would change about the
    // follow ease) is on the follow effect in `src/hooks/useBoardCollab.ts`.
    onLeaderViewport: (v) => viewportCtl.animateTo(v),
  });

  const comments = useBoardComments(id!, {
    user,
    authorName: displayName,
    workspaceId: doc.board?.workspaceId ?? "",
    boardTitle: doc.board?.title ?? "a board",
    onError: showError,
  });

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

  // --- Actions that span hooks ---

  const handleBlockUser = (userId: string) => {
    setBlockedIds((prev) => [...prev, userId]);
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
      await Promise.all([elements.clearBoardElements(), comments.clearBoardComments()]);
      elements.resetLocalElements();
      comments.resetLocal();
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
    paste: elements.shortcutPaste,
    duplicate: elements.duplicateSelected,
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
          onOpenDiagram={ai.openDiagram}
          onShare={() => setShareBoardModalVisible(true)}
          isAdmin={doc.isAdmin}
          hasActiveSession={!!doc.activeSession}
          endingSession={doc.endingSession}
          onEndSession={doc.endSession}
          onStartSession={() => setSessionModalVisible(true)}
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

      {/* Canvas + overlays + canvas-anchored affordances */}
      <BoardCanvas
        boardId={id!}
        currentUserId={user?.uid}
        isAdmin={doc.isAdmin}
        backgroundTemplate={doc.board?.backgroundTemplate ?? "blank"}
        blockedIds={blockedIds}
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
        />
      )}

      {/* Contextual pen options (Phase 9) — auto-perfect toggle, only while the
          pen tool is active and the viewer can edit. Hidden in embed mode. */}
      {tools.activeTool === "pen" && doc.canEdit && !embedMode && (
        <PenOptionsBar mode={tools.shapeRecMode} onCycleMode={tools.cycleShapeRecMode} />
      )}

      {/* Toolbar — hidden in embed mode (read-only viewer has no editing tools). */}
      {!embedMode && (
        <Toolbar
          activeTool={tools.activeTool}
          activeColor={tools.activeColor}
          activeStrokeWidth={tools.activeStrokeWidth}
          isAdmin={doc.isAdmin}
          canEdit={doc.canEdit}
          canComment={doc.canComment}
          onToolChange={tools.setActiveTool}
          onColorChange={(color) => {
            tools.setActiveColor(color);
            elements.applyColor(color);
          }}
          onStrokeWidthChange={(w) => {
            tools.setActiveStrokeWidth(w);
            elements.applyStrokeWidth(w);
          }}
          onInsertImage={elements.insertImage}
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
