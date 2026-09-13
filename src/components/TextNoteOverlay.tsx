import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
  Linking,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PositionedTextNote, StickyColor } from "../types";
import { parseMarkdown, isSafeLinkUrl } from "../lib/markdown";
import {
  STICKY_COLORS,
  DEFAULT_STICKY_COLOR,
  sanitizeStickyColor,
  STICKY_FONT_SIZES,
  DEFAULT_STICKY_SIZE,
  stickySizeMetrics,
} from "../lib/stickyNotes";

/**
 * Sticky notes (Month 6 polish — 8 colours, 3 sizes, markdown, pin-to-position
 * OR attach-to-element). Plain React Native `View`/`Text`/`TextInput`, not
 * SVG — unlike the board's canvas layer, which is why this component is
 * fully render-testable.
 *
 * `notes` arrives already positioned (`PositionedTextNote`): the caller
 * (BoardCanvas) resolves an attached note's LIVE anchor bounds or a pinned
 * note's own `position` before this component ever sees it, and omits an
 * attached note whose anchor can't be found — see `PositionedTextNote`'s own
 * comment in `types/index.ts`. This component stays "dumb" about that
 * distinction; it only shows a small link glyph when `note.anchorElementId`
 * is set, so an attached note is visually distinguishable from a pinned one.
 */

interface TextNoteOverlayProps {
  notes: PositionedTextNote[];
  /** If set, shows the note editor at this position for creating a new note */
  pendingNotePosition: { x: number; y: number } | null;
  currentUserId: string;
  isAdmin: boolean;
  onSubmitNote: (content: string, options?: { color?: StickyColor; size?: number }) => void;
  onCancelNote: () => void;
  onDeleteNote: (noteId: string) => void;
}

const COLOR_ENTRIES = Object.entries(STICKY_COLORS) as [StickyColor, string][];

const SIZE_LABELS: Record<number, string> = { 12: "S", 14: "M", 18: "L" };

function openLink(url: string) {
  // Defense in depth: `parseMarkdown` already nulls out a run's `url` for
  // anything that fails `isSafeLinkUrl` (see markdown.ts), so this should
  // never see an unsafe scheme reach it — but a render path that actually
  // calls `Linking.openURL` is exactly where a regression in that upstream
  // guard would do real damage, so it re-checks rather than trusting the
  // caller unconditionally.
  if (!isSafeLinkUrl(url)) return;
  Linking.openURL(url).catch(() => undefined);
}

export default function TextNoteOverlay({
  notes,
  pendingNotePosition,
  currentUserId,
  isAdmin,
  onSubmitNote,
  onCancelNote,
  onDeleteNote,
}: TextNoteOverlayProps) {
  const [text, setText] = useState("");
  const [selectedColor, setSelectedColor] = useState<StickyColor>(DEFAULT_STICKY_COLOR);
  const [selectedSize, setSelectedSize] = useState<number>(DEFAULT_STICKY_SIZE);
  const inputRef = useRef<TextInput>(null);

  const submittedRef = useRef(false);

  useEffect(() => {
    if (pendingNotePosition) {
      setText("");
      setSelectedColor(DEFAULT_STICKY_COLOR);
      setSelectedSize(DEFAULT_STICKY_SIZE);
      submittedRef.current = false;
      const timeoutId = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timeoutId);
    }
  }, [pendingNotePosition]);

  const handleSubmit = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const trimmed = text.trim();
    if (trimmed) {
      onSubmitNote(trimmed, { color: selectedColor, size: selectedSize });
    } else {
      onCancelNote();
    }
    setText("");
    Keyboard.dismiss();
  };

  const handleCancel = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onCancelNote();
    setText("");
    Keyboard.dismiss();
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Render existing notes */}
      {notes.map(({ note, x, y }) => {
        const canDelete = isAdmin || note.userId === currentUserId;
        const color = STICKY_COLORS[sanitizeStickyColor(note.color)];
        const metrics = stickySizeMetrics(note.size);
        const blocks = parseMarkdown(note.content);
        // Original fixed layout (200-wide) offset the card -60/-20 from the
        // create point; scaling the left offset with the size keeps that
        // exact placement at the default size while staying sane at the
        // other two.
        const leftOffset = metrics.width / 2 - 40;
        return (
          <View
            key={note.id}
            style={[
              styles.note,
              {
                left: x - leftOffset,
                top: y - 20,
                maxWidth: metrics.width,
                backgroundColor: color,
              },
              isAdmin && note.userId !== currentUserId && styles.noteOtherUser,
            ]}
          >
            {note.anchorElementId && (
              <View style={styles.anchorBadge} testID={`note-anchor-badge-${note.id}`}>
                <Ionicons name="link" size={10} color="#6b7280" />
              </View>
            )}
            <View style={styles.noteContent}>
              {blocks.map((block, i) => (
                <View key={i} style={styles.noteLine}>
                  {block.marker && (
                    <Text style={[styles.noteText, { fontSize: metrics.fontSize }]}>
                      {block.marker}{" "}
                    </Text>
                  )}
                  <Text style={[styles.noteText, { fontSize: metrics.fontSize, flexShrink: 1 }]}>
                    {block.runs.map((run, j) => (
                      <Text
                        key={j}
                        style={[
                          run.bold && styles.bold,
                          run.italic && styles.italic,
                          run.url && styles.link,
                        ]}
                        onPress={run.url ? () => openLink(run.url!) : undefined}
                      >
                        {run.text}
                      </Text>
                    ))}
                  </Text>
                </View>
              ))}
            </View>
            {canDelete && (
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() => onDeleteNote(note.id)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close-circle" size={16} color="#FF3B30" />
              </TouchableOpacity>
            )}
          </View>
        );
      })}

      {/* Pending new note editor */}
      {pendingNotePosition && (
        <View
          style={[
            styles.inputContainer,
            {
              left: Math.max(10, pendingNotePosition.x - 75),
              top: Math.max(10, pendingNotePosition.y - 20),
            },
          ]}
        >
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Type note... **bold** *italic* - list [text](url)"
            multiline
            maxLength={500}
            autoFocus
          />
          <View style={styles.colorRow} testID="note-editor-colors">
            {COLOR_ENTRIES.map(([name, hex]) => (
              <TouchableOpacity
                key={name}
                testID={`note-editor-color-${name}`}
                accessibilityRole="button"
                accessibilityLabel={`Sticky note colour ${name}`}
                style={[
                  styles.colorSwatch,
                  { backgroundColor: hex },
                  selectedColor === name && styles.colorSwatchActive,
                ]}
                onPress={() => setSelectedColor(name)}
              />
            ))}
          </View>
          <View style={styles.sizeRow} testID="note-editor-sizes">
            {STICKY_FONT_SIZES.map((size) => (
              <TouchableOpacity
                key={size}
                testID={`note-editor-size-${size}`}
                accessibilityRole="button"
                accessibilityLabel={`Sticky note size ${SIZE_LABELS[size] ?? size}`}
                style={[styles.sizeBtn, selectedSize === size && styles.sizeBtnActive]}
                onPress={() => setSelectedSize(size)}
              >
                <Text style={[styles.sizeBtnText, selectedSize === size && styles.sizeBtnTextActive]}>
                  {SIZE_LABELS[size] ?? size}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.editorActions}>
            <TouchableOpacity
              testID="note-editor-cancel"
              accessibilityRole="button"
              accessibilityLabel="Cancel note"
              style={styles.editorActionBtn}
              onPress={handleCancel}
            >
              <Ionicons name="close" size={18} color="#6b7280" />
            </TouchableOpacity>
            <TouchableOpacity
              testID="note-editor-submit"
              accessibilityRole="button"
              accessibilityLabel="Add note"
              style={[styles.editorActionBtn, styles.editorSubmitBtn]}
              onPress={handleSubmit}
            >
              <Ionicons name="checkmark" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    position: "absolute",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 4,
  },
  noteOtherUser: {
    borderWidth: 1,
    borderColor: "#FF9500",
    borderStyle: "dashed",
  },
  noteContent: {
    flex: 1,
  },
  noteLine: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  noteText: {
    color: "#333",
  },
  bold: {
    fontWeight: "700",
  },
  italic: {
    fontStyle: "italic",
  },
  link: {
    color: "#2563eb",
    textDecorationLine: "underline",
  },
  anchorBadge: {
    position: "absolute",
    top: -4,
    left: -4,
  },
  deleteBtn: {
    marginTop: -2,
  },
  inputContainer: {
    position: "absolute",
    backgroundColor: "#FFF9C4",
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#2563eb",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
    padding: 6,
    width: 220,
  },
  input: {
    minHeight: 60,
    paddingHorizontal: 6,
    paddingVertical: 6,
    fontSize: 14,
  },
  colorRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  colorSwatch: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorSwatchActive: {
    borderColor: "#2563eb",
  },
  sizeRow: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 4,
    paddingTop: 6,
  },
  sizeBtn: {
    width: 28,
    height: 24,
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#D1D1D6",
  },
  sizeBtnActive: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  sizeBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#333",
  },
  sizeBtnTextActive: {
    color: "#fff",
  },
  editorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    paddingTop: 6,
  },
  editorActionBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#D1D1D6",
  },
  editorSubmitBtn: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
});
