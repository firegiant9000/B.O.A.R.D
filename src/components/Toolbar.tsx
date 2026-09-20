import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { STROKE_WIDTH_PRESETS } from "./StrokeWidthModal";

// Month 5 adds "laser" — this type has to admit the value since `activeTool`
// flows straight through from `useBoardTools`'s wider `Tool`.
type Tool = "pen" | "eraser" | "text" | "select" | "shape" | "hand" | "comment" | "laser";

interface ToolbarProps {
  activeTool: Tool;
  activeColor: string;
  activeStrokeWidth: number;
  isAdmin: boolean;
  /**
   * Whether the viewer may edit canvas content (Phase 6 effective editor). When
   * false, editing tools are hidden and only navigation (select/hand) remains;
   * the security rules enforce read-only server-side regardless.
   */
  canEdit?: boolean;
  /**
   * Whether the viewer may comment (Phase 7 commenter+). The comment tool shows
   * for editors and commenters; a pure viewer never sees it.
   */
  canComment?: boolean;
  onToolChange: (tool: Tool) => void;
  onColorChange: (color: string) => void;
  onStrokeWidthChange: (width: number) => void;
  /** Month 5 (ROADMAP item 12) — opens the full custom colour picker (hex,
   *  alpha, recents, per-workspace swatches). Additive: the 8 quick dots
   *  above keep their exact pre-existing behavior via `onColorChange`; this
   *  is a 9th "more" entry, not a replacement. */
  onOpenColorPicker: () => void;
  /** Opens the stroke-width picker's continuous slider — the 6 quick presets
   *  below keep working via `onStrokeWidthChange` unchanged. */
  onOpenWidthPicker: () => void;
  /** Insert an image (gallery/camera on native, file dialog on web). Phase 9. */
  onInsertImage: () => void;
  /**
   * Month 5 — whether the image-insert button shows at all. Defaults to true
   * (every existing caller is unaffected). The one caller that passes false is
   * an editable embed session (app/board/[id].tsx): `storage.rules` gates
   * `images`/`audio` bytes on board membership, and an embed identity is
   * never a member, so `firestore.rules`' `isEmbedEditor` deliberately excludes
   * both collections regardless of scope (see Month 5's embed rules). Showing
   * this button there would let the viewer pick an image, upload real Storage
   * bytes, and only then discover the doc write is denied — the same
   * offer-what-you-can't-fulfil shape this file's `canEdit` branch already
   * exists to avoid for read-only viewers.
   */
  canInsertImage?: boolean;
  /** Month 6 — camera capture + OCR (descoped scanner: capture + crop + OCR,
   *  no `expo-document-scanner` — see `scanService`'s header). Opens the
   *  camera and, on a shot, uploads it as an ordinary image element and runs
   *  the existing OCR pipeline on it. */
  onScanDocument: () => void;
  /**
   * Month 6 — whether the scan button shows at all. Defaults to true. Mirrors
   * `canInsertImage`'s embed-session caveat exactly, for the identical reason:
   * a scan lands through the same `images` write path, which carries no
   * `isEmbedEditor` disjunct in firestore.rules, so an embed editor could
   * never create one regardless of scope.
   */
  canScanDocument?: boolean;
  /** Insert a poll (Month 6) — opens PollComposer; position is chosen by the
   *  caller (BoardCanvas centers it in the current viewport). */
  onInsertPoll: () => void;
  /**
   * Month 6 — whether the poll-insert button shows at all. Defaults to true.
   * Mirrors `canInsertImage`'s embed-session caveat exactly, for a related
   * but distinct reason: firestore.rules' `polls` match carries NO
   * `isEmbedEditor` disjunct at all (a poll's voter-identity model is a
   * member-engagement feature, like comments, not bare canvas geometry —
   * see that rule's own comment) — so an embed editor could never create one
   * regardless of scope, and this button should not offer what every scope
   * would have denied.
   */
  canInsertPoll?: boolean;
  /** Month 6 — insert a LaTeX equation. Opens MathComposer; the equation's
   *  board-space position is chosen by the caller (the screen centers it in
   *  the current viewport), because an equation has no placing gesture of its
   *  own, exactly like a poll. */
  onInsertMath: () => void;
  /**
   * Month 6 — whether the equation button shows at all. Defaults to true.
   * The screen passes `mathService.isMathConfigured()` (the build-time
   * feature flag) AND the same embed-session caveat `canInsertPoll` carries:
   * firestore.rules' `mathElements` match has no `isEmbedEditor` disjunct, so
   * an embed editor could never create one at any scope, and this button must
   * not offer what would be denied. Hiding a button is an affordance, never a
   * gate — the callable's membership check and firestore.rules are what
   * actually stop the write.
   */
  canInsertMath?: boolean;
  /** Month 6 — insert a code element. Opens the code composer; the element's
   *  board-space position is chosen by the caller (the screen centers it in
   *  the current viewport), exactly like the equation button. */
  onInsertCode: () => void;
  /**
   * Month 6 — whether the code button shows at all. Defaults to true. The
   * screen passes `codeService.isCodeConfigured()` (the build-time feature
   * flag) — UNLIKE `canInsertMath`/`canInsertPoll`, this is NOT also
   * conditioned on `!embedMode`: firestore.rules' `codeElements` match
   * carries the same `isEmbedEditor` disjunct paths/shapes/textElements do
   * (a code element needs no callable and no Storage bytes), so an embed
   * editor's write here is reachable exactly like a shape's already is, and
   * hiding the button for one would be hiding an affordance nothing denies.
   */
  canInsertCode?: boolean;
  /** Month 6 — sticky notes (8 colours, 3 sizes, markdown, pin-to-position OR
   *  attach-to-element). The board's ONE insert entry point: the screen
   *  resolves the actual board-space point (the current viewport center,
   *  exactly like the equation/code/poll buttons above) and calls
   *  `elements.beginNote`, which itself decides pin-vs-attach from whatever
   *  is currently selected — see that function's own comment. Without this
   *  button the colour/size picker in `TextNoteOverlay.tsx` would be a
   *  component nobody could ever reach. */
  onInsertNote: () => void;
  /** Month 6 — whether the note-insert button shows at all. Defaults to
   *  true. Mirrors `canInsertCode`'s embed-session stance (NOT also gated on
   *  `!embedMode`): firestore.rules' `notes` match carries the same
   *  `isEmbedEditor` disjunct paths/shapes/textElements/codeElements do (a
   *  sticky note needs no callable and no Storage bytes), so an embed editor
   *  could already write one at any scope, and this button should not hide
   *  what nothing denies.
   */
  canInsertNote?: boolean;
  onUndo: () => void;
  onRedo?: () => void;
  canRedo?: boolean;
  onClear: () => void;
  onSave: () => void;
  /**
   * Month 5 — whether the manual Save button shows. Defaults to true. The one
   * caller that passes false is an editable embed session: `onSave` bumps the
   * BOARD DOCUMENT's `updatedAt` (`doc.saveNow` → `boardService.updateBoard`
   * in app/board/[id].tsx), and the board doc stays closed to an embed
   * identity at any scope (`isEmbedEditor` in firestore.rules grants canvas
   * content + own presence/cursors only — see that predicate's header for the
   * exhaustive list). Canvas edits already persist per-element the moment
   * they're made; this button would only ever produce a visible "Failed to
   * save board" error for an embed session, so it is hidden there rather than
   * offered and denied.
   */
  canManualSave?: boolean;
}

const COLORS = [
  "#000000",
  "#FF3B30",
  "#FF9500",
  "#FFCC00",
  "#34C759",
  "#007AFF",
  "#5856D6",
  "#AF52DE",
];

// Month 5 (ROADMAP item 12 — "6 stroke widths, was 3"): imports
// `StrokeWidthModal`'s own preset list rather than keeping a second literal
// array here — fix round 1, item 9: the two were pinned by separate tests
// with nothing asserting they stayed equal, so they could silently drift
// (e.g. the modal's "more" picker offering a preset this bar's quick row
// doesn't). S/M/L's values (2/5/10) predate this task; `activeStrokeWidth`'s
// existing default (5, useBoardTools.ts) still lands on a real preset.
const STROKE_WIDTHS = STROKE_WIDTH_PRESETS;

export default function Toolbar({
  activeTool,
  activeColor,
  activeStrokeWidth,
  isAdmin,
  canEdit = true,
  canComment = true,
  onToolChange,
  onColorChange,
  onStrokeWidthChange,
  onOpenColorPicker,
  onOpenWidthPicker,
  onInsertImage,
  canInsertImage = true,
  onScanDocument,
  canScanDocument = true,
  onInsertPoll,
  canInsertPoll = true,
  onInsertMath,
  canInsertMath = true,
  onInsertCode,
  canInsertCode = true,
  onInsertNote,
  canInsertNote = true,
  onUndo,
  onRedo,
  canRedo,
  onClear,
  onSave,
  canManualSave = true,
}: ToolbarProps) {
  const handleClear = () => {
    Alert.alert(
      "Clear Board",
      "This will permanently delete all drawings and notes on this board.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear All", style: "destructive", onPress: onClear },
      ]
    );
  };

  // Read-only viewers/commenters (Phase 6): navigation only, no editing tools.
  if (!canEdit) {
    return (
      <View style={styles.container}>
        <View style={[styles.scrollContent, styles.readOnlyRow]}>
          <View style={styles.group}>
            <ToolButton
              icon="resize-outline"
              active={activeTool === "select"}
              onPress={() => onToolChange("select")}
            />
            <ToolButton
              icon="hand-left-outline"
              active={activeTool === "hand"}
              onPress={() => onToolChange("hand")}
            />
            {/* Month 5 (laser pointer) — never persists, so it's available to a
                read-only viewer the same as select/hand/comment already are;
                fix round 1: this is the tool's one touch entry point, since a
                Bluetooth-keyboard-only Shift+L hotkey is unreachable on the
                phone/tablet a presenter is actually likely to be holding. */}
            <ToolButton
              icon="locate-outline"
              active={activeTool === "laser"}
              onPress={() => onToolChange("laser")}
            />
            {canComment && (
              <ToolButton
                icon="chatbubble-outline"
                active={activeTool === "comment"}
                onPress={() => onToolChange("comment")}
              />
            )}
          </View>
          <View style={styles.divider} />
          <View style={styles.viewOnlyPill}>
            <Ionicons name={canComment ? "chatbubble-outline" : "eye-outline"} size={14} color="#6b7280" />
            <Text style={styles.viewOnlyText}>{canComment ? "Comment only" : "View only"}</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Tool Selectors */}
        <View style={styles.group}>
          <ToolButton
            icon="pencil"
            active={activeTool === "pen"}
            onPress={() => onToolChange("pen")}
          />
          <ToolButton
            icon="cut-outline"
            active={activeTool === "eraser"}
            onPress={() => onToolChange("eraser")}
          />
          <ToolButton
            icon="text"
            active={activeTool === "text"}
            onPress={() => onToolChange("text")}
          />
          <ToolButton
            icon="shapes-outline"
            active={activeTool === "shape"}
            onPress={() => onToolChange("shape")}
          />
          <ToolButton
            icon="resize-outline"
            active={activeTool === "select"}
            onPress={() => onToolChange("select")}
          />
          <ToolButton
            icon="hand-left-outline"
            active={activeTool === "hand"}
            onPress={() => onToolChange("hand")}
          />
          {/* Month 5 (laser pointer) — fix round 1: the tool's one touch entry
              point. The web hotkey (Shift+L) still works alongside this. */}
          <ToolButton
            icon="locate-outline"
            active={activeTool === "laser"}
            onPress={() => onToolChange("laser")}
          />
          {canComment && (
            <ToolButton
              icon="chatbubble-outline"
              active={activeTool === "comment"}
              onPress={() => onToolChange("comment")}
            />
          )}
          {canInsertImage && (
            <ToolButton
              icon="image-outline"
              active={false}
              onPress={onInsertImage}
            />
          )}
          {/* Month 6 — camera capture + OCR (descoped scanner). The board's
              one reachable entry point for `scanDocument`; see Toolbar.tsx's
              `onScanDocument` doc comment for the embed-session caveat. */}
          {canScanDocument && (
            <ToolButton
              icon="scan-outline"
              active={false}
              onPress={onScanDocument}
            />
          )}
          {/* Month 6 — polls, quiz sequencing, dot voting. Opens PollComposer;
              creation itself is editor-only under firestore.rules, same as
              this whole branch already requires (`canEdit`). */}
          {canInsertPoll && (
            <ToolButton
              icon="bar-chart-outline"
              active={false}
              onPress={onInsertPoll}
            />
          )}
          {/* Month 6 — math elements. The board's ONE insert entry point for
              an equation (editing an existing one is a tap on the element
              itself, BoardCanvas). Creation is editor-only under
              firestore.rules, which this whole branch already requires
              (`canEdit`). */}
          {canInsertMath && (
            <ToolButton
              testID="toolbar-insert-math"
              icon="calculator-outline"
              active={false}
              onPress={onInsertMath}
            />
          )}
          {/* Month 6 — code elements. The board's ONE insert entry point for
              a snippet (editing an existing one is a tap on the element
              itself, BoardCanvas, exactly like the equation button above). */}
          {canInsertCode && (
            <ToolButton
              testID="toolbar-insert-code"
              icon="code-slash-outline"
              active={false}
              onPress={onInsertCode}
            />
          )}
          {/* Month 6 — sticky notes. The board's ONE insert entry point;
              see `onInsertNote`'s own doc comment above. */}
          {canInsertNote && (
            <ToolButton
              testID="toolbar-insert-note"
              icon="reader-outline"
              active={false}
              onPress={onInsertNote}
            />
          )}
        </View>

        <View style={styles.divider} />

        {/* Color Picker */}
        <View style={styles.group}>
          {COLORS.map((c) => (
            <TouchableOpacity
              key={c}
              testID={`toolbar-color-${c}`}
              style={[
                styles.colorDot,
                { backgroundColor: c },
                activeColor === c && styles.colorDotActive,
              ]}
              onPress={() => onColorChange(c)}
            />
          ))}
          {/* Month 5 (ROADMAP item 12) — opens the full custom picker (hex,
              alpha, recents, per-workspace swatches); the 8 dots above are
              unchanged quick access, not replaced by this. */}
          <TouchableOpacity
            testID="toolbar-open-color-picker"
            style={styles.moreBtn}
            onPress={onOpenColorPicker}
            accessibilityRole="button"
            accessibilityLabel="More colours"
          >
            <Ionicons name="color-palette-outline" size={18} color="#333" />
          </TouchableOpacity>
        </View>

        <View style={styles.divider} />

        {/* Stroke Width */}
        <View style={styles.group}>
          {STROKE_WIDTHS.map((sw) => (
            <TouchableOpacity
              key={sw.value}
              testID={`toolbar-stroke-${sw.value}`}
              style={[
                styles.strokeBtn,
                activeStrokeWidth === sw.value && styles.strokeBtnActive,
              ]}
              onPress={() => onStrokeWidthChange(sw.value)}
            >
              <View
                style={[
                  styles.strokePreview,
                  {
                    width: sw.value * 3 + 4,
                    height: sw.value * 3 + 4,
                    borderRadius: (sw.value * 3 + 4) / 2,
                    backgroundColor:
                      activeStrokeWidth === sw.value ? "#fff" : "#333",
                  },
                ]}
              />
            </TouchableOpacity>
          ))}
          {/* Opens the continuous-slider picker — the 6 presets above cover
              the common cases via onStrokeWidthChange unchanged. */}
          <TouchableOpacity
            testID="toolbar-open-width-picker"
            style={styles.moreBtn}
            onPress={onOpenWidthPicker}
            accessibilityRole="button"
            accessibilityLabel="More stroke widths"
          >
            <Ionicons name="options-outline" size={18} color="#333" />
          </TouchableOpacity>
        </View>

        <View style={styles.divider} />

        {/* Actions */}
        <View style={styles.group}>
          <ToolButton icon="arrow-undo" active={false} onPress={onUndo} />
          <ToolButton icon="arrow-redo" active={false} onPress={onRedo ?? (() => {})} disabled={canRedo === false} />
          {isAdmin && (
            <ToolButton icon="trash-outline" active={false} onPress={handleClear} />
          )}
          {canManualSave && (
            <ToolButton icon="save-outline" active={false} onPress={onSave} />
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function ToolButton({
  icon,
  active,
  onPress,
  disabled,
  testID,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** Optional — the icon-only buttons here are otherwise unaddressable from a
   *  render test. Added with Month 6's equation button; existing buttons are
   *  untouched and still pass none. */
  testID?: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      style={[styles.toolBtn, active && styles.toolBtnActive, disabled && styles.toolBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Ionicons name={icon} size={20} color={active ? "#fff" : disabled ? "#c7c7cc" : "#333"} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 30,
    left: 10,
    right: 10,
    backgroundColor: "#F2F2F7",
    borderRadius: 16,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
  },
  scrollContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  readOnlyRow: {
    justifyContent: "center",
  },
  viewOnlyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  viewOnlyText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6b7280",
  },
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  divider: {
    width: 1,
    height: 28,
    backgroundColor: "#C7C7CC",
    marginHorizontal: 8,
  },
  toolBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  toolBtnActive: {
    backgroundColor: "#2563eb",
  },
  toolBtnDisabled: {
    opacity: 0.4,
  },
  colorDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorDotActive: {
    borderColor: "#2563eb",
    borderWidth: 3,
  },
  strokeBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  strokeBtnActive: {
    backgroundColor: "#2563eb",
  },
  strokePreview: {
    backgroundColor: "#333",
  },
  moreBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#D1D1D6",
    marginLeft: 2,
  },
});
