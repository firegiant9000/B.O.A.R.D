import React, { useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DrawingCanvas from "../DrawingCanvas";
import ZoomControls from "../ZoomControls";
import CursorLayer from "../CursorLayer";
import BoardOverlayLayer from "./BoardOverlayLayer";
import AiSelectionActions from "./AiSelectionActions";
import PerfectShapePrompt from "./PerfectShapePrompt";
import PresentingBanner from "./PresentingBanner";
import type { CommentPin } from "../CommentPinLayer";
import { Point, Viewport } from "../../lib/viewport";
import { recognizeShape } from "../../lib/shapeRecognition";
import type { BoardElements } from "../../hooks/useBoardElements";
import type { BoardTools } from "../../hooks/useBoardTools";
import type { BoardCollab } from "../../hooks/useBoardCollab";
import type { BoardAI } from "../../hooks/useBoardAI";
import type { BoardComments } from "../../hooks/useBoardComments";
import { BackgroundTemplate, CommentAnchorKind, Plan } from "../../types";

/**
 * The board's canvas stage (Month 5/6 Task 1 — extracted verbatim from
 * `app/board/[id].tsx`).
 *
 * Two jobs, both squarely "the canvas":
 * 1. Render every canvas layer in order — the SVG canvas, the board-space
 *    overlay, live cursors, the follow banner, zoom controls and the AI /
 *    shape-recognition affordances.
 * 2. Translate raw gestures from `DrawingCanvas` into the active tool's action.
 *    That per-tool dispatch is the only place tools, elements, collaboration and
 *    comments meet, so it takes the composed hooks as props — the hooks
 *    themselves stay independent of one another.
 *
 * It owns only the live in-progress stroke; every other piece of state it
 * touches lives in the hook that owns that concern.
 */

// Phase 3 write-path perf: cap stroke sampling to ~30Hz (the RDP simplify half
// lives with the write path, in useBoardElements).
const STROKE_SAMPLE_MS = 1000 / 30;

interface BoardCanvasProps {
  boardId: string;
  /** Viewer uid; undefined before sign-in resolves (never coerced to ""). */
  currentUserId: string | undefined;
  isAdmin: boolean;
  backgroundTemplate: BackgroundTemplate;
  /** Uids whose cursors the viewer has blocked. */
  blockedIds: string[];
  /** The board's workspace plan — Month 5's voice notes are the first
   *  consumer (the advisory Pro gate in AudioAffordance, threaded through
   *  BoardOverlayLayer). Passed down rather than read here so this stays
   *  props-only, same as every other value on this interface. */
  plan: Plan;

  /** Phase 2 pan/zoom transform; false renders at identity (the rollback path). */
  enablePanZoom: boolean;
  viewport: Viewport;
  canvasSize: { width: number; height: number };
  onLayoutSize: (size: { width: number; height: number }) => void;
  /** The SVG handle the screen uses for snapshot / selection capture. */
  canvasRef: React.Ref<any>;

  elements: BoardElements;
  tools: BoardTools;
  collab: BoardCollab;
  ai: BoardAI;
  comments: BoardComments;
  /** Pins resolved by the screen (the comments × elements join). */
  commentPins: CommentPin[];

  editingTextId: string | null;
  onEditText: (id: string | null) => void;
  /** Shift held (web) — additive select / shape constrain. Read mid-gesture. */
  isShiftHeld: () => boolean;

  /** Delete the selection; screen-owned because the shortcut table shares it. */
  onDeleteSelected: () => void;

  // Camera
  onPanBy: (dx: number, dy: number) => void;
  onZoomAtPoint: (factor: number, screenPoint: Point) => void;
  onFling: (vx: number, vy: number) => void;
  onGestureStart: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetViewport: () => void;
  onFitToContent: () => void;

  onError: (message: string) => void;
}

export default function BoardCanvas({
  boardId,
  currentUserId,
  isAdmin,
  backgroundTemplate,
  blockedIds,
  plan,
  enablePanZoom,
  viewport,
  canvasSize,
  onLayoutSize,
  canvasRef,
  elements,
  tools,
  collab,
  ai,
  comments,
  commentPins,
  editingTextId,
  onEditText,
  isShiftHeld,
  onDeleteSelected,
  onPanBy,
  onZoomAtPoint,
  onFling,
  onGestureStart,
  onZoomIn,
  onZoomOut,
  onResetViewport,
  onFitToContent,
  onError,
}: BoardCanvasProps) {
  // The live in-progress stroke, plus the timestamp of its last sampled point
  // (drives 30Hz move coalescing).
  const [currentPoints, setCurrentPoints] = useState<Point[] | null>(null);
  const lastSampleRef = useRef(0);

  // Only pen and eraser produce live strokes; text/select route through taps.
  const isDrawingTool = tools.activeTool === "pen" || tools.activeTool === "eraser";

  // Month 5 — an active, unpaused presenter locks out everyone else's new
  // content creation. `activePresenter` (and so `presenterLocksContentCreation`,
  // computed once in `useBoardCollab`) is always false/null on the
  // presenter's own client, so this never blocks the presenter. UI-only
  // affordance: the screen already steers `activeTool` away from a drawing
  // tool and hides the toolbar's drawing buttons while this is true (see
  // `app/board/[id].tsx`) — these are a second guard on the gesture handlers
  // themselves, not a security boundary (no Firestore rule backs presenter
  // state).
  //
  // Scope — "no new content creation," not "read-only": this guards every
  // reachable path in this component that creates, draws, or replaces board
  // content, or spends AI quota, while a presentation is live —
  //   - the drawing tools (pen, eraser, shape, text): stroke start/move/end
  //     and the tap handler below, not only stroke start;
  //   - `onDuplicateSelected` (below): a selection-actions button that writes
  //     new elements even though the select tool itself stays usable;
  //   - `onAcceptOcr` (below): accepting a held-back low-confidence OCR
  //     result creates a new text element and spends AI quota;
  //   - `onRecognizeText` (below): the button that starts OCR in the first
  //     place — its *common*, high-confidence path writes the text element
  //     directly via `placeOcrText` (`useBoardAI.ts`) without ever reaching
  //     the confirm prompt `onAcceptOcr` guards, so gating only the prompt
  //     left the more common path open;
  //   - `onExplain` (below): always creates a text element and spends AI
  //     quota, unconditionally (no confirm step to gate instead);
  //   - `acceptPerfect`, wired as `PerfectShapePrompt`'s `onAccept` (below):
  //     accepting persists a shape in place of the freehand stroke —
  //     reachable even if the lock begins after the prompt is already on
  //     screen.
  //   - `newVoiceNoteAnchor` (below, Month 5): the record-entry-point that
  //     appears next to a single selection with no voice note yet — like
  //     `onDuplicateSelected`, reachable through the select tool, which stays
  //     usable while presenting. Rolled into the `singleSelectedId` gate
  //     itself (not passed through separately at the JSX call site) so a
  //     locked audience never even sees it computed as non-null.
  // For all six, the lock is applied by passing `undefined`/`null` instead of
  // the real handler or value rather than wiring a no-op: each of the
  // underlying components renders no button at all for an undefined handler
  // (matches `SelectionOverlay`'s existing `btn()` pattern), so the audience
  // isn't shown an affordance that silently does nothing. `onAcceptOcr` and
  // `acceptPerfect` each keep their dismiss/discard action available so the
  // prompt can still be closed.
  //
  // Three more content-creation paths share this same lock but live outside
  // this component, each gated at its own owning layer instead of duplicating
  // the predicate's derivation here:
  //   - `ai.generateDiagram`, gated twice — `BoardHeader`'s diagram-open
  //     button (`ai.openDiagram`, `app/board/[id].tsx`) so a locked viewer
  //     can't open the prompt in the first place, *and* `BoardModals`'
  //     `presenterLocksContentCreation` prop, which gates `DiagramPromptModal`'s
  //     `onGenerate` directly — closing the "lock begins after the surface is
  //     already open" gap `acceptPerfect` and `onAcceptOcr` also close for
  //     their own prompts, for a panel this component doesn't render;
  //   - the `duplicate`/`paste` keyboard shortcuts (`shortcutCommandsRef`,
  //     `app/board/[id].tsx`) — the same two writes as `onDuplicateSelected`
  //     above, reachable without touching this component's UI at all.
  //
  // It deliberately does NOT cover the select tool's drag-to-move
  // (`moveSelectGesture` → `commitMove`) or the resize/rotate handles
  // (`beginTransform`/`moveTransform`/`endTransform`): repositioning existing
  // content isn't *new* content, and those stay reachable while presenting
  // the same way they already are for an ordinary `canEdit: false` viewer
  // (Toolbar's read-only row keeps Select enabled too).
  const presenterLocksContentCreation = collab.presenterLocksContentCreation;

  const handleStrokeStart = () => {
    if (tools.activeTool === "select") { elements.beginSelectGesture(); return; }
    if (presenterLocksContentCreation) return;
    if (tools.activeTool === "shape") { tools.beginShapeDraft(); return; }
    if (!isDrawingTool) return;
    lastSampleRef.current = 0; // first move of a new stroke always records
    if (tools.activeTool === "eraser") elements.beginEraseStroke();
    setCurrentPoints([]);
  };

  const handleStrokeMove = (point: Point) => {
    if (tools.activeTool === "select") {
      elements.moveSelectGesture(point, isShiftHeld());
      return;
    }
    // Month 5 — DrawingCanvas fires move/end for a gesture regardless of what
    // onStrokeStart did (it has no way to signal "ignore the rest of this
    // gesture"), so the lock has to be re-checked here too: without this,
    // `handleStrokeStart`'s early return above was cosmetic — `moveShapeDraft`
    // has no guard against a missing `beginShapeDraft`, and the eraser branch
    // below calls `eraseAtPoint` (a real, immediate mutation) on every move.
    if (presenterLocksContentCreation) return;
    if (tools.activeTool === "shape") {
      tools.moveShapeDraft(point, isShiftHeld(), elements.shapeGuideTargets());
      return;
    }
    if (!isDrawingTool) return;
    // Coalesce gesture frames to ~30Hz: cap how many points enter the stroke so
    // the write payload and JS work scale with stroke length, not frame rate.
    // The live render stays smooth — 30Hz is well above the perceptible floor.
    const now = Date.now();
    if (now - lastSampleRef.current < STROKE_SAMPLE_MS) return;
    lastSampleRef.current = now;
    if (tools.activeTool === "eraser") elements.eraseAtPoint(point, tools.activeStrokeWidth);
    setCurrentPoints((prev) => (prev ? [...prev, point] : [point]));
  };

  const handleStrokeEnd = async () => {
    if (tools.activeTool === "select") {
      await elements.endSelectGesture();
      return;
    }
    // Month 5 — same reasoning as the guard in handleStrokeMove: this is the
    // call that actually persists a stroke/shape (`commitStroke` /
    // `saveShapeFromDraft`), so it must not rely on handleStrokeStart alone
    // having skipped initialization. Clear any points a pre-lock portion of
    // this same gesture already accumulated rather than committing them, and
    // close an eraser batch `beginEraseStroke()` may have opened before the
    // lock kicked in mid-gesture — otherwise `erasedIdsRef` (useBoardElements)
    // stays populated until the next eraser stroke's own `beginEraseStroke()`.
    if (presenterLocksContentCreation) {
      if (tools.activeTool === "eraser") elements.endEraseStroke();
      setCurrentPoints(null);
      return;
    }
    if (tools.activeTool === "shape") {
      const draft = tools.endShapeDraft();
      if (draft) await elements.saveShapeFromDraft(draft);
      return;
    }
    if (!isDrawingTool) return;
    // Real eraser: deletion happened incrementally in handleStrokeMove; the
    // stroke itself is never persisted (the old white-paint behavior is gone).
    if (tools.activeTool === "eraser") {
      elements.endEraseStroke();
      setCurrentPoints(null);
      return;
    }
    if (!currentPoints || currentPoints.length === 0) {
      setCurrentPoints(null);
      return;
    }
    // Phase 9 — auto-perfect runs off the hot draw path, on stroke end only. Done
    // before the write so we can recognize against the full-fidelity stroke; the
    // pen color/width are captured now since state may change before the prompt.
    const recognized = tools.shapeRecMode !== "never" ? recognizeShape(currentPoints) : null;
    const recColor = tools.activeColor;
    const recWidth = tools.activeStrokeWidth;
    const pathId = await elements.commitStroke(currentPoints, recColor, recWidth);
    if (pathId && recognized) {
      if (tools.shapeRecMode === "always") {
        await elements.replaceStrokeWithShape(pathId, recognized, recColor, recWidth);
      } else {
        // "ask": leave the stroke in place and offer a discreet prompt.
        tools.setPerfectCandidate({
          pathId,
          shape: recognized,
          color: recColor,
          strokeWidth: recWidth,
        });
      }
    }
    setCurrentPoints(null);
  };

  // Anchor a new comment to the topmost element under the tap. A tap on empty
  // canvas does nothing — comments must attach to an element (Phase 7).
  const anchorCommentAt = (point: Point) => {
    const hit = elements.hitTestAny(point);
    if (!hit) {
      onError("Tap an element to anchor a comment to it.");
      return;
    }
    const box = elements.boxOfElement(hit.id, hit.kind);
    if (!box) return;
    comments.beginAnchor({
      anchorElementId: hit.id,
      anchorKind: hit.kind as CommentAnchorKind,
      offsetX: point.x - box.minX,
      offsetY: point.y - box.minY,
    });
  };

  // --- Canvas tap (point is board-space) ---

  const handleCanvasTap = (point: Point) => {
    // Phase 7: a tap while following hands control back to the follower and does
    // nothing else (the tap is consumed by exiting follow mode).
    if (collab.followingId) {
      collab.exitFollow();
      return;
    }
    // The Hand tool only pans, and shapes require a drag to size them — a tap
    // does nothing in either.
    if (tools.activeTool === "hand" || tools.activeTool === "shape") return;
    // Month 5 (laser pointer) — never content creation, so ahead of the
    // `presenterLocksContentCreation` gate below like comment/select: a
    // presentation shouldn't stop the audience from pointing at something.
    // This also has to come before the fallback at the bottom of this
    // function — without an explicit branch here, a stationary tap with the
    // laser tool active would fall through to that fallback's "it's pen"
    // assumption and persist a dot, which is exactly what this tool must
    // never do (see `cursorService.ts`'s "never writes a laser ping to the
    // path collection" test). A tap is short enough that it may never reach
    // `publishPointer` via `onPointerMove`, so it sends its own single ping
    // here instead — `pressed: true` unconditionally, since a completed tap
    // is by definition a real point, not a hover.
    if (tools.activeTool === "laser") { collab.publishPointer(point, true); return; }
    if (tools.activeTool === "comment") { anchorCommentAt(point); return; }
    if (tools.activeTool === "select") {
      elements.selectAtPoint(point, isShiftHeld());
      return;
    }
    // Month 5 — same content-creation lock as stroke start/move/end, applied
    // to the tap path: a stationary tap is how text gets created, the eraser
    // deletes, and the pen drops a dot, so all three are real mutations that
    // need the same guard. Comment tapping (above) and select (above) are
    // deliberately outside this check — see the scope note on
    // `presenterLocksContentCreation`.
    if (presenterLocksContentCreation) return;
    if (tools.activeTool === "text") {
      if (editingTextId || elements.selection.count > 0) {
        // First tap on blank canvas deselects the active element
        onEditText(null);
        elements.selection.clear();
      } else {
        elements.createTextElement(point, tools.activeColor);
      }
      return;
    }
    if (tools.activeTool === "eraser") {
      elements.eraseTap(point, tools.activeStrokeWidth);
      return;
    }
    // Pen: a stationary tap drops a single-point dot.
    elements.drawDot(point, tools.activeColor, tools.activeStrokeWidth);
  };

  const handleTextSelect = (elementId: string) => {
    // Shift-tap toggles membership (no inline edit); a plain tap selects + edits.
    if (isShiftHeld()) {
      elements.selection.toggle(elementId);
      return;
    }
    elements.selection.select(elementId);
    onEditText(elementId);
  };

  // "ask"-mode prompt action: accept swaps the stroke for the clean primitive.
  const acceptPerfect = async () => {
    const c = tools.perfectCandidate;
    tools.setPerfectCandidate(null);
    if (c) await elements.replaceStrokeWithShape(c.pathId, c.shape, c.color, c.strokeWidth);
  };

  const inGroupGesture = !!elements.dragOffset || !!elements.transformPreview;

  // Month 5 — voice notes' record-entry-point (ROADMAP.md:583-587). Live
  // only while exactly one element is selected with the select tool, not
  // mid-transform (the selection box is moving/resizing, same guard as the
  // selection action bar's `showSelectionActions`), and that element has no
  // note yet — `AudioAffordance` itself is what renders the existing note's
  // play badge once one exists, from `elements.visible.audioNotes` below.
  // Positioned at the selection box's top-right corner + a small margin so
  // it never sits on top of `SelectionOverlay`'s own action bar/handles.
  const singleSelectedId =
    tools.activeTool === "select" &&
    !inGroupGesture &&
    !presenterLocksContentCreation &&
    elements.selection.count === 1
      ? elements.selection.selectedId
      : null;
  const selectedHasVoiceNote =
    !!singleSelectedId &&
    elements.visible.audioNotes.some((a) => a.anchorElementId === singleSelectedId);
  const newVoiceNoteAnchor =
    singleSelectedId && !selectedHasVoiceNote && elements.overlayBounds
      ? { elementId: singleSelectedId, x: elements.overlayBounds.maxX + 8, y: elements.overlayBounds.minY }
      : null;

  return (
    <View
      style={styles.canvasContainer}
      onLayout={(e) =>
        onLayoutSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
      }
    >
      {elements.loading && (
        <View style={styles.canvasLoadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.canvasLoadingText}>Loading canvas…</Text>
        </View>
      )}
      <DrawingCanvas
        ref={canvasRef}
        paths={elements.visible.paths}
        shapes={elements.visible.shapes}
        images={elements.visible.images}
        shapeDraft={tools.shapeDraft}
        guides={tools.guides}
        selectedIds={elements.selection.selectedIds}
        selectionBoxes={tools.activeTool === "select" ? elements.selectedBoxes : undefined}
        selectedTransform={elements.selectedTransform}
        marquee={elements.marquee}
        backgroundTemplate={backgroundTemplate}
        currentPath={currentPoints}
        color={tools.activeColor}
        strokeWidth={tools.activeStrokeWidth}
        tool={tools.activeTool === "eraser" ? "eraser" : "pen"}
        viewport={viewport}
        enablePanZoom={enablePanZoom}
        panMode={tools.activeTool === "hand" || tools.spacePanActive}
        width={canvasSize.width}
        height={canvasSize.height}
        onStrokeStart={handleStrokeStart}
        onStrokeMove={handleStrokeMove}
        onStrokeEnd={handleStrokeEnd}
        onTap={handleCanvasTap}
        onPointerMove={collab.publishPointer}
        onPanBy={onPanBy}
        onZoomAtPoint={onZoomAtPoint}
        onFling={onFling}
        onGestureStart={onGestureStart}
      />
      <BoardOverlayLayer
        enablePanZoom={enablePanZoom}
        viewport={viewport}
        notes={elements.visible.notes}
        pendingNotePosition={elements.pendingNotePosition}
        onSubmitNote={elements.submitNote}
        onCancelNote={elements.cancelNote}
        onDeleteNote={elements.deleteNote}
        textElements={elements.visible.texts}
        previewText={elements.previewText}
        isSelected={elements.selection.isSelected}
        editingTextId={editingTextId}
        onSelectText={handleTextSelect}
        onBlurText={elements.commitTextEdit}
        onResizeText={elements.resizeTextElement}
        onDeleteText={elements.deleteTextElement}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
        overlayBounds={elements.overlayBounds}
        overlayRotation={elements.overlayRotation}
        selectToolActive={tools.activeTool === "select"}
        marquee={elements.marquee}
        selectionCount={elements.selection.count}
        showSelectionActions={!inGroupGesture}
        onDeleteSelected={onDeleteSelected}
        onDuplicateSelected={
          presenterLocksContentCreation ? undefined : elements.duplicateSelected
        }
        onBringToFront={elements.bringToFront}
        onSendToBack={elements.sendToBack}
        onTransformStart={elements.beginTransform}
        onTransformMove={elements.moveTransform}
        onTransformEnd={elements.endTransform}
        showCommentPins={!inGroupGesture}
        commentPins={commentPins}
        activeCommentId={comments.activeCommentId}
        onPressPin={comments.openThread}
        boardId={boardId}
        plan={plan}
        audioNotes={elements.visible.audioNotes}
        newVoiceNoteAnchor={newVoiceNoteAnchor}
      />
      {/* Phase 6 — live cursors. A separate, self-subscribing top layer so
          remote cursor updates repaint only this overlay, never the element
          tree (Appendix A.4). Shares the live viewport to track pan/zoom. */}
      <CursorLayer
        boardId={boardId}
        viewport={viewport}
        selfId={currentUserId}
        blockedIds={blockedIds}
      />
      {/* Phase 7 — follow-mode indicator. Tapping it (or the canvas) exits.
          Month 5: suppressed while `activePresenter` is set (active or
          paused) — both banners render top-center and would overlap. While
          the presentation is active our camera mirrors the presenter, not
          `followingId` (precedence case 1 in `src/lib/presenter.ts`), so
          "Following X" would be misleading then; while it's paused the
          camera *does* fall back to `followingId` (case 2 → case 3), but the
          presenter banner still wins the shared banner slot so the room's
          attention stays on the paused presentation rather than switching
          banners mid-pause. */}
      {collab.followingId && !collab.activePresenter && (
        <TouchableOpacity style={styles.followBanner} onPress={collab.exitFollow} activeOpacity={0.85}>
          <Ionicons name="eye-outline" size={15} color="#fff" />
          <Text style={styles.followBannerText} numberOfLines={1}>
            Following {collab.presence.find((p) => p.userId === collab.followingId)?.displayName ?? "user"}
          </Text>
          <Ionicons name="close" size={15} color="#fff" />
        </TouchableOpacity>
      )}
      {/* Month 5 — audience-facing presenter banner. Renders nothing when
          `activePresenter` is null (nobody but possibly me is presenting —
          it's always null on the presenter's own client). */}
      <PresentingBanner
        presenterName={collab.activePresenter?.displayName ?? null}
        paused={collab.activePresenter?.paused ?? false}
      />
      {enablePanZoom && (
        <ZoomControls
          scale={viewport.scale}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onReset={onResetViewport}
          onFit={onFitToContent}
        />
      )}
      <PerfectShapePrompt
        viewport={viewport}
        shape={tools.perfectCandidate?.shape ?? null}
        onAccept={presenterLocksContentCreation ? undefined : acceptPerfect}
        onDismiss={tools.dismissPerfect}
      />
      <AiSelectionActions
        viewport={viewport}
        ocrEnabled={ai.ocrEnabled}
        explainEnabled={ai.explainEnabled}
        selectionActionable={
          tools.activeTool === "select" &&
          elements.selection.count > 0 &&
          !inGroupGesture &&
          !ai.ocrCandidate
        }
        selectionUnion={elements.selectionUnion}
        ocrBusy={ai.ocrBusy}
        onRecognizeText={presenterLocksContentCreation ? undefined : ai.recognizeText}
        explainBusy={ai.explainBusy}
        onExplain={presenterLocksContentCreation ? undefined : ai.explain}
        ocrCandidate={ai.ocrCandidate}
        onAcceptOcr={presenterLocksContentCreation ? undefined : ai.acceptOcr}
        onDismissOcr={ai.dismissOcr}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  canvasContainer: {
    flex: 1,
  },
  canvasLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.85)",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    zIndex: 10,
  },
  canvasLoadingText: {
    fontSize: 14,
    color: "#6b7280",
    fontWeight: "500",
  },
  followBanner: {
    position: "absolute",
    top: 12,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 240,
    backgroundColor: "#7c3aed",
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 20,
    zIndex: 120,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  followBannerText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
});
