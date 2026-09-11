import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ArrowheadStyle, ShapeKind } from "../types";

interface ShapeOptionsBarProps {
  activeKind: ShapeKind;
  onSelectKind: (kind: ShapeKind) => void;
  fillEnabled: boolean;
  onToggleFill: () => void;
  dashed: boolean;
  onToggleDashed: () => void;
  /** Snap grid size in board units; 0 = off. */
  snapGrid: number;
  onCycleSnap: () => void;
  arrowheadEnd: ArrowheadStyle;
  onCycleArrowhead: () => void;
  /** Month 5 (ROADMAP item 12) — the eyedropper is tool-agnostic (it just
   *  sets `tools.activeColor`, which the shape draft already reads), so this
   *  bar gets the same toggle `PenOptionsBar` does rather than duplicating
   *  any picking logic of its own. See `BoardCanvas.tsx`'s eyedropper wiring. */
  eyedropperArmed: boolean;
  onToggleEyedropper: () => void;
}

const KINDS: { kind: ShapeKind; icon: keyof typeof Ionicons.glyphMap }[] = [
  { kind: "rect", icon: "square-outline" },
  { kind: "ellipse", icon: "ellipse-outline" },
  { kind: "line", icon: "remove-outline" },
  { kind: "arrow", icon: "arrow-forward-outline" },
  { kind: "triangle", icon: "triangle-outline" },
];

const ARROWHEAD_LABEL: Record<ArrowheadStyle, string> = {
  none: "None",
  classic: "Arrow",
  dot: "Dot",
  circle: "Circle",
  open: "Open",
};

/**
 * Contextual style row for the shape tool (Phase 7). Only mounted while the shape
 * tool is active. Stroke color / width are shared with the main Toolbar; this bar
 * owns shape-specific options: primitive, fill, dash, snap-to-grid, and (for
 * arrows) the arrowhead style.
 */
export default function ShapeOptionsBar({
  activeKind,
  onSelectKind,
  fillEnabled,
  onToggleFill,
  dashed,
  onToggleDashed,
  snapGrid,
  onCycleSnap,
  arrowheadEnd,
  onCycleArrowhead,
  eyedropperArmed,
  onToggleEyedropper,
}: ShapeOptionsBarProps) {
  const isArrow = activeKind === "arrow";
  const fillable = activeKind === "rect" || activeKind === "ellipse" || activeKind === "triangle";

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.group}>
          {KINDS.map(({ kind, icon }) => (
            <TouchableOpacity
              key={kind}
              style={[styles.iconBtn, activeKind === kind && styles.iconBtnActive]}
              onPress={() => onSelectKind(kind)}
              accessibilityRole="button"
              accessibilityLabel={`Shape: ${kind}`}
            >
              <Ionicons name={icon} size={18} color={activeKind === kind ? "#fff" : "#333"} />
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.divider} />

        <View style={styles.group}>
          {fillable && (
            <Pill active={fillEnabled} icon="color-fill-outline" label="Fill" onPress={onToggleFill} />
          )}
          <Pill active={dashed} icon="ellipsis-horizontal" label="Dash" onPress={onToggleDashed} />
          <Pill
            active={snapGrid > 0}
            icon="grid-outline"
            label={snapGrid > 0 ? `${snapGrid}px` : "Snap"}
            onPress={onCycleSnap}
          />
          {isArrow && (
            <Pill
              active={arrowheadEnd !== "none"}
              icon="navigate-outline"
              label={ARROWHEAD_LABEL[arrowheadEnd]}
              onPress={onCycleArrowhead}
            />
          )}
          <Pill
            active={eyedropperArmed}
            icon="water-outline"
            label={eyedropperArmed ? "Picking…" : "Eyedropper"}
            onPress={onToggleEyedropper}
            testID="shape-options-eyedropper-pill"
          />
        </View>
      </ScrollView>
    </View>
  );
}

function Pill({
  active,
  icon,
  label,
  onPress,
  testID,
}: {
  active: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.pill, active && styles.pillActive]}
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={14} color={active ? "#fff" : "#333"} />
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 92,
    left: 10,
    right: 10,
    backgroundColor: "#F2F2F7",
    borderRadius: 14,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 4,
  },
  scrollContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  divider: {
    width: 1,
    height: 24,
    backgroundColor: "#C7C7CC",
    marginHorizontal: 8,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 9,
    justifyContent: "center",
    alignItems: "center",
  },
  iconBtnActive: {
    backgroundColor: "#2563eb",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#D1D1D6",
  },
  pillActive: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  pillText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#333",
  },
  pillTextActive: {
    color: "#fff",
  },
});
