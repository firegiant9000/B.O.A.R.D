import React, { useRef, useMemo, useEffect, useCallback } from "react";
import { View, StyleSheet, Dimensions, Platform } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Path, G, Rect, Ellipse, Line, Polygon, Circle, Defs, Pattern, Image as SvgImage } from "react-native-svg";
import { DrawPath, ImageElement, BackgroundTemplate } from "../types";
import { Viewport, Point, Bounds, screenToBoard } from "../lib/viewport";
import {
  ShapeDraft,
  Guide,
  arrowheadPoints,
  arrowheadSize,
  trianglePoints,
} from "../lib/shapes";
import {
  patternSpec,
  hasAxes,
  visibleBoardBounds,
  GRID_COLOR,
  LINE_COLOR,
  AXIS_COLOR,
} from "../lib/backgrounds";

interface DrawingCanvasProps {
  paths: DrawPath[];
  /** Persisted vector shapes (Phase 7), rendered in the SVG element tree. */
  shapes?: (ShapeDraft & { id: string })[];
  /** Persisted image elements (Phase 9), rendered in the SVG element tree. */
  images?: ImageElement[];
  /** In-progress shape being dragged out, in board-space. */
  shapeDraft?: ShapeDraft | null;
  /** Smart-guide lines (board-space) to overlay during a shape drag. */
  guides?: Guide[];
  /** Phase 8: ids in the current multi-selection (for the live-move offset). */
  selectedIds?: Set<string>;
  /** Phase 8: board-space outline boxes drawn around each selected element. */
  selectionBoxes?: Bounds[];
  /** Phase 8: live SVG transform applied to selected elements during a group
   *  gesture — `translate(...)` for a move, `matrix(...)` for resize/rotate. */
  selectedTransform?: string;
  /** Phase 8: live marquee rectangle (board-space) during a rubber-band drag. */
  marquee?: Bounds | null;
  /** Phase 12: per-board background template, painted behind every element. */
  backgroundTemplate?: BackgroundTemplate;
  /** In-progress stroke, in board-space. */
  currentPath: Point[] | null;
  color: string;
  strokeWidth: number;
  tool: "pen" | "eraser";
  viewport: Viewport;
  /** When false, only drawing is active (pan/zoom disabled) — the rollback path. */
  enablePanZoom: boolean;
  /** Phase 11: Hand tool / held Space — a single-finger drag pans the viewport
   *  (and flings on release) instead of drawing. */
  panMode?: boolean;
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

/** Dasharray for a dashed/dotted stroke, scaled to the stroke width. */
function dashArray(strokeWidth: number): string {
  const d = Math.max(2, strokeWidth * 2);
  return `${d},${d}`;
}

/** SVG arrowhead barbs for one end of a line/arrow. */
function Arrowhead({
  style,
  tip,
  angle,
  strokeWidth,
  color,
}: {
  style: ShapeDraft["arrowheadEnd"];
  tip: Point;
  angle: number;
  strokeWidth: number;
  color: string;
}) {
  if (style === "none") return null;
  const size = arrowheadSize(strokeWidth);
  if (style === "dot" || style === "circle") {
    return (
      <Circle
        cx={tip.x}
        cy={tip.y}
        r={size / 2}
        fill={style === "dot" ? color : "none"}
        stroke={color}
        strokeWidth={strokeWidth}
      />
    );
  }
  const [t, b1, b2] = arrowheadPoints(tip, angle, size);
  if (style === "open") {
    return (
      <>
        <Line x1={t.x} y1={t.y} x2={b1.x} y2={b1.y} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
        <Line x1={t.x} y1={t.y} x2={b2.x} y2={b2.y} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      </>
    );
  }
  // classic — filled triangle
  return <Polygon points={`${t.x},${t.y} ${b1.x},${b1.y} ${b2.x},${b2.y}`} fill={color} />;
}

/** Render one shape (persisted or in-progress draft) into the SVG element tree. */
function ShapeSvg({ s }: { s: ShapeDraft }) {
  const dash = s.dashed ? dashArray(s.strokeWidth) : undefined;
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const rotation = s.rotation ? `rotate(${s.rotation}, ${cx}, ${cy})` : undefined;
  const common = {
    stroke: s.stroke,
    strokeWidth: s.strokeWidth,
    strokeDasharray: dash,
    fill: s.fill,
  };

  let body: React.ReactNode = null;
  if (s.shape === "rect") {
    body = <Rect x={s.x} y={s.y} width={Math.abs(s.width)} height={Math.abs(s.height)} {...common} />;
  } else if (s.shape === "ellipse") {
    body = <Ellipse cx={cx} cy={cy} rx={Math.abs(s.width) / 2} ry={Math.abs(s.height) / 2} {...common} />;
  } else if (s.shape === "triangle") {
    const pts = trianglePoints(s.x, s.y, s.width, s.height).map((p) => `${p.x},${p.y}`).join(" ");
    body = <Polygon points={pts} {...common} />;
  } else {
    // line / arrow
    const end = { x: s.x + s.width, y: s.y + s.height };
    const angleEnd = Math.atan2(s.height, s.width);
    const angleStart = Math.atan2(-s.height, -s.width);
    body = (
      <>
        <Line
          x1={s.x}
          y1={s.y}
          x2={end.x}
          y2={end.y}
          stroke={s.stroke}
          strokeWidth={s.strokeWidth}
          strokeDasharray={dash}
          strokeLinecap="round"
        />
        {s.shape === "arrow" && (
          <>
            <Arrowhead style={s.arrowheadEnd} tip={end} angle={angleEnd} strokeWidth={s.strokeWidth} color={s.stroke} />
            <Arrowhead style={s.arrowheadStart} tip={{ x: s.x, y: s.y }} angle={angleStart} strokeWidth={s.strokeWidth} color={s.stroke} />
          </>
        )}
      </>
    );
  }
  return rotation ? <G transform={rotation}>{body}</G> : <>{body}</>;
}

/** Render one persisted image element into the SVG element tree. */
function ImageSvg({ img }: { img: ImageElement }) {
  const w = Math.abs(img.width);
  const h = Math.abs(img.height);
  const x = Math.min(img.x, img.x + img.width);
  const y = Math.min(img.y, img.y + img.height);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const node = (
    <SvgImage
      x={x}
      y={y}
      width={w}
      height={h}
      href={{ uri: img.url }}
      preserveAspectRatio="xMidYMid slice"
    />
  );
  return img.rotation ? (
    <G transform={`rotate(${img.rotation}, ${cx}, ${cy})`}>{node}</G>
  ) : (
    node
  );
}

/**
 * Phase 12 background template. Lives inside the viewport-transformed `<g>` as
 * its first child, so it sits behind every element and scales with zoom. Painted
 * as a single SVG `<Pattern>` tiled over the visible board rect (cheap at any
 * zoom — no per-cell nodes); the coordinate plane adds emphasized x/y axes on
 * top. Stroke widths are `1/scale` board units so lines stay ~1px on screen.
 * Non-interactive: all gestures are handled by the parent GestureDetector, never
 * by SVG nodes, so this never intercepts input.
 */
function BackgroundLayer({
  template,
  viewport,
  width,
  height,
}: {
  template: BackgroundTemplate;
  viewport: Viewport;
  width: number;
  height: number;
}) {
  const spec = patternSpec(template);
  if (!spec) return null;
  const scale = viewport.scale || 1;
  const sw = 1 / scale; // ~1px on screen regardless of zoom
  const dotR = 1.3 / scale;
  // Pad one tile so a pan never reveals an unpainted edge mid-frame.
  const b = visibleBoardBounds(viewport, width, height, Math.max(spec.width, spec.height) * scale);
  const id = `bg-${template}`;
  return (
    <>
      <Defs>
        <Pattern
          id={id}
          patternUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={spec.width}
          height={spec.height}
        >
          {spec.lines.map((l, i) => (
            <Line
              key={`l${i}`}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke={template === "lined" ? LINE_COLOR : GRID_COLOR}
              strokeWidth={sw}
            />
          ))}
          {spec.dots.map((d, i) => (
            <Circle key={`d${i}`} cx={d.cx} cy={d.cy} r={dotR} fill={GRID_COLOR} />
          ))}
        </Pattern>
      </Defs>
      <Rect
        x={b.minX}
        y={b.minY}
        width={Math.max(0, b.maxX - b.minX)}
        height={Math.max(0, b.maxY - b.minY)}
        fill={`url(#${id})`}
      />
      {hasAxes(template) && (
        <>
          <Line x1={0} y1={b.minY} x2={0} y2={b.maxY} stroke={AXIS_COLOR} strokeWidth={1.5 * sw} />
          <Line x1={b.minX} y1={0} x2={b.maxX} y2={0} stroke={AXIS_COLOR} strokeWidth={1.5 * sw} />
        </>
      )}
    </>
  );
}

function DrawingCanvas(
  {
    paths,
    shapes,
    images,
    shapeDraft,
    guides,
    selectedIds,
    selectionBoxes,
    selectedTransform,
    marquee,
    backgroundTemplate,
    currentPath,
    color,
    strokeWidth,
    tool,
    viewport,
    enablePanZoom,
    panMode = false,
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
  const panModeRef = useRef(panMode);
  const cbRef = useRef({ onStrokeStart, onStrokeMove, onStrokeEnd, onTap, onPanBy, onZoomAtPoint, onFling, onGestureStart });
  useEffect(() => {
    viewportRef.current = viewport;
    toolRef.current = tool;
    disabledRef.current = disabled;
    enablePanZoomRef.current = enablePanZoom;
    panModeRef.current = panMode;
    cbRef.current = { onStrokeStart, onStrokeMove, onStrokeEnd, onTap, onPanBy, onZoomAtPoint, onFling, onGestureStart };
  });

  const toBoard = useCallback((x: number, y: number): Point => screenToBoard(viewportRef.current, { x, y }), []);

  // Pan/zoom gestures are gated by enablePanZoom. In text mode the parent maps
  // tool to "pen" and no-ops the stroke callbacks, so drags simply do nothing
  // while taps route through onTap to place text.
  const drawEnabled = !disabled;

  const gesture = useMemo(() => {
    // Single-finger pan tracking for the Hand tool / held Space. Re-initialized
    // per drag in onStart; pan deltas are screen-space (the viewport transform
    // shifts mid-drag, so board-space deltas would feed back on themselves).
    let panLast = { x: 0, y: 0 };
    const draw = Gesture.Pan()
      .maxPointers(1)
      .enabled(drawEnabled)
      .runOnJS(true)
      .onBegin(() => cbRef.current.onGestureStart())
      .onStart((e) => {
        if (panModeRef.current) {
          panLast = { x: e.x, y: e.y };
          return;
        }
        cbRef.current.onStrokeStart();
        cbRef.current.onStrokeMove(toBoard(e.x, e.y));
      })
      .onUpdate((e) => {
        if (panModeRef.current) {
          cbRef.current.onPanBy(e.x - panLast.x, e.y - panLast.y);
          panLast = { x: e.x, y: e.y };
          return;
        }
        cbRef.current.onStrokeMove(toBoard(e.x, e.y));
      })
      .onEnd((e) => {
        if (panModeRef.current) {
          cbRef.current.onFling(e.velocityX / 1000, e.velocityY / 1000);
          return;
        }
        cbRef.current.onStrokeEnd();
      })
      .onFinalize((_e, success) => {
        if (!success && !panModeRef.current) cbRef.current.onStrokeEnd();
      });

    const tap = Gesture.Tap()
      .enabled(!disabled)
      .runOnJS(true)
      .maxDuration(250)
      .onEnd((e, success) => {
        if (success && !panModeRef.current) cbRef.current.onTap(toBoard(e.x, e.y));
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

  // Live group gesture: render selected members through the supplied SVG
  // transform (translate for move, matrix for resize/rotate) without churning
  // the persisted arrays — the final geometry is baked in on drag end.
  const isSel = (eid: string) => !!selectedIds && selectedIds.has(eid);
  const offsetTransform = selectedTransform || undefined;
  const strokeW = 1 / (viewport.scale || 1);

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
            {/* Background template (Phase 12): behind everything, scales with
                zoom, never intercepts input. */}
            {backgroundTemplate && backgroundTemplate !== "blank" && (
              <BackgroundLayer
                template={backgroundTemplate}
                viewport={viewport}
                width={svgW}
                height={svgH}
              />
            )}
            {/* Images render beneath strokes/shapes/text so annotations sit on
                top of them; within the layer they participate in selection +
                the live group transform like every other element kind. */}
            {images?.map((img) =>
              offsetTransform && isSel(img.id) ? (
                <G key={img.id} transform={offsetTransform}>
                  <ImageSvg img={img} />
                </G>
              ) : (
                <ImageSvg key={img.id} img={img} />
              )
            )}
            {pathStrings.map((p) => {
              if (!p.d) return null;
              const node = (
                <Path
                  d={p.d}
                  stroke={p.color}
                  strokeWidth={p.strokeWidth}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
              return offsetTransform && isSel(p.id) ? (
                <G key={p.id} transform={offsetTransform}>
                  {node}
                </G>
              ) : (
                React.cloneElement(node, { key: p.id })
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
            {shapes?.map((s) =>
              offsetTransform && isSel(s.id) ? (
                <G key={s.id} transform={offsetTransform}>
                  <ShapeSvg s={s} />
                </G>
              ) : (
                <ShapeSvg key={s.id} s={s} />
              )
            )}
            {shapeDraft && <ShapeSvg s={shapeDraft} />}
            {/* Per-element selection outlines (board-space), shifted with the
                live move so multi-select feedback tracks the drag. */}
            {selectionBoxes?.map((b, i) => {
              const box = (
                <Rect
                  x={b.minX}
                  y={b.minY}
                  width={Math.max(0, b.maxX - b.minX)}
                  height={Math.max(0, b.maxY - b.minY)}
                  fill="none"
                  stroke="#2563eb"
                  strokeOpacity={0.7}
                  strokeWidth={strokeW}
                  strokeDasharray={`${4 * strokeW},${3 * strokeW}`}
                />
              );
              return offsetTransform ? (
                <G key={`sel${i}`} transform={offsetTransform}>
                  {box}
                </G>
              ) : (
                React.cloneElement(box, { key: `sel${i}` })
              );
            })}
            {/* Marquee rubber-band rectangle. */}
            {marquee && (
              <Rect
                x={marquee.minX}
                y={marquee.minY}
                width={Math.max(0, marquee.maxX - marquee.minX)}
                height={Math.max(0, marquee.maxY - marquee.minY)}
                fill="#2563eb"
                fillOpacity={0.08}
                stroke="#2563eb"
                strokeWidth={strokeW}
                strokeDasharray={`${4 * strokeW},${3 * strokeW}`}
              />
            )}
            {guides?.map((g, i) =>
              g.axis === "x" ? (
                <Line
                  key={`g${i}`}
                  x1={g.position}
                  y1={-100000}
                  x2={g.position}
                  y2={100000}
                  stroke="#2563eb"
                  strokeWidth={1 / (viewport.scale || 1)}
                />
              ) : (
                <Line
                  key={`g${i}`}
                  x1={g.position - 100000}
                  y1={g.position}
                  x2={g.position + 100000}
                  y2={g.position}
                  stroke="#2563eb"
                  strokeWidth={1 / (viewport.scale || 1)}
                />
              )
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
