import React, { useRef, useMemo, useEffect, useCallback } from "react";
import { View, StyleSheet, Dimensions, Platform } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Path, G, Rect, Ellipse, Line, Polygon, Circle, Defs, Pattern, Image as SvgImage } from "react-native-svg";
import { DrawPath, ImageElement, MathElement, BackgroundTemplate } from "../types";
import MathElementView from "./board/MathElementView";
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
import { PenStyle, renderParamsFor, calligraphyWidthRange } from "../lib/penStyles";
import { calligraphyPathD } from "../lib/calligraphy";

interface DrawingCanvasProps {
  paths: DrawPath[];
  /** Persisted vector shapes (Phase 7), rendered in the SVG element tree. */
  shapes?: (ShapeDraft & { id: string })[];
  /** Persisted image elements (Phase 9), rendered in the SVG element tree. */
  images?: ImageElement[];
  /** Persisted math elements (Month 6), rendered in the SVG element tree as
   *  ordinary `<Path>` nodes — which is what makes an equation selectable,
   *  transformable, exportable and printable with no special-casing. */
  mathElements?: MathElement[];
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
  /** Month 5 (ROADMAP item 12) — the in-progress stroke's pen variant/alpha,
   *  mirroring `DrawPath.penStyle`/`opacity` for a persisted one. Both
   *  optional so a caller drawing plain pen strokes (or the eraser, which
   *  ignores both) needn't pass them. */
  penStyle?: PenStyle;
  opacity?: number;
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
  /** Phase 6: pointer moved (hover on web, drag on native), in board-space.
   *  Side-channel only — must not trigger an element-tree re-render.
   *  Month 5: `pressed` is true only while a button/finger is actually down.
   *  Native's only source for this callback is mid-drag (no hover on touch),
   *  so it's always `true` there; web's hover listener reports the real
   *  `PointerEvent.buttons` state, so a plain mouse-move with nothing held
   *  reports `false`. The laser tool is the one consumer that cares — see
   *  `useBoardCollab.ts#publishPointer`. */
  onPointerMove?: (point: Point, pressed: boolean) => void;
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

/**
 * Resolved paint for one stroke (persisted or the in-progress preview) —
 * either a stroked outline (`fillMode: false`) or, for calligraphy, a
 * filled variable-width ribbon (`fillMode: true` — see `calligraphyPathD`'s
 * own header for why that variant can't be a stroked `<Path>` at all).
 * Pure/no-JSX so it's one code path for both the persisted-paths loop and
 * the live `currentPath` preview below, instead of two render sites quietly
 * drifting apart on how a pen variant looks.
 */
export interface StrokeVisual {
  d: string;
  fillMode: boolean;
  paintColor: string;
  paintOpacity: number;
  strokeWidth: number;
  linecap: "round" | "butt" | "square";
  linejoin: "round" | "miter" | "bevel";
  multiplyBlend: boolean;
}

function strokeVisualFor(
  points: Point[],
  color: string,
  strokeWidth: number,
  tool: "pen" | "eraser",
  penStyle: PenStyle | undefined,
  opacity: number | undefined
): StrokeVisual {
  if (tool === "eraser") {
    // Unchanged from the pre-Month-5 eraser look: opaque white/gray paint,
    // never touched by penStyle/opacity (an eraser stroke has neither).
    return {
      d: pointsToSvgPath(points),
      fillMode: false,
      paintColor: "#FFFFFF",
      paintOpacity: 1,
      strokeWidth: strokeWidth + 10,
      linecap: "round",
      linejoin: "round",
      multiplyBlend: false,
    };
  }
  if (penStyle === "calligraphy") {
    const [minW, maxW] = calligraphyWidthRange(strokeWidth);
    return {
      d: calligraphyPathD(points, minW, maxW),
      fillMode: true,
      paintColor: color,
      paintOpacity: opacity ?? 1,
      strokeWidth: 0,
      linecap: "round",
      linejoin: "round",
      multiplyBlend: false,
    };
  }
  const params = renderParamsFor(penStyle, strokeWidth, opacity);
  return {
    d: pointsToSvgPath(points),
    fillMode: false,
    paintColor: color,
    paintOpacity: params.opacity,
    strokeWidth: params.strokeWidth,
    linecap: params.linecap,
    linejoin: params.linejoin,
    multiplyBlend: params.multiplyBlend,
  };
}

/**
 * The highlighter's "multiply blend mode" (ROADMAP item 12). react-native-
 * svg's PUBLIC TypeScript types (`PathProps` via `CommonPathProps`) don't
 * declare a `style` prop, but its own web renderer's prop preparation does
 * accept and forward one straight onto the real DOM node
 * (react-native-svg/src/web/utils/prepare.ts: `style?: object`, merged via
 * `resolve(...)`) — confirmed against the installed package's source, not
 * assumed. That makes a real CSS `mix-blend-mode` reachable on web without a
 * WebView (never allowed on this canvas): the cast below is narrowly scoped
 * to this one call site, not a blanket escape hatch.
 *
 * This is a genuinely **web-only** effect. RNSVG's iOS/Android backend has
 * no CSS style pipeline to forward this into, and the library's only actual
 * blend-mode primitive (`<FeBlend>`) blends two NAMED filter inputs — it has
 * no supported "blend against whatever the canvas already painted" input
 * (the legacy `BackgroundImage` SVG keyword this would need is not
 * documented as implemented here, and is unsupported/removed in most modern
 * renderers regardless). So on native this resolves to `{}`: the highlighter
 * still renders as the translucent wide stroke above, just without the
 * darkened overlap where two highlighter strokes cross. That gap is a real,
 * disclosed platform limitation — not something to claim is "fixed" later
 * without an actual native blend primitive to fix it with.
 */
function multiplyBlendStyle(active: boolean): Partial<React.ComponentProps<typeof Path>> {
  if (!active || Platform.OS !== "web") return {};
  return { style: { mixBlendMode: "multiply" } } as unknown as Partial<React.ComponentProps<typeof Path>>;
}

/** Renders one resolved `StrokeVisual` as the right kind of `<Path>`. Exported
 *  (only) for `DrawingCanvas.test.tsx`'s render-level check that
 *  `multiplyBlendStyle` actually reaches the rendered `<Path>` as a `style`
 *  prop on web and as nothing on native — this component has no test file
 *  of its own otherwise (see that file's header for why). */
export function StrokeSvg({ visual }: { visual: StrokeVisual }) {
  if (!visual.d) return null;
  if (visual.fillMode) {
    return <Path d={visual.d} fill={visual.paintColor} fillOpacity={visual.paintOpacity} stroke="none" />;
  }
  return (
    <Path
      d={visual.d}
      stroke={visual.paintColor}
      strokeOpacity={visual.paintOpacity}
      strokeWidth={visual.strokeWidth}
      fill="none"
      strokeLinecap={visual.linecap}
      strokeLinejoin={visual.linejoin}
      {...multiplyBlendStyle(visual.multiplyBlend)}
    />
  );
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
    mathElements,
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
    penStyle,
    opacity,
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
    onPointerMove,
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
  const cbRef = useRef({ onStrokeStart, onStrokeMove, onStrokeEnd, onTap, onPointerMove, onPanBy, onZoomAtPoint, onFling, onGestureStart });
  useEffect(() => {
    viewportRef.current = viewport;
    toolRef.current = tool;
    disabledRef.current = disabled;
    enablePanZoomRef.current = enablePanZoom;
    panModeRef.current = panMode;
    cbRef.current = { onStrokeStart, onStrokeMove, onStrokeEnd, onTap, onPointerMove, onPanBy, onZoomAtPoint, onFling, onGestureStart };
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
        // Broadcast the pointer regardless of mode (native has no hover, so a
        // drag is the only cursor signal). Side-channel only — publishing is
        // throttled downstream and never sets state here. `pressed: true` —
        // `.onUpdate` only ever fires mid-drag, so a finger/button is
        // definitionally down for every call here.
        cbRef.current.onPointerMove?.(toBoard(e.x, e.y), true);
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

  // Web: broadcast the live pointer on hover/move for the cursor side channel
  // (Phase 6). Side-channel only — onPointerMove is throttled downstream and
  // never re-renders the element tree. Native gets the signal from the gesture
  // above (no hover events on touch).
  //
  // Month 5: `e.buttons` (a bitmask; 0 means nothing pressed) is reported
  // through as `pressed` — a plain hover has nothing held, so it must read as
  // `false`. Without this, moving the mouse across the canvas with the laser
  // tool selected paints a continuous trail with no press at all, and a
  // genuinely isolated quick-tap becomes unreachable (hover right before and
  // after the tap already seeded one) — this listener runs regardless of
  // tool, so it's the one place that has to get the distinction right.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node: HTMLElement | null = containerRef.current;
    if (!node || typeof node.addEventListener !== "function") return;
    const onMove = (e: PointerEvent) => {
      if (disabledRef.current) return;
      const rect = node.getBoundingClientRect();
      cbRef.current.onPointerMove?.(
        toBoard(e.clientX - rect.left, e.clientY - rect.top),
        e.buttons > 0
      );
    };
    node.addEventListener("pointermove", onMove);
    return () => node.removeEventListener("pointermove", onMove);
  }, [toBoard]);

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

  // Memoize resolved stroke visuals (incl. the simplified point path) to
  // avoid recomputing on every render.
  const pathStrings = useMemo(
    () =>
      paths.map((p) => ({
        id: p.id,
        visual: strokeVisualFor(
          simplifyPoints(p.points),
          p.color,
          p.strokeWidth,
          p.tool,
          p.penStyle,
          p.opacity
        ),
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
            {pathStrings.map(({ id, visual }) => {
              if (!visual.d) return null;
              return offsetTransform && isSel(id) ? (
                <G key={id} transform={offsetTransform}>
                  <StrokeSvg visual={visual} />
                </G>
              ) : (
                <StrokeSvg key={id} visual={visual} />
              );
            })}
            {currentPath && currentPath.length > 0 && tool === "eraser" && (
              // Live eraser preview keeps its own distinct light-gray trail
              // (unchanged from before Month 5's colour + stroke polish) rather than routing through
              // strokeVisualFor's eraser branch, which renders the
              // PERSISTED-eraser-path white that made sense against a plain
              // white canvas — the two were already different colors and
              // stay that way here.
              <Path
                d={pointsToSvgPath(currentPath)}
                stroke="#E5E7EB"
                strokeWidth={strokeWidth + 10}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {currentPath && currentPath.length > 0 && tool === "pen" && (
              // Live pen/highlighter/marker/calligraphy preview — one code
              // path with the persisted-path renderer above (strokeVisualFor
              // + StrokeSvg), so the in-progress stroke looks exactly like
              // what committing it will persist, never a "plain until it
              // lands" flash for the three new variants.
              <StrokeSvg visual={strokeVisualFor(currentPath, color, strokeWidth, "pen", penStyle, opacity)} />
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
            {/* Math elements (Month 6) render above strokes and shapes — the
                reverse of `useBoardElements.hitTestAny`'s walk order, which
                is what keeps "what you tap" and "what you see on top" the
                same thing. Within the layer they take the live group
                transform exactly like every other kind, because they are
                just `<Path>` nodes. */}
            {mathElements?.map((m) =>
              offsetTransform && isSel(m.id) ? (
                <G key={m.id} transform={offsetTransform}>
                  <MathElementView element={m} />
                </G>
              ) : (
                <MathElementView key={m.id} element={m} />
              )
            )}
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
