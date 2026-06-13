import React, { useEffect, useRef } from "react";
import { View, StyleSheet, TouchableOpacity, Platform, PanResponder } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Bounds } from "../lib/viewport";

const HANDLE_SIZE = 14;
const ROTATE_OFFSET = 30; // screen px above the top edge

/** Resize handles (8) + the rotate handle. */
export type HandleId = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r" | "rotate";

interface SelectionOverlayProps {
  /** Board-space bounding box — the union box when multiple elements are selected. */
  bounds: Bounds;
  /** Current viewport zoom — chrome is counter-scaled to a constant screen size. */
  scale: number;
  /** Live rotate preview (degrees); spins the whole box+handles about its center. */
  rotation?: number;
  /** Number of selected elements; reserved for future per-count chrome. */
  count?: number;
  /** Hide the action bar while a transform drag is in flight. */
  showActions?: boolean;
  onDelete?: () => void;
  onDuplicate?: () => void;
  onBringToFront?: () => void;
  onSendToBack?: () => void;
  // Phase 8 Pass 2 — a resize/rotate handle drag. Deltas are board-space
  // (screen px ÷ zoom); the screen converts them via its own `scale`.
  onTransformStart?: (handle: HandleId) => void;
  onTransformMove?: (handle: HandleId, dxBoard: number, dyBoard: number) => void;
  onTransformEnd?: () => void;
}

const ACTION_ICON = 15;

/**
 * Group selection chrome (Phase 8): the union bounding box, an 8-handle resize
 * frame + a rotate handle (Pass 2), and a counter-scaled action bar
 * (duplicate / z-order / delete). Rendered inside the canvas overlay (which
 * applies the viewport transform), so the box is positioned in board-space and
 * only the chrome thickness is counter-scaled. Handle drags report board-space
 * deltas; the board screen turns them into a scale/rotate transform.
 */
export default function SelectionOverlay({
  bounds,
  scale,
  rotation = 0,
  count = 1,
  showActions = true,
  onDelete,
  onDuplicate,
  onBringToFront,
  onSendToBack,
  onTransformStart,
  onTransformMove,
  onTransformEnd,
}: SelectionOverlayProps) {
  const inv = 1 / (scale || 1);
  const handle = HANDLE_SIZE * inv;
  const half = handle / 2;
  const left = bounds.minX;
  const top = bounds.minY;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);

  // Stable refs so the once-created PanResponders always see the latest scale +
  // callbacks (mirrors TextElementView's pattern).
  const scaleRef = useRef(scale);
  const cbRef = useRef({ onTransformStart, onTransformMove, onTransformEnd });
  useEffect(() => {
    scaleRef.current = scale;
  });
  useEffect(() => {
    cbRef.current = { onTransformStart, onTransformMove, onTransformEnd };
  });

  // One PanResponder per handle, created once. gestureState.dx/dy are screen px;
  // divide by the live zoom to get board-space deltas.
  const makeResponder = (h: HandleId) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => cbRef.current.onTransformStart?.(h),
      onPanResponderMove: (_e, g) => {
        const s = scaleRef.current || 1;
        cbRef.current.onTransformMove?.(h, g.dx / s, g.dy / s);
      },
      onPanResponderRelease: () => cbRef.current.onTransformEnd?.(),
      onPanResponderTerminate: () => cbRef.current.onTransformEnd?.(),
    });
  const responders = useRef<Record<HandleId, ReturnType<typeof PanResponder.create>>>({
    tl: makeResponder("tl"),
    tr: makeResponder("tr"),
    bl: makeResponder("bl"),
    br: makeResponder("br"),
    t: makeResponder("t"),
    b: makeResponder("b"),
    l: makeResponder("l"),
    r: makeResponder("r"),
    rotate: makeResponder("rotate"),
  }).current;

  const handleStyle = {
    width: handle,
    height: handle,
    borderRadius: 3 * inv,
    borderWidth: 2 * inv,
  };
  // Resize handles at corners + edge midpoints (board-space offsets in the box).
  const resizeHandles: { id: HandleId; x: number; y: number }[] = [
    { id: "tl", x: 0, y: 0 },
    { id: "tr", x: width, y: 0 },
    { id: "bl", x: 0, y: height },
    { id: "br", x: width, y: height },
    { id: "t", x: width / 2, y: 0 },
    { id: "b", x: width / 2, y: height },
    { id: "l", x: 0, y: height / 2 },
    { id: "r", x: width, y: height / 2 },
  ];

  const btn = (
    key: string,
    icon: keyof typeof Ionicons.glyphMap,
    onPress?: () => void,
    danger = false
  ) =>
    onPress ? (
      <TouchableOpacity
        key={key}
        style={[
          styles.actionBtn,
          { width: 26 * inv, height: 26 * inv, borderRadius: 13 * inv },
          danger && styles.actionBtnDanger,
        ]}
        onPress={onPress}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name={icon} size={ACTION_ICON * inv} color={danger ? "#fff" : "#2563eb"} />
      </TouchableOpacity>
    ) : null;

  return (
    <View
      style={[
        styles.container,
        { left, top, width, height },
        rotation ? { transform: [{ rotate: `${rotation}deg` }], transformOrigin: "50% 50%" } : null,
      ]}
      pointerEvents="box-none"
    >
      <View style={[styles.border, { borderWidth: 1.5 * inv }]} pointerEvents="none" />

      {/* Rotate handle + its stem, above the top edge center. */}
      {onTransformMove && (
        <>
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: width / 2 - 0.75 * inv,
              top: -ROTATE_OFFSET * inv,
              width: 1.5 * inv,
              height: ROTATE_OFFSET * inv,
              backgroundColor: "#2563eb",
            }}
          />
          <View
            {...responders.rotate.panHandlers}
            style={[
              styles.rotateHandle,
              {
                width: handle,
                height: handle,
                borderRadius: handle / 2,
                borderWidth: 2 * inv,
                left: width / 2 - half,
                top: -(ROTATE_OFFSET * inv) - half,
              },
            ]}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          />
        </>
      )}

      {/* 8 resize handles (interactive when a transform handler is wired). */}
      {resizeHandles.map((h) => {
        const common = {
          key: h.id,
          style: [styles.handle, handleStyle, { left: h.x - half, top: h.y - half }],
        };
        return onTransformMove ? (
          <View
            {...common}
            {...responders[h.id].panHandlers}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          />
        ) : (
          <View {...common} pointerEvents="none" />
        );
      })}

      {/* Action bar, anchored just above the top edge (hidden during a drag). */}
      {showActions && (
        <View
          style={[
            styles.actionBar,
            {
              top: -(40 * inv),
              right: 0,
              gap: 6 * inv,
              paddingHorizontal: 4 * inv,
              paddingVertical: 3 * inv,
              borderRadius: 16 * inv,
            },
          ]}
        >
          {btn("dup", "copy-outline", onDuplicate)}
          {btn("front", "arrow-up-outline", onBringToFront)}
          {btn("back", "arrow-down-outline", onSendToBack)}
          {btn("del", "trash-outline", onDelete, true)}
        </View>
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
    ...(Platform.OS === "web" ? { cursor: "pointer" as any } : {}),
  },
  rotateHandle: {
    position: "absolute",
    backgroundColor: "#fff",
    borderColor: "#2563eb",
    ...(Platform.OS === "web" ? { cursor: "grab" as any } : {}),
  },
  actionBar: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#cbd5e1",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  actionBtn: {
    justifyContent: "center",
    alignItems: "center",
    ...(Platform.OS === "web" ? { cursor: "pointer" as any } : {}),
  },
  actionBtnDanger: {
    backgroundColor: "#ef4444",
  },
});
