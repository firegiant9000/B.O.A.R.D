import React, { useRef, useMemo, useEffect, useCallback } from "react";
import { View, StyleSheet, Dimensions, Platform } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Path, G } from "react-native-svg";
import { DrawPath } from "../types";
import { Viewport, Point, screenToBoard } from "../lib/viewport";

interface DrawingCanvasProps {
  paths: DrawPath[];
  /** In-progress stroke, in board-space. */
  currentPath: Point[] | null;
  color: string;
  strokeWidth: number;
  tool: "pen" | "eraser";
  viewport: Viewport;
  /** When false, only drawing is active (pan/zoom disabled) — the rollback path. */
  enablePanZoom: boolean;
  /** Canvas size in screen px; falls back to the window when omitted. */
  width?: number;
  height?: number;
  onStrokeStart: () => void;
  /** Receives the moved point already converted to board-space. */
  onStrokeMove: (point: Point) => void;
  onStrokeEnd: () => void;
  /** A stationary tap, in board-space (text placement / dot). */
  onTap: (point: Point) => void;
  onPanBy: (dx: number, dy: number) => void;
  onZoomAtPoint: (factor: number, focal: Point) => void;
  onFling: (vx: number, vy: number) => void;
  /** Called on any touch-down so the parent can cancel in-flight inertia. */
  onGestureStart: () => void;
  disabled?: boolean;
}

function pointsToSvgPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y} L ${points[0].x + 0.5} ${points[0].y + 0.5}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x} ${points[i].y}`;
  }
  return d;
}

// Simple point simplification: skip points that are very close together.
function simplifyPoints(points: Point[], tolerance: number = 2): Point[] {
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

function DrawingCanvas(
  {
    paths,
    currentPath,
    color,
    strokeWidth,
    tool,
    viewport,
    enablePanZoom,
    width,
    height,
    onStrokeStart,
    onStrokeMove,
    onStrokeEnd,
    onTap,
    onPanBy,
    onZoomAtPoint,
    onFling,
    onGestureStart,
    disabled = false,
  }: DrawingCanvasProps,
  svgRef: React.Ref<any>
) {
  // Refs so gestures (built once) always see the latest props/callbacks.
  const viewportRef = useRef(viewport);
  const toolRef = useRef(tool);
  const disabledRef = useRef(disabled);
  const enablePanZoomRef = useRef(enablePanZoom);
  const cbRef = useRef({ onStrokeStart, onStrokeMove, onStrokeEnd, onTap, onPanBy, onZoomAtPoint, onFling, onGestureStart });
  useEffect(() => {
    viewportRef.current = viewport;
    toolRef.current = tool;
    disabledRef.current = disabled;
    enablePanZoomRef.current = enablePanZoom;
    cbRef.current = { onStrokeStart, onStrokeMove, onStrokeEnd, onTap, onPanBy, onZoomAtPoint, onFling, onGestureStart };
  });

  const toBoard = useCallback((x: number, y: number): Point => screenToBoard(viewportRef.current, { x, y }), []);

  // Pan/zoom gestures are gated by enablePanZoom. In text mode the parent maps
  // tool to "pen" and no-ops the stroke callbacks, so drags simply do nothing
  // while taps route through onTap to place text.
  const drawEnabled = !disabled;

  const gesture = useMemo(() => {
    const draw = Gesture.Pan()
      .maxPointers(1)
      .enabled(drawEnabled)
      .runOnJS(true)
      .onBegin(() => cbRef.current.onGestureStart())
      .onStart((e) => {
        cbRef.current.onStrokeStart();
        cbRef.current.onStrokeMove(toBoard(e.x, e.y));
      })
      .onUpdate((e) => {
        cbRef.current.onStrokeMove(toBoard(e.x, e.y));
      })
      .onEnd(() => cbRef.current.onStrokeEnd())
      .onFinalize((_e, success) => {
        if (!success) cbRef.current.onStrokeEnd();
      });

    const tap = Gesture.Tap()
      .enabled(!disabled)
      .runOnJS(true)
      .maxDuration(250)
      .onEnd((e, success) => {
        if (success) cbRef.current.onTap(toBoard(e.x, e.y));
      });

    const twoFingerPan = Gesture.Pan()
      .minPointers(2)
      .enabled(enablePanZoom && !disabled)
      .runOnJS(true)
      .onBegin(() => cbRef.current.onGestureStart())
      .onChange((e) => cbRef.current.onPanBy(e.changeX, e.changeY))
      .onEnd((e) => cbRef.current.onFling(e.velocityX / 1000, e.velocityY / 1000));

    let lastPinch = 1;
    const pinch = Gesture.Pinch()
      .enabled(enablePanZoom && !disabled)
      .runOnJS(true)
      .onBegin(() => {
        lastPinch = 1;
        cbRef.current.onGestureStart();
      })
      .onUpdate((e) => {
        if (lastPinch <= 0) lastPinch = e.scale || 1;
        const factor = e.scale / lastPinch;
        lastPinch = e.scale;
        cbRef.current.onZoomAtPoint(factor, { x: e.focalX, y: e.focalY });
      });

    return Gesture.Simultaneous(
      Gesture.Exclusive(draw, tap),
      Gesture.Simultaneous(twoFingerPan, pinch)
    );
  }, [drawEnabled, enablePanZoom, disabled, toBoard]);

  // Web: wheel to pan, ctrl/cmd+wheel (and trackpad pinch) to zoom toward cursor.
  const containerRef = useRef<any>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node: HTMLElement | null = containerRef.current;
    if (!node || typeof node.addEventListener !== "function") return;
    const onWheel = (e: WheelEvent) => {
      if (!enablePanZoomRef.current || disabledRef.current) return;
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      const focal = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        cbRef.current.onZoomAtPoint(factor, focal);
      } else {
        cbRef.current.onPanBy(-e.deltaX, -e.deltaY);
      }
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const win = Dimensions.get("window");
  const svgW = width ?? win.width;
  const svgH = height ?? win.height;
  const transform = `translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`;

  // Memoize simplified path strings to avoid recomputing on every render.
  const pathStrings = useMemo(
    () =>
      paths.map((p) => ({
        id: p.id,
        d: pointsToSvgPath(simplifyPoints(p.points)),
        color: p.tool === "eraser" ? "#FFFFFF" : p.color,
        strokeWidth: p.tool === "eraser" ? p.strokeWidth + 10 : p.strokeWidth,
      })),
    [paths]
  );

  return (
    <GestureDetector gesture={gesture}>
      <View ref={containerRef} style={styles.container} collapsable={false}>
        <Svg ref={svgRef} width={svgW} height={svgH} style={StyleSheet.absoluteFill}>
          <G transform={transform}>
            {pathStrings.map((p) => {
              if (!p.d) return null;
              return (
                <Path
                  key={p.id}
                  d={p.d}
                  stroke={p.color}
                  strokeWidth={p.strokeWidth}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
            })}
            {currentPath && currentPath.length > 0 && (
              <Path
                d={pointsToSvgPath(currentPath)}
                stroke={tool === "eraser" ? "#E5E7EB" : color}
                strokeWidth={tool === "eraser" ? strokeWidth + 10 : strokeWidth}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </G>
        </Svg>
      </View>
    </GestureDetector>
  );
}

export default React.forwardRef(DrawingCanvas);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
});
