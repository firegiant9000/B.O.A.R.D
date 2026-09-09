import React, { useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DrawingCanvas from "../DrawingCanvas";
import ZoomControls from "../ZoomControls";
import CursorLayer from "../CursorLayer";
import BoardOverlayLayer from "./BoardOverlayLayer";
import AiSelectionActions from "./AiSelectionActions";
import PerfectShapePrompt from "./PerfectShapePrompt";
import type { CommentPin } from "../CommentPinLayer";
import { Point, Viewport } from "../../lib/viewport";
import { recognizeShape } from "../../lib/shapeRecognition";
import type { BoardElements } from "../../hooks/useBoardElements";
import type { BoardTools } from "../../hooks/useBoardTools";
import type { BoardCollab } from "../../hooks/useBoardCollab";
import type { BoardAI } from "../../hooks/useBoardAI";
import type { BoardComments } from "../../hooks/useBoardComments";
import { BackgroundTemplate, CommentAnchorKind } from "../../types";

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

  const handleStrokeStart = () => {
    if (tools.activeTool === "select") { elements.beginSelectGesture(); return; }
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
    if (tools.activeTool === "comment") { anchorCommentAt(point); return; }
    if (tools.activeTool === "select") {
      elements.selectAtPoint(point, isShiftHeld());
      return;
    }
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
        onDuplicateSelected={elements.duplicateSelected}
        onBringToFront={elements.bringToFront}
        onSendToBack={elements.sendToBack}
        onTransformStart={elements.beginTransform}
        onTransformMove={elements.moveTransform}
        onTransformEnd={elements.endTransform}
        showCommentPins={!inGroupGesture}
        commentPins={commentPins}
        activeCommentId={comments.activeCommentId}
        onPressPin={comments.openThread}
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
      {/* Phase 7 — follow-mode indicator. Tapping it (or the canvas) exits. */}
      {collab.followingId && (
        <TouchableOpacity style={styles.followBanner} onPress={collab.exitFollow} activeOpacity={0.85}>
          <Ionicons name="eye-outline" size={15} color="#fff" />
          <Text style={styles.followBannerText} numberOfLines={1}>
            Following {collab.presence.find((p) => p.userId === collab.followingId)?.displayName ?? "user"}
          </Text>
          <Ionicons name="close" size={15} color="#fff" />
        </TouchableOpacity>
      )}
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
        onAccept={acceptPerfect}
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
        onRecognizeText={ai.recognizeText}
        explainBusy={ai.explainBusy}
        onExplain={ai.explain}
        ocrCandidate={ai.ocrCandidate}
        onAcceptOcr={ai.acceptOcr}
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
