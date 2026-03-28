import React, { useRef, useEffect } from "react";
import { View, StyleSheet, PanResponder, Dimensions } from "react-native";
import Svg, { Path } from "react-native-svg";
import { DrawPath } from "../types";

interface DrawingCanvasProps {
  paths: DrawPath[];
  currentPath: { x: number; y: number }[] | null;
  color: string;
  strokeWidth: number;
  tool: "pen" | "eraser";
  onStrokeStart: () => void;
  onStrokeMove: (point: { x: number; y: number }) => void;
  onStrokeEnd: () => void;
  onCanvasTap: (point: { x: number; y: number }) => void;
  disabled?: boolean;
}

function pointsToSvgPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    // Single point — draw a tiny line so it's visible
    return `M ${points[0].x} ${points[0].y} L ${points[0].x + 0.5} ${points[0].y + 0.5}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x} ${points[i].y}`;
  }
  return d;
}

// Simple point simplification: skip points that are very close together
function simplifyPoints(
  points: { x: number; y: number }[],
  tolerance: number = 2
): { x: number; y: number }[] {
  if (points.length <= 2) return points;
  const result = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const dx = points[i].x - prev.x;
    const dy = points[i].y - prev.y;
    if (dx * dx + dy * dy >= tolerance * tolerance) {
      result.push(points[i]);
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

export default function DrawingCanvas({
  paths,
  currentPath,
  color,
  strokeWidth,
  tool,
  onStrokeStart,
  onStrokeMove,
  onStrokeEnd,
  onCanvasTap,
  disabled = false,
}: DrawingCanvasProps) {
  const isMoveRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  // Refs so the PanResponder (created once) always calls the latest callbacks
  const disabledRef = useRef(disabled);
  const onStrokeStartRef = useRef(onStrokeStart);
  const onStrokeMoveRef = useRef(onStrokeMove);
  const onStrokeEndRef = useRef(onStrokeEnd);
  const onCanvasTapRef = useRef(onCanvasTap);
  useEffect(() => {
    disabledRef.current = disabled;
    onStrokeStartRef.current = onStrokeStart;
    onStrokeMoveRef.current = onStrokeMove;
    onStrokeEndRef.current = onStrokeEnd;
    onCanvasTapRef.current = onCanvasTap;
  });

  const panResponder = useRef(
    PanResponder.create({
      // Always claim the initial touch so taps reach onCanvasTap even in text mode
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => !disabledRef.current,
      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        isMoveRef.current = false;
        startRef.current = { x: locationX, y: locationY };
        if (!disabledRef.current) {
          onStrokeStartRef.current();
          onStrokeMoveRef.current({ x: locationX, y: locationY });
        }
      },
      onPanResponderMove: (evt) => {
        if (disabledRef.current) return;
        isMoveRef.current = true;
        const { locationX, locationY } = evt.nativeEvent;
        onStrokeMoveRef.current({ x: locationX, y: locationY });
      },
      onPanResponderRelease: () => {
        if (!isMoveRef.current && startRef.current) {
          // It was a tap, not a drag
          onCanvasTapRef.current(startRef.current);
        }
        if (!disabledRef.current) {
          onStrokeEndRef.current();
        }
      },
    })
  ).current;

  const { width, height } = Dimensions.get("window");

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        {/* Render saved paths */}
        {paths.map((p) => {
          const simplified = simplifyPoints(p.points);
          const d = pointsToSvgPath(simplified);
          if (!d) return null;
          return (
            <Path
              key={p.id}
              d={d}
              stroke={p.tool === "eraser" ? "#FFFFFF" : p.color}
              strokeWidth={p.tool === "eraser" ? p.strokeWidth + 10 : p.strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
        {/* Render current in-progress path */}
        {currentPath && currentPath.length > 0 && (
          <Path
            d={pointsToSvgPath(currentPath)}
            stroke={tool === "eraser" ? "#FFFFFF" : color}
            strokeWidth={tool === "eraser" ? strokeWidth + 10 : strokeWidth}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
});
