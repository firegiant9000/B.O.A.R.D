import React, { useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  LayoutChangeEvent,
  GestureResponderEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { valueFromPosition, positionFromValue } from "../lib/sliderMath";

/**
 * Stroke-width picker (ROADMAP item 12 — "6 stroke widths (was 3) plus a
 * continuous width slider"). The 6 presets mirror `Toolbar.tsx`'s own quick-
 * access row (same values, so tapping either lands on the exact same
 * width); this modal adds the continuous slider Toolbar's compact row has
 * no room for.
 *
 * The slider uses RN's plain Responder System props directly
 * (`onStartShouldSetResponder`/`onResponderGrant`/`onResponderMove`) rather
 * than `PanResponder`: this is a 1D "where did they touch" drag with no
 * velocity/multi-touch tracking to justify PanResponder's gesture-state
 * bookkeeping (which needs a full native `touchHistory` on every event —
 * not exercisable via RNTL's `fireEvent`, and not needed here). A bare
 * inline handler is also recreated fresh every render, so it always closes
 * over the current `trackWidth` — no `useRef`-memoized handler to go stale
 * against a `trackWidth` that only settles after `onLayout` fires once.
 */

export const STROKE_WIDTH_PRESETS: { label: string; value: number }[] = [
  { label: "XS", value: 1 },
  { label: "S", value: 2 },
  { label: "M", value: 5 },
  { label: "L", value: 10 },
  { label: "XL", value: 16 },
  { label: "XXL", value: 24 },
];

const MIN_WIDTH = 1;
const MAX_WIDTH = 30;
const TRACK_HEIGHT = 28;

export interface StrokeWidthModalProps {
  visible: boolean;
  onClose: () => void;
  strokeWidth: number;
  onChange: (width: number) => void;
}

export default function StrokeWidthModal({ visible, onClose, strokeWidth, onChange }: StrokeWidthModalProps) {
  const [trackWidth, setTrackWidth] = useState(1);
  const onTrackLayout = (e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width);

  const updateFromX = (x: number) => {
    onChange(Math.round(valueFromPosition(x, trackWidth, MIN_WIDTH, MAX_WIDTH)));
  };
  const onTouch = (e: GestureResponderEvent) => updateFromX(e.nativeEvent.locationX);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Stroke width</Text>
            <TouchableOpacity
              testID="stroke-width-close"
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close stroke width picker"
            >
              <Ionicons name="close" size={20} color="#6b7280" />
            </TouchableOpacity>
          </View>

          <View style={styles.presetRow}>
            {STROKE_WIDTH_PRESETS.map(({ label, value }) => {
              const active = strokeWidth === value;
              return (
                <TouchableOpacity
                  key={value}
                  testID={`stroke-width-preset-${value}`}
                  style={[styles.presetBtn, active && styles.presetBtnActive]}
                  onPress={() => onChange(value)}
                  accessibilityRole="button"
                  accessibilityLabel={`Stroke width ${label}, ${value} points`}
                >
                  <View
                    style={[
                      styles.presetDot,
                      {
                        width: Math.min(value, 20),
                        height: Math.min(value, 20),
                        borderRadius: Math.min(value, 20) / 2,
                        backgroundColor: active ? "#fff" : "#333",
                      },
                    ]}
                  />
                  <Text style={[styles.presetLabel, active && styles.presetLabelActive]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.sectionLabel}>Custom: {strokeWidth}px</Text>
          <View
            testID="stroke-width-slider-track"
            style={styles.track}
            onLayout={onTrackLayout}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={onTouch}
            onResponderMove={onTouch}
          >
            <View
              testID="stroke-width-slider-thumb"
              style={[
                styles.thumb,
                { left: positionFromValue(strokeWidth, trackWidth, MIN_WIDTH, MAX_WIDTH) - 8 },
              ]}
            />
          </View>

          <TouchableOpacity testID="stroke-width-done" style={styles.doneButton} onPress={onClose} accessibilityRole="button">
            <Text style={styles.doneButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(17, 24, 39, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
  },
  presetRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  presetBtn: {
    width: 48,
    height: 56,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#D1D1D6",
    justifyContent: "center",
    alignItems: "center",
    gap: 4,
  },
  presetBtnActive: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  presetDot: {},
  presetLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#333",
  },
  presetLabelActive: {
    color: "#fff",
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6b7280",
    marginBottom: 6,
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: "#e5e7eb",
    justifyContent: "center",
    marginBottom: 10,
  },
  thumb: {
    position: "absolute",
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#2563eb",
  },
  doneButton: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 8,
  },
  doneButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
});
