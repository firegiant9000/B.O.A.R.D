import React from "react";
import { View, StyleSheet } from "react-native";
import TextNoteOverlay from "../TextNoteOverlay";
import TextElementView from "../TextElementView";
import SelectionOverlay, { HandleId } from "../SelectionOverlay";
import CommentPinLayer, { CommentPin } from "../CommentPinLayer";
import AudioAffordance from "./AudioAffordance";
import { Bounds, Point, Viewport } from "../../lib/viewport";
import { AudioElement, Plan, TextElement, TextNote } from "../../types";

/**
 * The board-space overlay layer (Month 5/6 Task 1 — extracted verbatim from
 * `app/board/[id].tsx`).
 *
 * Everything here shares the canvas viewport transform, so text elements, sticky
 * notes, the selection overlay and the comment pins stay locked to the strokes
 * when panning/zooming. Intentionally dumb: it renders what it is given and
 * reports gestures back up.
 */

interface BoardOverlayLayerProps {
  /** Phase 2 pan/zoom transform; false renders at identity (the rollback path). */
  enablePanZoom: boolean;
  viewport: Viewport;

  // Sticky notes (legacy)
  notes: TextNote[];
  pendingNotePosition: Point | null;
  onSubmitNote: (content: string) => void;
  onCancelNote: () => void;
  onDeleteNote: (noteId: string) => void;

  // Text elements
  textElements: TextElement[];
  /** Applies the live move/resize/rotate preview so text tracks the SVG layer. */
  previewText: (el: TextElement) => TextElement;
  isSelected: (id: string) => boolean;
  editingTextId: string | null;
  onSelectText: (id: string) => void;
  onBlurText: (id: string, text: string) => void;
  onResizeText: (id: string, width: number, height: number, fontSize: number) => void;
  onDeleteText: (id: string) => void;

  /**
   * Viewer uid — drives who may delete a note / text element. Undefined before
   * sign-in resolves, and left undefined (rather than coerced to "") so an
   * unauthenticated viewer never matches an element stamped with an empty uid.
   */
  currentUserId: string | undefined;
  isAdmin: boolean;

  // Selection overlay
  overlayBounds: Bounds | null;
  overlayRotation: number;
  /** True only while the select tool is active — the overlay is select-mode chrome. */
  selectToolActive: boolean;
  marquee: Bounds | null;
  selectionCount: number;
  /** False while a transform/drag is in flight, which hides the action bar. */
  showSelectionActions: boolean;
  onDeleteSelected: () => void;
  /** Undefined suppresses the duplicate button entirely (Month 5 presenter lock). */
  onDuplicateSelected?: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onTransformStart: (handle: HandleId) => void;
  onTransformMove: (handle: HandleId, dxBoard: number, dyBoard: number) => void;
  onTransformEnd: () => void;

  // Comment pins
  /** Hidden during a group transform to avoid clutter. */
  showCommentPins: boolean;
  commentPins: CommentPin[];
  activeCommentId: string | null;
  onPressPin: (id: string) => void;

  // Voice notes (Month 5, ROADMAP.md:583-587)
  boardId: string;
  /** The workspace's plan — the advisory Pro gate AudioAffordance reads
   *  (see audioService.canRecordVoiceNotes's header). */
  plan: Plan;
  /** Every existing voice note the viewer can see (blocked-user filtered by
   *  the caller); rendered as a play/pause + long-press-delete badge at each
   *  note's own persisted `x`/`y` — not viewport-culled, like `commentPins`. */
  audioNotes: AudioElement[];
  /**
   * The record-entry-point affordance: set only while exactly one element is
   * selected AND it has no voice note yet (the caller computes both — this
   * layer has no selection logic of its own). `null` renders nothing extra.
   */
  newVoiceNoteAnchor: { elementId: string; x: number; y: number } | null;
}

export default function BoardOverlayLayer({
  enablePanZoom,
  viewport,
  notes,
  pendingNotePosition,
  onSubmitNote,
  onCancelNote,
  onDeleteNote,
  textElements,
  previewText,
  isSelected,
  editingTextId,
  onSelectText,
  onBlurText,
  onResizeText,
  onDeleteText,
  currentUserId,
  isAdmin,
  overlayBounds,
  overlayRotation,
  selectToolActive,
  marquee,
  selectionCount,
  showSelectionActions,
  onDeleteSelected,
  onDuplicateSelected,
  onBringToFront,
  onSendToBack,
  onTransformStart,
  onTransformMove,
  onTransformEnd,
  showCommentPins,
  commentPins,
  activeCommentId,
  onPressPin,
  boardId,
  plan,
  audioNotes,
  newVoiceNoteAnchor,
}: BoardOverlayLayerProps) {
  // Overlay transform — mirrors the SVG <G transform>. transformOrigin "0 0"
  // makes RN's transform anchor at the top-left so it matches SVG semantics
  // (screen = translate + scale * board), instead of RN's default center origin.
  const overlayTransformStyle = enablePanZoom
    ? {
        transform: [
          { translateX: viewport.x },
          { translateY: viewport.y },
          { scale: viewport.scale },
        ],
        transformOrigin: "0 0" as const,
      }
    : undefined;

  // Month 5 — counter-scale for the voice-note badges, same technique
  // CommentPinLayer uses internally: divide out the board's zoom so the icon
  // stays a constant on-screen size instead of shrinking/growing with it.
  const audioInv = 1 / (viewport.scale || 1);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View style={[StyleSheet.absoluteFill, overlayTransformStyle]} pointerEvents="box-none">
        <TextNoteOverlay
          notes={notes}
          pendingNotePosition={pendingNotePosition}
          currentUserId={currentUserId ?? ""}
          isAdmin={isAdmin}
          onSubmitNote={onSubmitNote}
          onCancelNote={onCancelNote}
          onDeleteNote={onDeleteNote}
        />
        {textElements.map((el) => {
          const display = previewText(el);
          return (
            <TextElementView
              key={el.id}
              element={display}
              isSelected={isSelected(el.id)}
              isEditing={editingTextId === el.id}
              scale={viewport.scale}
              onSelect={onSelectText}
              onBlur={onBlurText}
              onResize={onResizeText}
              onDelete={el.userId === currentUserId || isAdmin ? onDeleteText : undefined}
            />
          );
        })}
        {overlayBounds && selectToolActive && !marquee && (
          <SelectionOverlay
            bounds={overlayBounds}
            rotation={overlayRotation}
            scale={viewport.scale}
            count={selectionCount}
            showActions={showSelectionActions}
            onDelete={onDeleteSelected}
            onDuplicate={onDuplicateSelected}
            onBringToFront={onBringToFront}
            onSendToBack={onSendToBack}
            onTransformStart={onTransformStart}
            onTransformMove={onTransformMove}
            onTransformEnd={onTransformEnd}
          />
        )}
        {/* Phase 7 — comment pins, in the same board-space overlay so they
            track the canvas. Hidden during a group transform to avoid clutter. */}
        {showCommentPins && (
          <CommentPinLayer
            pins={commentPins}
            scale={viewport.scale}
            activeId={activeCommentId}
            onPressPin={onPressPin}
          />
        )}
        {/* Month 5 — voice notes (ROADMAP.md:583-587). Every existing note
            renders as a play/pause + long-press-delete badge at its own
            persisted position ("Tap a speaker icon on the element to
            play"). The record-entry-point (`newVoiceNoteAnchor`, set only
            while exactly one element is selected and has no note yet) is
            the same component in its `audio={null}` state. Counter-scaled
            like the comment pins above so it doesn't shrink/grow with zoom. */}
        {audioNotes.map((note) => (
          <View
            key={note.id}
            pointerEvents="box-none"
            style={{ position: "absolute", left: note.x, top: note.y, transform: [{ scale: audioInv }] }}
          >
            <AudioAffordance
              boardId={boardId}
              anchorElementId={note.anchorElementId}
              userId={currentUserId ?? ""}
              x={note.x}
              y={note.y}
              plan={plan}
              audio={note}
            />
          </View>
        ))}
        {newVoiceNoteAnchor && (
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              left: newVoiceNoteAnchor.x,
              top: newVoiceNoteAnchor.y,
              transform: [{ scale: audioInv }],
            }}
          >
            <AudioAffordance
              boardId={boardId}
              anchorElementId={newVoiceNoteAnchor.elementId}
              userId={currentUserId ?? ""}
              x={newVoiceNoteAnchor.x}
              y={newVoiceNoteAnchor.y}
              plan={plan}
              audio={null}
            />
          </View>
        )}
      </View>
    </View>
  );
}
