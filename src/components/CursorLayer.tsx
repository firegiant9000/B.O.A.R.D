import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Viewport, boardToScreen } from "../lib/viewport";
import { CursorPresence } from "../types";
import { userColor } from "../lib/userColor";
import * as cursorService from "../services/cursorService";

/**
 * Live-cursor overlay (Month 4, Phase 6). A separate, non-interactive top layer
 * that subscribes to the cursor side channel itself — so remote cursor updates
 * re-render only this component, never the element tree (Appendix A.4 hard rule).
 * Cursors are drawn in screen space (converted from board space through the
 * viewport) so labels stay a constant size at any zoom.
 */

// ~12Hz repaint ceiling. Snapshot bursts are coalesced to this, latest-wins.
const RENDER_INTERVAL_MS = 80;

interface CursorLayerProps {
  boardId: string;
  viewport: Viewport;
  selfId?: string;
  blockedIds: string[];
}

export default function CursorLayer({
  boardId,
  viewport,
  selfId,
  blockedIds,
}: CursorLayerProps) {
  const [cursors, setCursors] = useState<CursorPresence[]>([]);
  // Coalesce a flurry of remote updates to RENDER_INTERVAL_MS: stash the latest
  // snapshot on the ref and flush it on a single trailing timer.
  const latestRef = useRef<CursorPresence[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!boardId) return;
    const unsub = cursorService.subscribeToCursors(boardId, (incoming) => {
      latestRef.current = incoming;
      if (timerRef.current) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCursors(latestRef.current);
      }, RENDER_INTERVAL_MS);
    });
    return () => {
      unsub();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [boardId]);

  const visible = cursorService.visibleCursors(
    cursors,
    selfId,
    blockedIds,
    Date.now()
  );
  if (visible.length === 0) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {visible.map((c) => {
        const p = boardToScreen(viewport, { x: c.x, y: c.y });
        const color = userColor(c.userId);
        return (
          <View
            key={c.userId}
            style={[styles.cursor, { transform: [{ translateX: p.x }, { translateY: p.y }] }]}
          >
            <Svg width={20} height={20} viewBox="0 0 20 20">
              {/* Classic arrow pointer. */}
              <Path
                d="M3 2 L3 15 L7 11 L10 17 L12.5 16 L9.5 10 L15 10 Z"
                fill={color}
                stroke="#ffffff"
                strokeWidth={1.2}
              />
            </Svg>
            <View style={[styles.label, { backgroundColor: color }]}>
              <Text style={styles.labelText} numberOfLines={1}>
                {c.displayName}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  cursor: {
    position: "absolute",
    top: 0,
    left: 0,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  label: {
    marginLeft: 2,
    marginTop: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    maxWidth: 120,
  },
  labelText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "600",
  },
});
