import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { ReactionEmoji } from "../../types";
import type { ReactionCount } from "../../hooks/useBoardReactions";

// Base (scale: 1) dimensions — see the `scale` prop's comment, same
// counter-scale technique as AudioAffordance/CommentPinLayer.
const BASE_PILL_HEIGHT = 22;
const BASE_FONT_SIZE = 13;
const BASE_GAP = 4;

export interface ReactionBadgeProps {
  /** All 5 emoji, zero-count entries included — from
   *  useBoardReactions.countsFor. */
  counts: ReactionCount[];
  /** Whether the viewer may add/remove a reaction (commenter+, mirrors
   *  firestore.rules' `reactions` match). A viewer still sees existing
   *  counts; tapping is disabled for them. */
  canReact: boolean;
  onToggle: (emoji: ReactionEmoji) => void;
  /** Counter-scale factor (typically `1 / viewport.scale`, from the caller)
   *  so the badge holds a constant on-screen size through zoom — same
   *  technique CommentPinLayer/AudioAffordance use, applied to this
   *  component's own dimensions (never a wrapping `transform: scale`, which
   *  is center-origin in RN and drifts the badge off its board-space
   *  position at any zoom != 1). Defaults to 1. */
  scale?: number;
}

/**
 * Month 6 — the reaction row anchored to a board element's corner (👍 ❤️ ❓ ⭐
 * 💡). Rendered once per element that either already has a reaction or is the
 * lone current selection (BoardCanvas.tsx decides which) — this component
 * itself just renders what it's given, like every other overlay badge.
 *
 * Two states, chosen by the data rather than a prop (mirrors AudioAffordance's
 * own `audio: AudioElement | null` split):
 *  - at least one reaction exists: shows only the non-zero emoji pills, each
 *    tappable (if `canReact`) to toggle the viewer's OWN reaction; a
 *    trailing +/- pill reveals the rest of the 5 to start a new kind.
 *  - none exist yet: a viewer who can't react sees nothing at all (this
 *    component renders null); a commenter+ sees one small "start reacting"
 *    affordance that expands into the full row on tap.
 */
export default function ReactionBadge({ counts, canReact, onToggle, scale = 1 }: ReactionBadgeProps) {
  const [expanded, setExpanded] = useState(false);
  const hasAny = counts.some((c) => c.count > 0);

  if (!hasAny && !canReact) return null;

  const visible = expanded ? counts : counts.filter((c) => c.count > 0);
  const pillHeight = BASE_PILL_HEIGHT * scale;
  const fontSize = BASE_FONT_SIZE * scale;

  if (visible.length === 0) {
    // hasAny is false here (otherwise `visible` would be non-empty) and
    // canReact is true (otherwise we already returned null above) — the
    // empty-state "start reacting" affordance.
    return (
      <TouchableOpacity
        testID="reaction-badge-start"
        accessibilityRole="button"
        accessibilityLabel="Add a reaction"
        onPress={() => setExpanded(true)}
        style={[styles.pill, styles.startPill, { height: pillHeight, paddingHorizontal: 8 * scale }]}
      >
        <Text style={[styles.emoji, { fontSize }]}>+ 🙂</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.row, { gap: BASE_GAP * scale }]} pointerEvents="box-none">
      {visible.map((c) => (
        <TouchableOpacity
          key={c.emoji}
          testID={`reaction-pill-${c.emoji}`}
          accessibilityRole="button"
          accessibilityLabel={`${c.emoji} reaction${c.count > 0 ? `, ${c.count}` : ""}${
            c.reactedByMe ? ", you reacted" : ""
          }`}
          disabled={!canReact}
          onPress={() => onToggle(c.emoji)}
          style={[
            styles.pill,
            { height: pillHeight, paddingHorizontal: 6 * scale },
            c.reactedByMe && styles.pillActive,
          ]}
        >
          <Text style={[styles.emoji, { fontSize }]}>{c.emoji}</Text>
          {c.count > 0 && <Text style={[styles.count, { fontSize: fontSize * 0.85 }]}>{c.count}</Text>}
        </TouchableOpacity>
      ))}
      {canReact && (
        <TouchableOpacity
          testID="reaction-badge-toggle-expand"
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Show fewer reaction options" : "Show more reaction options"}
          onPress={() => setExpanded((e) => !e)}
          style={[styles.pill, styles.expandPill, { height: pillHeight, width: pillHeight }]}
        >
          <Text style={[styles.emoji, { fontSize }]}>{expanded ? "−" : "+"}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  startPill: {
    backgroundColor: "#f3f4f6",
  },
  pillActive: {
    backgroundColor: "#dbeafe",
    borderColor: "#2563eb",
  },
  expandPill: {
    backgroundColor: "#f3f4f6",
  },
  emoji: {
    color: "#111827",
  },
  count: {
    marginLeft: 2,
    color: "#374151",
    fontWeight: "600",
  },
});
