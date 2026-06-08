import React from "react";
import { View, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Bounds } from "../lib/viewport";

const HANDLE_SIZE = 14;

interface SelectionOverlayProps {
  /** Board-space bounding box of the selected element. */
  bounds: Bounds;
  /** Current viewport zoom — border/handles are counter-scaled to stay a
   *  constant screen size regardless of how far the board is zoomed. */
  scale: number;
  /** Trash affordance (mobile); web also wires Delete/Backspace at the screen. */
  onDelete?: () => void;
}

/**
 * Bounding box + corner handles for a single selected stroke. Rendered inside
 * the canvas overlay (which already applies the viewport transform), so the
 * box is positioned in board-space; only the chrome thickness is counter-scaled.
 */
export default function SelectionOverlay({ bounds, scale, onDelete }: SelectionOverlayProps) {
  const inv = 1 / (scale || 1);
  const handle = HANDLE_SIZE * inv;
  const half = handle / 2;
  const left = bounds.minX;
  const top = bounds.minY;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);

  const handleStyle = {
    width: handle,
    height: handle,
    borderRadius: half,
    borderWidth: 2 * inv,
  };

  return (
    <View
      style={[styles.container, { left, top, width, height }]}
      pointerEvents="box-none"
    >
      <View
        style={[styles.border, { borderWidth: 1.5 * inv }]}
        pointerEvents="none"
      />
      {/* Corner handles (decorative in M1; resize/move lands in M2). */}
      <View style={[styles.handle, handleStyle, { top: -half, left: -half }]} pointerEvents="none" />
      <View style={[styles.handle, handleStyle, { top: -half, right: -half }]} pointerEvents="none" />
      <View style={[styles.handle, handleStyle, { bottom: -half, left: -half }]} pointerEvents="none" />
      <View style={[styles.handle, handleStyle, { bottom: -half, right: -half }]} pointerEvents="none" />
      {onDelete && (
        <TouchableOpacity
          style={[
            styles.deleteBtn,
            {
              width: 22 * inv,
              height: 22 * inv,
              borderRadius: 11 * inv,
              top: -(28 * inv),
              right: -(8 * inv),
            },
          ]}
          onPress={onDelete}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="trash-outline" size={13 * inv} color="#fff" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
  },
  border: {
    ...StyleSheet.absoluteFillObject,
    borderColor: "#2563eb",
    borderStyle: "dashed",
    borderRadius: 2,
  },
  handle: {
    position: "absolute",
    backgroundColor: "#fff",
    borderColor: "#2563eb",
  },
  deleteBtn: {
    position: "absolute",
    backgroundColor: "#ef4444",
    justifyContent: "center",
    alignItems: "center",
    ...(Platform.OS === "web" ? { cursor: "pointer" as any } : {}),
  },
});
