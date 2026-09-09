import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Viewport, boardToScreen } from "../../lib/viewport";
import type { RecognizedShape } from "../../lib/shapeRecognition";

/**
 * Phase 9 — the "perfect it?" prompt (ask mode). Extracted verbatim from
 * `app/board/[id].tsx` (Month 5/6 Task 1).
 *
 * Anchored in screen-space just above the recognized stroke; accepting swaps it
 * for a clean primitive, dismissing leaves the freehand stroke as-is.
 */

interface PerfectShapePromptProps {
  viewport: Viewport;
  /** The recognized primitive awaiting confirmation, or null to render nothing. */
  shape: RecognizedShape | null;
  onAccept: () => void;
  onDismiss: () => void;
}

export default function PerfectShapePrompt({
  viewport,
  shape,
  onAccept,
  onDismiss,
}: PerfectShapePromptProps) {
  if (!shape) return null;
  const anchor = boardToScreen(viewport, {
    x: shape.x + shape.width / 2,
    y: Math.min(shape.y, shape.y + shape.height),
  });
  return (
    <View
      style={[styles.perfectPrompt, { left: anchor.x - 70, top: anchor.y - 52 }]}
      pointerEvents="box-none"
    >
      <Ionicons name="sparkles-outline" size={15} color="#2563eb" />
      <Text style={styles.perfectPromptText}>Perfect it?</Text>
      <TouchableOpacity style={styles.perfectAccept} onPress={onAccept}>
        <Ionicons name="checkmark" size={16} color="#fff" />
      </TouchableOpacity>
      <TouchableOpacity style={styles.perfectDismiss} onPress={onDismiss}>
        <Ionicons name="close" size={16} color="#6b7280" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  perfectPrompt: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    paddingVertical: 5,
    paddingLeft: 10,
    paddingRight: 5,
    borderRadius: 20,
    zIndex: 130,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 5,
  },
  perfectPromptText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#111827",
  },
  perfectAccept: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
  },
  perfectDismiss: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#f3f4f6",
    justifyContent: "center",
    alignItems: "center",
  },
});
