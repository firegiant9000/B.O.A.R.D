import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ShapeRecognitionMode } from "../types";
import { PenStyle, PEN_STYLES } from "../lib/penStyles";

interface PenOptionsBarProps {
  mode: ShapeRecognitionMode;
  onCycleMode: () => void;

  // Month 5 — colour + stroke polish (ROADMAP item 12)
  activePenStyle: PenStyle;
  onSelectPenStyle: (style: PenStyle) => void;
  activeColor: string;
  onOpenColorPicker: () => void;
  activeStrokeWidth: number;
  onOpenWidthPicker: () => void;
  /** True while the eyedropper is armed — the next canvas tap samples a
   *  colour instead of drawing (see `BoardCanvas.tsx`'s `handleCanvasTap`). */
  eyedropperArmed: boolean;
  onToggleEyedropper: () => void;
}

const MODE_LABEL: Record<ShapeRecognitionMode, string> = {
  always: "Always",
  ask: "Ask",
  never: "Off",
};

const PEN_STYLE_ICON: Record<PenStyle, keyof typeof Ionicons.glyphMap> = {
  pen: "pencil-outline",
  highlighter: "color-fill-outline",
  marker: "brush-outline",
  calligraphy: "create-outline",
};

const PEN_STYLE_LABEL: Record<PenStyle, string> = {
  pen: "Pen",
  highlighter: "Highlighter",
  marker: "Marker",
  calligraphy: "Calligraphy",
};

/**
 * Contextual style row for the pen tool (Phase 9; Month 5 — ROADMAP item 12
 * added the variant/colour/width/eyedropper pills). Only mounted while the
 * pen tool is active.
 *
 * Owns:
 *  - the pen-variant selector (pen/highlighter/marker/calligraphy — see
 *    `src/lib/penStyles.ts`);
 *  - the entry points into the two Month 5 picker modals (`ColorPickerModal`,
 *    `StrokeWidthModal`), rendered by `BoardModals.tsx` — this bar only shows
 *    a live preview swatch/width and opens them, it renders neither itself;
 *  - the eyedropper toggle (`src/lib/hitTest.ts` via `BoardCanvas.tsx`'s
 *    `elements.hitTestAny`/`colorOfElement` — this bar has no picking logic
 *    of its own, it only arms/disarms it);
 *  - the auto-perfect ("perfect shapes") pill: cycles the per-user mode
 *    Ask → Always → Off, persisted to the user doc via shapeRecognitionService.
 */
export default function PenOptionsBar({
  mode,
  onCycleMode,
  activePenStyle,
  onSelectPenStyle,
  activeColor,
  onOpenColorPicker,
  activeStrokeWidth,
  onOpenWidthPicker,
  eyedropperArmed,
  onToggleEyedropper,
}: PenOptionsBarProps) {
  const perfectActive = mode !== "never";
  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.group}>
          {PEN_STYLES.map((style) => (
            <TouchableOpacity
              key={style}
              style={[styles.iconBtn, activePenStyle === style && styles.iconBtnActive]}
              onPress={() => onSelectPenStyle(style)}
              accessibilityRole="button"
              accessibilityLabel={`Pen style: ${PEN_STYLE_LABEL[style]}`}
            >
              <Ionicons
                name={PEN_STYLE_ICON[style]}
                size={18}
                color={activePenStyle === style ? "#fff" : "#333"}
              />
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.divider} />

        <View style={styles.group}>
          <TouchableOpacity
            testID="pen-options-color-pill"
            style={styles.pill}
            onPress={onOpenColorPicker}
            accessibilityRole="button"
            accessibilityLabel="Open the colour picker"
          >
            <View style={[styles.colorSwatch, { backgroundColor: activeColor }]} />
            <Text style={styles.pillText}>Colour</Text>
          </TouchableOpacity>

          <TouchableOpacity
            testID="pen-options-width-pill"
            style={styles.pill}
            onPress={onOpenWidthPicker}
            accessibilityRole="button"
            accessibilityLabel="Open the stroke width picker"
          >
            <Ionicons name="options-outline" size={14} color="#333" />
            <Text style={styles.pillText}>Width: {activeStrokeWidth}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            testID="pen-options-eyedropper-pill"
            style={[styles.pill, eyedropperArmed && styles.pillActive]}
            onPress={onToggleEyedropper}
            accessibilityRole="button"
            accessibilityLabel={eyedropperArmed ? "Cancel colour picking" : "Pick a colour from the canvas"}
          >
            <Ionicons name="water-outline" size={14} color={eyedropperArmed ? "#fff" : "#333"} />
            <Text style={[styles.pillText, eyedropperArmed && styles.pillTextActive]}>
              {eyedropperArmed ? "Picking…" : "Eyedropper"}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.divider} />

        <TouchableOpacity
          style={[styles.pill, perfectActive && styles.pillActive]}
          onPress={onCycleMode}
          accessibilityRole="button"
          accessibilityLabel={`Perfect shapes: ${MODE_LABEL[mode]}`}
        >
          <Ionicons
            name="shapes-outline"
            size={14}
            color={perfectActive ? "#fff" : "#333"}
          />
          <Text style={[styles.pillText, perfectActive && styles.pillTextActive]}>
            Perfect: {MODE_LABEL[mode]}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
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
    gap: 4,
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
    marginHorizontal: 4,
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
  colorSwatch: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.15)",
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
