import React from "react";
import { View, StyleSheet } from "react-native";
import TextNoteOverlay from "../TextNoteOverlay";
import TextElementView from "../TextElementView";
import SelectionOverlay, { HandleId } from "../SelectionOverlay";
import CommentPinLayer, { CommentPin } from "../CommentPinLayer";
import AudioAffordance from "./AudioAffordance";
import ReactionBadge from "./ReactionBadge";
import { Bounds, Point, Viewport } from "../../lib/viewport";
import { AudioElement, Plan, ReactionEmoji, TextElement, TextNote } from "../../types";
import type { ReactionCount } from "../../hooks/useBoardReactions";

// Month 5 — an existing voice note, paired with the LIVE board-space
// position its badge should render at. The caller (BoardCanvas) resolves
// this from the anchor element's current bounds (`boxOfElement`), not from
// the note's own persisted `x`/`y` — see AudioElement's type comment for why
// those aren't trustworthy for rendering. This layer stays "dumb": it just
// places what it's given.
export interface PositionedAudioNote {
  note: AudioElement;
  x: number;
  y: number;
}

// Month 6 — an element with a resolved reaction badge position. Like
// `PositionedAudioNote`, the caller (BoardCanvas) does the join against live
// element geometry; this layer just places what it's given.
export interface PositionedReactionBadge {
  elementId: string;
  x: number;
  y: number;
  counts: ReactionCount[];
}

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
   *  the caller), each paired with its LIVE render position; rendered as a
   *  play/pause + long-press-delete badge — not viewport-culled, like
   *  `commentPins`. */
  audioNotes: PositionedAudioNote[];
  /**
   * The record-entry-point affordance: set only while exactly one element is
   * selected AND it has no voice note yet (the caller computes both — this
   * layer has no selection logic of its own). `null` renders nothing extra.
   */
  newVoiceNoteAnchor: { elementId: string; x: number; y: number } | null;

  // Reactions (Month 6)
  /** Every element that gets a reaction badge this render — either it already
   *  has a reaction from any member, or it's the lone current selection
   *  (BoardCanvas decides which; see its own `positionedReactionBadges`). */
  reactionBadges: PositionedReactionBadge[];
  /** Commenter+ (mirrors firestore.rules' `reactions` match) — a viewer sees
   *  existing counts but can't toggle one. */
  canReact: boolean;
  onToggleReaction: (elementId: string, emoji: ReactionEmoji) => void;
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
  reactionBadges,
  canReact,
  onToggleReaction,
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

  // Month 5, fix round 1 (item 11) — counter-scale for the voice-note
  // badges. Divides out the board's zoom so the icon stays a constant
  // on-screen size instead of shrinking/growing with it, matching
  // CommentPinLayer's OWN technique exactly: that layer scales the pin's
  // rendered *dimensions* (width/height/fontSize, all multiplied by `inv`)
  // on a plain `left`/`top`-positioned box, never a `transform: scale`. RN's
  // transform scale is center-origin, so applying it to a wrapping View (an
  // earlier version of this code did) drifts the badge's visual top-left
  // away from its true board-space `(x, y)` at any zoom ≠ 1 — the wrapper's
  // own center stays fixed, not its corner. `AudioAffordance`'s own `scale`
  // prop applies this the same way CommentPinLayer does, to its own
  // dimensions and icon size.
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
            renders as a play/pause + long-press-delete badge at its LIVE
            resolved position ("Tap a speaker icon on the element to play").
            The record-entry-point (`newVoiceNoteAnchor`, set only while
            exactly one element is selected and has no note yet) is the same
            component in its `audio={null}` state. Positioned with plain
            `left`/`top` (no transform) — see `audioInv`'s comment for why. */}
        {audioNotes.map(({ note, x, y }) => (
          <View key={note.id} pointerEvents="box-none" style={{ position: "absolute", left: x, top: y }}>
            <AudioAffordance
              boardId={boardId}
              anchorElementId={note.anchorElementId}
              userId={currentUserId ?? ""}
              x={x}
              y={y}
              plan={plan}
              scale={audioInv}
              audio={note}
            />
          </View>
        ))}
        {newVoiceNoteAnchor && (
          <View
            // Fix round 1, item 4: keyed by the anchor's own element id so
            // selecting a DIFFERENT element mid-recording unmounts this
            // instance instead of React reusing it with a new
            // `anchorElementId` prop — without this, a manual stop would
            // save the in-flight recording against the wrong element.
            key={newVoiceNoteAnchor.elementId}
            pointerEvents="box-none"
            style={{ position: "absolute", left: newVoiceNoteAnchor.x, top: newVoiceNoteAnchor.y }}
          >
            <AudioAffordance
              boardId={boardId}
              anchorElementId={newVoiceNoteAnchor.elementId}
              userId={currentUserId ?? ""}
              x={newVoiceNoteAnchor.x}
              y={newVoiceNoteAnchor.y}
              plan={plan}
              scale={audioInv}
              audio={null}
            />
          </View>
        )}
        {/* Month 6 — reactions. One badge per element that either already has
            a reaction or is the lone current selection (BoardCanvas decides
            which). Same counter-scale (`audioInv`) and plain `left`/`top`
            positioning as the voice-note badges above — no wrapping
            `transform: scale`. */}
        {reactionBadges.map(({ elementId, x, y, counts }) => (
          <View key={elementId} pointerEvents="box-none" style={{ position: "absolute", left: x, top: y }}>
            <ReactionBadge
              counts={counts}
              canReact={canReact}
              onToggle={(emoji) => onToggleReaction(elementId, emoji)}
              scale={audioInv}
            />
          </View>
        ))}
      </View>
    </View>
  );
}
