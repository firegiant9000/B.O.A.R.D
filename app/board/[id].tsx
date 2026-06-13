import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DrawingCanvas from "../../src/components/DrawingCanvas";
import Toolbar from "../../src/components/Toolbar";
import TextNoteOverlay from "../../src/components/TextNoteOverlay";
import TextElementView from "../../src/components/TextElementView";
import MemberList from "../../src/components/MemberList";
import JoinBoardModal from "../../src/components/JoinBoardModal";
import ShareBoardModal from "../../src/components/ShareBoardModal";
import BoardUserBar from "../../src/components/BoardUserBar";
import StartSessionModal from "../../src/components/StartSessionModal";
import ZoomControls from "../../src/components/ZoomControls";
import SelectionOverlay from "../../src/components/SelectionOverlay";
import ShapeOptionsBar from "../../src/components/ShapeOptionsBar";
import OfflineBanner from "../../src/components/OfflineBanner";
import ShortcutsCheatSheet from "../../src/components/ShortcutsCheatSheet";
import BackgroundPicker from "../../src/components/BackgroundPicker";
import { useAuth } from "../../src/hooks/useAuth";
import { useShortcuts } from "../../src/hooks/useShortcuts";
import { ShortcutAction } from "../../src/lib/shortcuts";
import { getClipboardImage } from "../../src/lib/osClipboard";
import { useViewport } from "../../src/hooks/useViewport";
import { useThrottledValue } from "../../src/hooks/useThrottledValue";
import { useSelection } from "../../src/hooks/useSelection";
import { Point, Bounds, boundsOfPoints, unionBounds, inflateBounds, screenToBoard } from "../../src/lib/viewport";
import { viewportBounds, boundsIntersect } from "../../src/lib/culling";
import { pointNearPolyline, boundsContainPoint, distanceToSegment } from "../../src/lib/hitTest";
import { rdpSimplify } from "../../src/lib/simplify";
import {
  marqueeBounds,
  translatePoints,
  translateBounds,
  DUPLICATE_OFFSET,
  MIN_SCALE_FACTOR,
  scalePointAbout,
  rotatePointAbout,
  scaleBoundsAbout,
  resizeMatrix,
  rotateMatrix,
} from "../../src/lib/transform";
import type { HandleId } from "../../src/components/SelectionOverlay";
import {
  ElementKind,
  IndexEntry,
  ElementIndex,
  buildElementIndex,
  entryFromBounds,
  queryBounds,
} from "../../src/lib/spatialIndex";
import {
  ShapeDraft,
  Guide,
  GRID_SIZES,
  GUIDE_TOLERANCE,
  MIN_SHAPE_SIZE,
  shapeBbox,
  snapPoint,
  constrainDraft,
  rectFromPoints,
  computeGuides,
  hexToRgba,
} from "../../src/lib/shapes";
import { imageBbox, placementBox, PreparedImage } from "../../src/lib/images";
import { pickAndPrepareImage, prepareWebFile, prepareNativeImageUri, ImageSource } from "../../src/lib/imagePicker";
import {
  ClipItem,
  setClipboard,
  getClipboard,
  hasClipboard,
  nextPasteOffset,
  offsetClipItem,
} from "../../src/lib/clipboard";
import * as boardService from "../../src/services/boardService";
import * as pathService from "../../src/services/pathService";
import * as shapeService from "../../src/services/shapeService";
import * as imageService from "../../src/services/imageService";
import * as snapshotService from "../../src/services/snapshotService";
import * as presenceService from "../../src/services/presenceService";
import * as friendService from "../../src/services/friendService";
import * as sessionService from "../../src/services/sessionService";
import { captureSvgAsPng } from "../../src/utils/canvasCapture";
import { captureException } from "../../src/lib/errorReporting";
import { reportSyncState } from "../../src/lib/connectivity";
import {
  Board,
  BoardPresence,
  DrawPath,
  Session,
  TextNote,
  TextElement,
  ShapeElement,
  ShapeKind,
  ArrowheadStyle,
  ImageElement,
  BackgroundTemplate,
} from "../../src/types";

type Tool = "pen" | "eraser" | "text" | "select" | "shape" | "hand";

const ARROWHEAD_CYCLE: ArrowheadStyle[] = ["classic", "dot", "circle", "open", "none"];
const SNAP_CYCLE = [0, ...GRID_SIZES];
const SHAPE_FILL_ALPHA = 0.2;

// Phase 5 hit-testing tolerances (board units, before zoom). Selection adds a
// generous reach around the thin stroke geometry so taps land; the eraser reach
// is derived per-stroke from the active width.
const SELECT_TAP_PADDING = 10;
const ERASER_PAD = 10; // matches the legacy white-eraser render inflation

/**
 * Assign new z values to bring/send the selected members of one collection to
 * the front/back *of that collection's layer*. Returns the (id, z) pairs to
 * persist. NOTE: z-order is per-layer — paths render under shapes render under
 * text — so "bring to front" raises within the element's own layer, not across
 * the whole canvas (a global render-merge is out of Phase 8 scope).
 */
function planZOrder<T extends { id: string; z?: number }>(
  arr: T[],
  ids: Set<string>,
  dir: "front" | "back"
): { id: string; z: number }[] {
  const selected = arr.filter((e) => ids.has(e.id));
  if (selected.length === 0) return [];
  const zs = arr.map((e) => e.z ?? 0);
  const base = dir === "front" ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1;
  const step = dir === "front" ? 1 : -1;
  return selected.map((e, i) => ({ id: e.id, z: base + i * step }));
}

// --- Pass 2 resize/rotate handle geometry (board-space, on the union box) ---
// Each handle drags toward a fixed anchor (the opposite corner/edge); the
// "start point" is where the handle sits on the pre-drag box.
const ROTATE_HANDLE_OFFSET = 30; // screen px; matches SelectionOverlay
const isCornerHandle = (h: HandleId) => h === "tl" || h === "tr" || h === "bl" || h === "br";
const handleInvolvesX = (h: HandleId) => h !== "t" && h !== "b" && h !== "rotate";
const handleInvolvesY = (h: HandleId) => h !== "l" && h !== "r" && h !== "rotate";

function handleStartPoint(h: HandleId, b: Bounds): Point {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  switch (h) {
    case "tl": return { x: b.minX, y: b.minY };
    case "tr": return { x: b.maxX, y: b.minY };
    case "bl": return { x: b.minX, y: b.maxY };
    case "br": return { x: b.maxX, y: b.maxY };
    case "t": return { x: cx, y: b.minY };
    case "b": return { x: cx, y: b.maxY };
    case "l": return { x: b.minX, y: cy };
    case "r": return { x: b.maxX, y: cy };
    default: return { x: cx, y: cy };
  }
}

function anchorPoint(h: HandleId, b: Bounds): Point {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  switch (h) {
    case "tl": return { x: b.maxX, y: b.maxY };
    case "tr": return { x: b.minX, y: b.maxY };
    case "bl": return { x: b.maxX, y: b.minY };
    case "br": return { x: b.minX, y: b.minY };
    case "l": return { x: b.maxX, y: cy };
    case "r": return { x: b.minX, y: cy };
    case "t": return { x: cx, y: b.maxY };
    case "b": return { x: cx, y: b.minY };
    default: return { x: cx, y: cy };
  }
}

// Feature flag for the Phase 2 pan/zoom transform. Off => identity viewport and
// drawing only (pre-Phase-2 behavior) as a quick rollback if parity regresses.
const ENABLE_PAN_ZOOM = true;

// Phase 3 write-path perf: cap stroke sampling to ~30Hz and simplify with RDP
// (board-space tolerance, ≈px at 100% zoom) before persisting.
const STROKE_SAMPLE_MS = 1000 / 30;
const RDP_TOLERANCE = 2.5;

// Phase 4 viewport culling: re-evaluate which elements are on screen at most
// every CULL_THROTTLE_MS during pan/zoom, keeping a CULL_MARGIN_PX screen-space
// buffer ring mounted so panned-in content never pops in a frame late.
const CULL_THROTTLE_MS = 50;
const CULL_MARGIN_PX = 200;

export default function BoardScreen() {
  const { id, session } = useLocalSearchParams<{ id: string; session?: string }>();
  const router = useRouter();
  const { user, userProfile } = useAuth();

  // `?session={id}` half of the deep-link contract (boardapp://board/{id}?session={id}):
  // open the board, then hand off to that session once. Guarded so it fires a
  // single time per arrival, not on every re-render.
  const handledSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (session && handledSessionRef.current !== session) {
      handledSessionRef.current = session;
      router.push(`/session/${session}`);
    }
  }, [session, router]);

  // Board state
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);

  // Drawing state
  const [paths, setPaths] = useState<DrawPath[]>([]);
  const [notes, setNotes] = useState<TextNote[]>([]);
  const [currentPoints, setCurrentPoints] = useState<
    { x: number; y: number }[] | null
  >(null);
  // Timestamp of the last sampled stroke point — drives 30Hz move coalescing.
  const lastSampleRef = useRef(0);

  // Text element state. Selection is now unified in the `useSelection` slice
  // (Phase 8); only the inline-edit lifecycle (`editingTextId`) stays local —
  // it's a text-input concern, not a selection one.
  const [textElements, setTextElements] = useState<TextElement[]>([]);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  // Tool state
  const [activeTool, setActiveTool] = useState<Tool>("pen");
  const [activeColor, setActiveColor] = useState("#000000");
  const [activeStrokeWidth, setActiveStrokeWidth] = useState(5);

  // Shape tool state (Phase 7)
  const [shapes, setShapes] = useState<ShapeElement[]>([]);
  const [shapeDraft, setShapeDraft] = useState<ShapeDraft | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [activeShapeKind, setActiveShapeKind] = useState<ShapeKind>("rect");
  const [shapeFillEnabled, setShapeFillEnabled] = useState(false);
  const [shapeDashed, setShapeDashed] = useState(false);
  const [shapeArrowheadEnd, setShapeArrowheadEnd] = useState<ArrowheadStyle>("classic");
  const [snapGrid, setSnapGrid] = useState(0);
  // First corner of the in-progress shape drag, and the live draft (ref mirror of
  // state so the gesture's onEnd reads the latest without a stale closure).
  const shapeStartRef = useRef<Point | null>(null);
  const shapeDraftRef = useRef<ShapeDraft | null>(null);
  // Shift held (web) → constrain to square / circle / 45° line.
  const shiftHeldRef = useRef(false);
  // Synchronous shape source for gesture-time hit-testing / guides.
  const visibleShapesRef = useRef<ShapeElement[]>([]);
  // Latest tool/style for use inside gesture callbacks (avoid stale closures).
  const shapeCfgRef = useRef({
    tool: activeTool,
    kind: activeShapeKind,
    color: activeColor,
    strokeWidth: activeStrokeWidth,
    fill: shapeFillEnabled,
    dashed: shapeDashed,
    arrowheadEnd: shapeArrowheadEnd,
    snapGrid,
  });
  useEffect(() => {
    shapeCfgRef.current = {
      tool: activeTool,
      kind: activeShapeKind,
      color: activeColor,
      strokeWidth: activeStrokeWidth,
      fill: shapeFillEnabled,
      dashed: shapeDashed,
      arrowheadEnd: shapeArrowheadEnd,
      snapGrid,
    };
  });

  // Image element state (Phase 9). Mirrors the shape/path arrays: a state array,
  // a synchronous ref for gesture-time hit-testing, and an inserting flag so the
  // image button shows progress while the upload is in flight.
  const [images, setImages] = useState<ImageElement[]>([]);
  const [insertingImage, setInsertingImage] = useState(false);
  const visibleImagesRef = useRef<ImageElement[]>([]);

  // Text note state (legacy sticky notes — kept for backwards compat)
  const [pendingNotePosition, setPendingNotePosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Presence & friends state
  const [presence, setPresence] = useState<BoardPresence[]>([]);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);

  // Deep-link join modal
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [deepLinkCode, setDeepLinkCode] = useState<string | undefined>();

  // Session modal
  const [sessionModalVisible, setSessionModalVisible] = useState(false);

  // Active admin-owned session for this board (drives End Session button)
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [endingSession, setEndingSession] = useState(false);

  // Ref to the underlying SVG element on web, for canvas snapshot capture
  const canvasSvgRef = useRef<any>(null);

  // Share modal
  const [shareBoardModalVisible, setShareBoardModalVisible] = useState(false);

  // Redo stack — stores path data to re-save on redo
  const [redoStack, setRedoStack] = useState<Omit<DrawPath, "id" | "createdAt">[]>([]);

  // Canvas ready — true after the first Firestore snapshot arrives
  const [canvasReady, setCanvasReady] = useState(false);

  // Dismissible error banner
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Phase 11: keyboard shortcuts. The `?` cheat sheet, and a transient pan mode
  // while Space is held on web (the Hand tool is the persistent equivalent).
  const [cheatSheetVisible, setCheatSheetVisible] = useState(false);
  const [spacePanActive, setSpacePanActive] = useState(false);

  // Phase 12: background-template picker visibility.
  const [bgPickerVisible, setBgPickerVisible] = useState(false);

  // Canvas layout size for clamping text element creation position
  const [canvasSize, setCanvasSize] = useState({ width: 300, height: 500 });

  // Save toast animation
  const saveOpacity = useRef(new Animated.Value(0)).current;

  // Auto-save debounce
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref so the text-element snapshot callback always sees the current editing ID
  const editingTextIdRef = useRef<string | null>(null);

  // Viewport (pan/zoom). Identity viewport keeps board-space === screen-space,
  // so pre-existing strokes render unchanged at default zoom.
  const viewportCtl = useViewport();
  const { viewport } = viewportCtl;
  // Viewport sampled for culling — lags the live viewport so the rendered set
  // changes ~20×/s during pan/zoom instead of every frame.
  const cullViewport = useThrottledValue(viewport, CULL_THROTTLE_MS);

  // Stroke selection (Phase 5). Own state slice so toolbar/AI can read it later
  // (ROADMAP A.3). Distinct from the text-element selection above, which keeps
  // its bespoke inline editing/resize until transforms unify in M2.
  const selection = useSelection();

  // Phase 8 group transform: live move offset (board units) applied to the
  // selection during a drag, plus the live marquee rectangle. Both are null
  // when no group gesture is in flight.
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [marquee, setMarquee] = useState<Bounds | null>(null);
  // Pass 2: live resize/rotate preview. `resize` carries the anchor + per-axis
  // factors; `rotate` carries the pivot + angle (radians). Null when idle.
  const [transformPreview, setTransformPreview] = useState<
    | { mode: "resize"; anchor: Point; sx: number; sy: number; bounds: Bounds }
    | { mode: "rotate"; center: Point; theta: number }
    | null
  >(null);
  // The pre-drag union box + center, captured on handle grab so each move
  // recomputes the transform from the original (no accumulation drift).
  const transformGestureRef = useRef<{
    handle: HandleId;
    union: Bounds;
    center: Point;
    last:
      | { mode: "resize"; anchor: Point; sx: number; sy: number }
      | { mode: "rotate"; center: Point; theta: number }
      | null;
  } | null>(null);
  // Alt held (web) → non-uniform corner resize.
  const altHeldRef = useRef(false);
  // Synchronous text source for gesture-time hit-testing (mirrors the path/shape refs).
  const visibleTextElementsRef = useRef<TextElement[]>([]);
  // rbush index over every visible element's bbox, rebuilt when the set changes,
  // queried during a marquee drag for O(log n) hit-testing.
  const spatialIndexRef = useRef<ElementIndex>(buildElementIndex([]));
  // Select-mode drag state machine: a press resolves to a group "move" (started
  // on a selected element) or a "marquee" (started on empty canvas). `offset` and
  // `baseIds` are kept on the ref so the gesture's onEnd reads them without a
  // stale closure / pending-render race.
  const selectGestureRef = useRef<{
    mode: "idle" | "pending" | "move" | "marquee";
    start: Point | null;
    offset: { dx: number; dy: number };
    baseIds: string[];
  }>({ mode: "idle", start: null, offset: { dx: 0, dy: 0 }, baseIds: [] });

  // Ids deleted by the in-progress eraser stroke — guards against re-deleting a
  // path on subsequent moves before the optimistic setPaths re-renders.
  const erasedIdsRef = useRef<Set<string>>(new Set());
  // Latest visible paths for synchronous hit-testing inside gesture callbacks.
  const visiblePathsRef = useRef<DrawPath[]>([]);

  // Phase 7 checkpointing. `lastSnapshotCountRef` is the stroke count captured by
  // the latest snapshot; the trigger fires once a full interval accrues past it.
  // The in-flight guard keeps a single snapshot write from racing itself.
  const lastSnapshotCountRef = useRef(0);
  const snapshotInFlightRef = useRef(false);
  // Gate the checkpoint trigger until cold-load has established the true baseline
  // count. Without it, the listener can push paths while lastSnapshotCountRef is
  // still 0, and shouldSnapshot(>=500, 0) would write a redundant snapshot on load.
  const snapshotBaselineReadyRef = useRef(false);

  // Derived
  const isAdmin = !!user && !!board && user.uid === board.adminId;

  // Board-space bounds of all content, for fit-to-content.
  const contentBounds = (): Bounds | null =>
    unionBounds([
      ...visiblePaths.map((p) => boundsOfPoints(p.points)),
      ...visibleShapes.map((s) => s.bbox ?? shapeBbox(s)),
      ...visibleImages.map((img) => img.bbox ?? imageBbox(img)),
      ...visibleTextElements.map((el) => ({
        minX: el.position.x,
        minY: el.position.y,
        maxX: el.position.x + el.width,
        maxY: el.position.y + el.height,
      })),
      ...visibleNotes.map((n) => ({
        minX: n.position.x,
        minY: n.position.y,
        maxX: n.position.x,
        maxY: n.position.y,
      })),
    ]);

  const canvasCenter = (): Point => ({
    x: canvasSize.width / 2,
    y: canvasSize.height / 2,
  });
  const handleZoomIn = () => viewportCtl.zoomAtPoint(1.25, canvasCenter());
  const handleZoomOut = () => viewportCtl.zoomAtPoint(0.8, canvasCenter());
  const handleFitToContent = () => viewportCtl.fit(contentBounds(), canvasSize);

  // Safe navigation: fall back to Boards tab when there is no history to pop
  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/(tabs)");
    }
  };

  // Keep editingTextIdRef in sync for use inside snapshot callbacks
  useEffect(() => {
    editingTextIdRef.current = editingTextId;
  }, [editingTextId]);

  // Load board data on mount
  useEffect(() => {
    if (!id) return;
    loadBoard();
  }, [id]);

  // Presence: join on mount, subscribe to updates, leave on unmount
  useEffect(() => {
    if (!id || !user) return;

    const displayName = userProfile?.displayName ?? user.email ?? "User";
    const email = userProfile?.email ?? user.email ?? "";

    presenceService
      .joinBoard(id, user.uid, displayName, email)
      .catch((e) => captureException(e, { op: "board.joinPresence" }));

    const unsubscribe = presenceService.subscribeToBoardPresence(id, setPresence);

    return () => {
      unsubscribe();
      presenceService
        .leaveBoard(id, user.uid)
        .catch((e) => captureException(e, { op: "board.leavePresence" }));
    };
  }, [id, user]);

  // Load blocked IDs on mount
  useEffect(() => {
    if (!user) return;
    friendService
      .getBlockedIds(user.uid)
      .then(setBlockedIds)
      .catch((e) => captureException(e, { op: "board.getBlockedIds" }));
  }, [user]);

  // Real-time subscriptions for board content
  useEffect(() => {
    if (!id) return;
    // Reporting sync state from the paths listener (always active on a board)
    // drives the offline/syncing banner without a second listener.
    return pathService.subscribeToBoardPaths(
      id,
      (incoming) => {
        setPaths(incoming);
        setCanvasReady(true);
      },
      reportSyncState
    );
  }, [id]);

  // Phase 7 cold-load fast path: if a snapshot exists, paint from snapshot + the
  // strokes drawn since its watermark (one snapshot read + a small delta) instead of
  // waiting on the full-collection listener to stream every doc. The realtime listener
  // above stays authoritative and reconciles to identical content. When no snapshot
  // exists we skip — the listener already does the only initial read.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await snapshotService.getLatestSnapshot(id);
        if (cancelled) return;
        if (snap) {
          lastSnapshotCountRef.current = snap.pathCount;
          // Reuse the snapshot we just read instead of re-fetching it inside loadBoardState.
          const initial = await snapshotService.loadBoardState(id, snap);
          if (cancelled) return;
          // Only seed if the listener hasn't already populated, to avoid clobbering it.
          setPaths((prev) => (prev.length === 0 ? initial : prev));
          setCanvasReady(true);
        }
      } catch (e) {
        captureException(e, { op: "board.coldLoad" });
      } finally {
        // Baseline is established (count from the snapshot, or 0 when none exists)
        // — only now may the checkpoint trigger fire.
        if (!cancelled) snapshotBaselineReadyRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Phase 7 trigger: once a full interval of strokes has accrued past the last
  // snapshot, compact the current path set into a new checkpoint. Guarded so the
  // write fires once per threshold crossing. Non-destructive — old path docs stay
  // (live-listener correctness); pruning is deferred to M5 (see snapshotService).
  useEffect(() => {
    if (!id || !snapshotBaselineReadyRef.current || snapshotInFlightRef.current) return;
    if (!snapshotService.shouldSnapshot(paths.length, lastSnapshotCountRef.current)) return;
    snapshotInFlightRef.current = true;
    const captured = paths;
    snapshotService
      .createSnapshot(id, captured)
      .then(() => {
        lastSnapshotCountRef.current = captured.length;
      })
      .catch((e) => captureException(e, { op: "board.createSnapshot" }))
      .finally(() => {
        snapshotInFlightRef.current = false;
      });
  }, [paths, id]);

  useEffect(() => {
    if (!id) return;
    return pathService.subscribeToBoardNotes(id, setNotes);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    return shapeService.subscribeToBoardShapes(id, setShapes);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    return imageService.subscribeToBoardImages(id, setImages);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    return pathService.subscribeToBoardTextElements(id, (incoming) => {
      // Don't overwrite a text element the local user is actively typing in
      setTextElements((prev) => {
        if (!editingTextIdRef.current) return incoming;
        return incoming.map((el) =>
          el.id === editingTextIdRef.current
            ? (prev.find((p) => p.id === editingTextIdRef.current) ?? el)
            : el
        );
      });
    });
  }, [id]);

  // Clear debounce timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const loadBoard = async () => {
    try {
      setLoading(true);
      const boardData = await boardService.getBoard(id!);

      if (!boardData) {
        Alert.alert("Not Found", "This board no longer exists.");
        goBack();
        return;
      }

      setBoard(boardData);

      // Deep-link gate: if the viewer isn't a member yet, prompt them to join
      if (user && !boardData.members.includes(user.uid)) {
        setDeepLinkCode(boardData.inviteCode);
        setJoinModalVisible(true);
      }
    } catch {
      Alert.alert("Error", "Failed to load board");
    } finally {
      setLoading(false);
    }
  };

  // Find an admin-owned active session for this board.
  // Use the user-scoped query (rules-compatible) and filter client-side by board.
  const refreshActiveSession = useCallback(async () => {
    if (!id || !user) return;
    try {
      const sessions = await sessionService.getSessionsForUser(user.uid);
      const mine = sessions.find(
        (s) =>
          s.boardId === id &&
          s.status === "active" &&
          s.createdById === user.uid
      );
      setActiveSession(mine ?? null);
    } catch (err) {
      console.warn("[board] refreshActiveSession failed:", err);
    }
  }, [id, user]);

  useEffect(() => {
    refreshActiveSession();
  }, [refreshActiveSession]);

  const handleEndSession = async () => {
    if (!activeSession) return;
    setEndingSession(true);
    try {
      let svgEl: SVGSVGElement | null = null;
      const ref: any = canvasSvgRef.current;
      if (ref) {
        // react-native-svg on web exposes the DOM node in different shapes by version
        if (ref.tagName === "svg") svgEl = ref;
        else if (ref.elementRef?.current?.tagName === "svg")
          svgEl = ref.elementRef.current;
        else if (ref._touchableNode?.tagName === "svg") svgEl = ref._touchableNode;
        else if (typeof ref.querySelector === "function")
          svgEl = ref.querySelector("svg");
      }
      if (!svgEl && Platform.OS === "web" && typeof document !== "undefined") {
        // Last-ditch: there should only be one SVG inside the canvas container
        svgEl = document.querySelector(
          ".canvas-container svg, [data-canvas] svg, svg"
        ) as SVGSVGElement | null;
      }
      const snapshot = await captureSvgAsPng(svgEl);
      console.log(
        "[end-session] svgEl=",
        svgEl?.tagName,
        "snapshot=",
        snapshot ? `${Math.round(snapshot.length / 1024)}KB` : "null"
      );
      if (snapshot) {
        try {
          await sessionService.updateSessionSnapshot(activeSession.id, snapshot);
          console.log("[end-session] snapshot saved to", activeSession.id);
        } catch (err) {
          console.warn("[end-session] snapshot upload failed:", err);
        }
      }
      await sessionService.updateSessionStatus(activeSession.id, "ended");
      setActiveSession(null);
      showSaveToast();
    } catch {
      setErrorMessage("Failed to end session.");
    } finally {
      setEndingSession(false);
    }
  };

  // Debounced save — updates the board's updatedAt timestamp
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await boardService.updateBoard(id!, {});
      } catch {
        // Silent fail for timestamp update
      }
    }, 2000);
  }, [id]);

  // --- Share action ---

  const handleShare = () => {
    setShareBoardModalVisible(true);
  };

  const handleMemberAdded = (uid: string) => {
    if (uid && board) {
      setBoard((prev) =>
        prev ? { ...prev, members: [...new Set([...prev.members, uid])] } : prev
      );
    }
  };

  // Phase 12: change the board's background template. Optimistic local patch +
  // persist (the board doc isn't subscribed, mirroring title/admin — remote
  // members pick up the change on their next load).
  const handleSelectBackground = (template: BackgroundTemplate) => {
    setBoard((prev) => (prev ? { ...prev, backgroundTemplate: template } : prev));
    boardService
      .updateBoard(id!, { backgroundTemplate: template })
      .catch((e) => {
        captureException(e, { op: "board.setBackground" });
        setErrorMessage("Failed to change background.");
      });
  };

  // --- Deep-link join callback ---

  const handleDeepLinkJoined = () => {
    setJoinModalVisible(false);
    setDeepLinkCode(undefined);
    // Reload so the members array and content reflect the new membership
    loadBoard();
  };

  const handleDeepLinkCancel = () => {
    setJoinModalVisible(false);
    setDeepLinkCode(undefined);
    goBack();
  };

  // --- Drawing handlers ---

  // Only pen and eraser produce live strokes; text/select route through taps.
  const isDrawingTool = activeTool === "pen" || activeTool === "eraser";

  // Build an in-progress shape draft from the drag's two board-space corners,
  // applying snap-to-grid, shift-constrain, and smart-guide edge alignment.
  const buildDraft = (start: Point, end: Point): ShapeDraft => {
    const cfg = shapeCfgRef.current;
    const fillable = cfg.kind === "rect" || cfg.kind === "ellipse" || cfg.kind === "triangle";
    const geom =
      cfg.kind === "line" || cfg.kind === "arrow"
        ? { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y }
        : rectFromPoints(start, end);
    return {
      shape: cfg.kind,
      ...geom,
      rotation: 0,
      fill: fillable && cfg.fill ? hexToRgba(cfg.color, SHAPE_FILL_ALPHA) : "none",
      stroke: cfg.color,
      strokeWidth: cfg.strokeWidth,
      dashed: cfg.dashed,
      arrowheadStart: "none",
      arrowheadEnd: cfg.kind === "arrow" ? cfg.arrowheadEnd : "none",
    };
  };

  const handleStrokeStart = () => {
    if (activeTool === "select") {
      // A select-mode drag resolves to a group move or a marquee on the first
      // move, once we know where it started relative to the selection.
      selectGestureRef.current = {
        mode: "pending",
        start: null,
        offset: { dx: 0, dy: 0 },
        baseIds: [],
      };
      setMarquee(null);
      setDragOffset(null);
      return;
    }
    if (activeTool === "shape") {
      shapeStartRef.current = null;
      shapeDraftRef.current = null;
      setShapeDraft(null);
      setGuides([]);
      return;
    }
    if (!isDrawingTool) return;
    lastSampleRef.current = 0; // first move of a new stroke always records
    if (activeTool === "eraser") erasedIdsRef.current = new Set();
    setCurrentPoints([]);
  };

  const handleStrokeMove = (point: { x: number; y: number }) => {
    if (activeTool === "select") {
      const g = selectGestureRef.current;
      if (g.mode === "pending") {
        g.start = point;
        const hit = hitTestAny(point);
        if (hit && selection.isSelected(hit.id)) {
          g.mode = "move";
        } else if (hit) {
          // Drag began on an unselected element: grab it (shift adds), then move.
          if (shiftHeldRef.current) selection.toggle(hit.id);
          else selection.select(hit.id);
          setEditingTextId(null);
          g.mode = "move";
        } else {
          // Empty canvas → rubber-band. Shift keeps the prior selection as a base.
          g.mode = "marquee";
          g.baseIds = shiftHeldRef.current ? [...selection.selectedIds] : [];
          if (!shiftHeldRef.current) selection.clear();
        }
        return;
      }
      if (g.mode === "move" && g.start) {
        const off = { dx: point.x - g.start.x, dy: point.y - g.start.y };
        g.offset = off;
        setDragOffset(off);
        return;
      }
      if (g.mode === "marquee" && g.start) {
        const box = marqueeBounds(g.start, point);
        setMarquee(box);
        const hits = queryBounds(spatialIndexRef.current, box).map((e) => e.id);
        selection.setMany(g.baseIds.length ? [...g.baseIds, ...hits] : hits, "region");
        return;
      }
      return;
    }
    if (activeTool === "shape") {
      const cfg = shapeCfgRef.current;
      // First move of the drag fixes the start corner (snapped if grid is on).
      if (!shapeStartRef.current) {
        shapeStartRef.current = cfg.snapGrid > 0 ? snapPoint(point, cfg.snapGrid) : point;
        return;
      }
      const start = shapeStartRef.current;
      let end = cfg.snapGrid > 0 ? snapPoint(point, cfg.snapGrid) : point;
      if (shiftHeldRef.current) end = constrainDraft(cfg.kind, start, end);
      let draft = buildDraft(start, end);
      // Smart guides: align the draft's box to nearby shapes (8px tolerance).
      const targets = visibleShapesRef.current.map((s) => s.bbox ?? shapeBbox(s));
      const g = computeGuides(shapeBbox(draft), targets, GUIDE_TOLERANCE);
      if (g.dx || g.dy) draft = buildDraft(start, { x: end.x + g.dx, y: end.y + g.dy });
      shapeDraftRef.current = draft;
      setShapeDraft(draft);
      setGuides(g.guides);
      return;
    }
    if (!isDrawingTool) return;
    // Coalesce gesture frames to ~30Hz: cap how many points enter the stroke so
    // the write payload and JS work scale with stroke length, not frame rate.
    // The live render stays smooth — 30Hz is well above the perceptible floor.
    const now = Date.now();
    if (now - lastSampleRef.current < STROKE_SAMPLE_MS) return;
    lastSampleRef.current = now;
    if (activeTool === "eraser") eraseAtPoint(point);
    setCurrentPoints((prev) => (prev ? [...prev, point] : [point]));
  };

  const handleStrokeEnd = async () => {
    if (activeTool === "select") {
      const g = selectGestureRef.current;
      const { dx, dy } = g.offset;
      selectGestureRef.current = { mode: "idle", start: null, offset: { dx: 0, dy: 0 }, baseIds: [] };
      setMarquee(null);
      if (g.mode === "move") {
        // Clear the live offset and commit the final positions in the same tick
        // so the elements never flash back to their pre-drag spot.
        setDragOffset(null);
        if (dx !== 0 || dy !== 0) await commitMove(dx, dy);
      }
      return;
    }
    if (activeTool === "shape") {
      const draft = shapeDraftRef.current;
      shapeStartRef.current = null;
      shapeDraftRef.current = null;
      setShapeDraft(null);
      setGuides([]);
      // Discard a stray tap / near-zero drag.
      if (!draft || (Math.abs(draft.width) < MIN_SHAPE_SIZE && Math.abs(draft.height) < MIN_SHAPE_SIZE)) {
        return;
      }
      const newShape: Omit<ShapeElement, "id" | "createdAt" | "bbox"> = {
        boardId: id!,
        userId: user?.uid ?? "",
        ...draft,
      };
      try {
        await shapeService.saveShape(id!, newShape);
        scheduleSave();
      } catch (e) {
        captureException(e, { op: "board.saveShape" });
        setErrorMessage("Failed to save shape.");
      }
      return;
    }
    if (!isDrawingTool) return;
    // Real eraser: deletion happened incrementally in handleStrokeMove; the
    // stroke itself is never persisted (the old white-paint behavior is gone).
    if (activeTool === "eraser") {
      erasedIdsRef.current = new Set();
      setCurrentPoints(null);
      return;
    }
    if (!currentPoints || currentPoints.length === 0) {
      setCurrentPoints(null);
      return;
    }

    // RDP-simplify in board-space before the write: fewer points = smaller doc,
    // cheaper sync, and lighter render — without a visible change to the stroke.
    const simplified = rdpSimplify(currentPoints, RDP_TOLERANCE);

    const newPath: Omit<DrawPath, "id" | "createdAt"> = {
      boardId: id!,
      userId: user?.uid ?? "",
      points: simplified,
      color: activeColor,
      strokeWidth: activeStrokeWidth,
      tool: "pen",
    };

    try {
      await pathService.savePath(id!, newPath);
      setRedoStack([]);
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to save stroke");
    }

    setCurrentPoints(null);
  };

  // --- Eraser: board-space hit-test → delete intersected strokes ---

  // Delete every not-yet-erased stroke whose geometry comes within the eraser
  // radius of `point`. Optimistic local removal keeps the UI responsive; the
  // Firestore subscription confirms (or, on failure, restores) the deletion.
  const eraseAtPoint = (point: Point) => {
    const radius = (activeStrokeWidth + ERASER_PAD) / 2;
    const hits: string[] = [];
    for (const p of visiblePathsRef.current) {
      if (erasedIdsRef.current.has(p.id)) continue;
      const reach = radius + p.strokeWidth / 2;
      // Broad-phase: skip strokes whose (inflated) bbox can't contain the point.
      if (p.bbox && !boundsContainPoint(p.bbox, point, reach)) continue;
      // Narrow-phase: actual distance to the polyline.
      if (pointNearPolyline(p.points, point, reach)) {
        hits.push(p.id);
        erasedIdsRef.current.add(p.id);
      }
    }
    if (hits.length === 0) return;
    setPaths((prev) => prev.filter((p) => !hits.includes(p.id)));
    hits.forEach((h) => selection.remove(h));
    hits.forEach((pathId) => {
      pathService.deletePath(id!, pathId).catch((e) => {
        captureException(e, { op: "board.erase" });
        setErrorMessage("Some strokes couldn't be erased.");
      });
    });
    scheduleSave();
  };

  // --- Selection: tap a stroke to select it (topmost wins) ---

  // Board-space hit-test for a shape: fill-type shapes use bbox containment;
  // line/arrow use distance to the segment (their box is mostly empty).
  const hitTestShape = (s: ShapeElement, point: Point): boolean => {
    const reach = SELECT_TAP_PADDING + s.strokeWidth / 2;
    if (s.shape === "line" || s.shape === "arrow") {
      return (
        distanceToSegment(point, { x: s.x, y: s.y }, { x: s.x + s.width, y: s.y + s.height }) <=
        reach
      );
    }
    const box = s.bbox ?? shapeBbox(s);
    return boundsContainPoint(box, point, SELECT_TAP_PADDING);
  };

  // Topmost element under a board-space point, across all kinds. Text and shapes
  // render above strokes, so they win ties; within a kind the newest/highest-z
  // (end of the z-sorted array) wins.
  const hitTestAny = (point: Point): { id: string; kind: ElementKind } | null => {
    for (let i = visibleTextElementsRef.current.length - 1; i >= 0; i--) {
      const el = visibleTextElementsRef.current[i];
      if (boundsContainPoint(textBox(el), point, SELECT_TAP_PADDING)) {
        return { id: el.id, kind: "text" };
      }
    }
    for (let i = visibleShapesRef.current.length - 1; i >= 0; i--) {
      const s = visibleShapesRef.current[i];
      if (hitTestShape(s, point)) return { id: s.id, kind: "shape" };
    }
    for (let i = visiblePathsRef.current.length - 1; i >= 0; i--) {
      const p = visiblePathsRef.current[i];
      const reach = SELECT_TAP_PADDING + p.strokeWidth / 2;
      if (p.bbox && !boundsContainPoint(p.bbox, point, reach)) continue;
      if (pointNearPolyline(p.points, point, reach)) return { id: p.id, kind: "path" };
    }
    // Images render beneath every other kind, so they're the last-resort hit.
    for (let i = visibleImagesRef.current.length - 1; i >= 0; i--) {
      const img = visibleImagesRef.current[i];
      if (boundsContainPoint(img.bbox ?? imageBbox(img), point, SELECT_TAP_PADDING)) {
        return { id: img.id, kind: "image" };
      }
    }
    return null;
  };

  // Tap in select mode: hit-test the topmost element. Shift toggles it in/out of
  // the selection; a plain tap replaces the selection (or clears on empty).
  const selectAtPoint = (point: Point, additive: boolean) => {
    const hit = hitTestAny(point);
    if (!hit) {
      if (!additive) selection.clear();
      setEditingTextId(null);
      return;
    }
    if (additive) selection.toggle(hit.id);
    else selection.select(hit.id);
    if (hit.kind !== "text") setEditingTextId(null);
  };

  // Resolve the per-element field deltas for a group translate and commit them
  // (optimistic local update + one batch write per collection).
  const commitMove = async (dx: number, dy: number) => {
    const ids = selection.selectedIds;
    if (ids.size === 0 || (dx === 0 && dy === 0)) return;

    const pathUpdates: { id: string; data: any }[] = [];
    const shapeUpdates: { id: string; data: any }[] = [];
    const textUpdates: { id: string; data: any }[] = [];
    const imageUpdates: { id: string; data: any }[] = [];

    // Compute from current state (not inside a setState updater, which can run
    // twice and double-enqueue the batch). The move drag never mutated these
    // arrays — it used the live offset — so `paths`/`shapes`/`textElements` here
    // are the authoritative pre-move positions.
    const nextPaths = paths.map((p) => {
      if (!ids.has(p.id)) return p;
      const points = translatePoints(p.points, dx, dy);
      const bbox = p.bbox ? translateBounds(p.bbox, dx, dy) : undefined;
      pathUpdates.push({ id: p.id, data: { points, ...(bbox ? { bbox } : {}) } });
      return { ...p, points, bbox };
    });
    const nextShapes = shapes.map((s) => {
      if (!ids.has(s.id)) return s;
      const x = s.x + dx;
      const y = s.y + dy;
      const bbox = s.bbox ? translateBounds(s.bbox, dx, dy) : shapeBbox({ ...s, x, y });
      shapeUpdates.push({ id: s.id, data: { x, y, bbox } });
      return { ...s, x, y, bbox };
    });
    const nextText = textElements.map((el) => {
      if (!ids.has(el.id)) return el;
      const position = { x: el.position.x + dx, y: el.position.y + dy };
      textUpdates.push({ id: el.id, data: { position } });
      return { ...el, position };
    });
    const nextImages = images.map((img) => {
      if (!ids.has(img.id)) return img;
      const x = img.x + dx;
      const y = img.y + dy;
      const bbox = img.bbox ? translateBounds(img.bbox, dx, dy) : imageBbox({ ...img, x, y });
      imageUpdates.push({ id: img.id, data: { x, y, bbox } });
      return { ...img, x, y, bbox };
    });
    setPaths(nextPaths);
    setShapes(nextShapes);
    setTextElements(nextText);
    setImages(nextImages);

    try {
      await Promise.all([
        pathService.batchUpdatePaths(id!, pathUpdates),
        shapeService.batchUpdateShapes(id!, shapeUpdates),
        pathService.batchUpdateTextElements(id!, textUpdates),
        imageService.batchUpdateImages(id!, imageUpdates),
      ]);
      scheduleSave();
    } catch (e) {
      captureException(e, { op: "board.moveSelection" });
      setErrorMessage("Failed to move some elements.");
    }
  };

  const { clear: clearSelection } = selection;
  const handleDeleteSelected = useCallback(async () => {
    const ids = [...selection.selectedIds];
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const shapeIds = visibleShapesRef.current.filter((s) => idSet.has(s.id)).map((s) => s.id);
    const textIds = visibleTextElementsRef.current.filter((el) => idSet.has(el.id)).map((el) => el.id);
    const imageIds = visibleImagesRef.current.filter((img) => idSet.has(img.id)).map((img) => img.id);
    const pathIds = ids.filter(
      (i) => !shapeIds.includes(i) && !textIds.includes(i) && !imageIds.includes(i)
    );
    clearSelection();
    setEditingTextId(null);
    setShapes((prev) => prev.filter((s) => !idSet.has(s.id)));
    setTextElements((prev) => prev.filter((el) => !idSet.has(el.id)));
    setImages((prev) => prev.filter((img) => !idSet.has(img.id)));
    setPaths((prev) => prev.filter((p) => !idSet.has(p.id)));
    try {
      await Promise.all([
        pathService.batchDeletePaths(id!, pathIds),
        shapeService.batchDeleteShapes(id!, shapeIds),
        pathService.batchDeleteTextElements(id!, textIds),
        imageService.batchDeleteImages(id!, imageIds),
      ]);
      scheduleSave();
    } catch (e) {
      captureException(e, { op: "board.deleteSelected" });
      setErrorMessage("Failed to delete some elements.");
    }
  }, [id, selection.selectedIds, clearSelection, scheduleSave]);

  // Duplicate the selection 16px down-right; the copies become the new selection.
  const handleDuplicateSelected = useCallback(async () => {
    const ids = selection.selectedIds;
    if (ids.size === 0) return;
    const off = DUPLICATE_OFFSET;
    const newIds: string[] = [];
    const tasks: Promise<void>[] = [];
    for (const p of paths) {
      if (!ids.has(p.id)) continue;
      const { id: _i, createdAt: _c, ...rest } = p;
      tasks.push(
        pathService
          .savePath(id!, { ...rest, points: translatePoints(p.points, off, off) })
          .then((nid) => {
            newIds.push(nid);
          })
      );
    }
    for (const s of shapes) {
      if (!ids.has(s.id)) continue;
      const { id: _i, createdAt: _c, bbox: _b, ...rest } = s;
      tasks.push(
        shapeService.saveShape(id!, { ...rest, x: s.x + off, y: s.y + off }).then((nid) => {
          newIds.push(nid);
        })
      );
    }
    for (const el of textElements) {
      if (!ids.has(el.id)) continue;
      const { id: _i, createdAt: _c, ...rest } = el;
      tasks.push(
        pathService
          .saveTextElement(id!, {
            ...rest,
            position: { x: el.position.x + off, y: el.position.y + off },
          })
          .then((nid) => {
            newIds.push(nid);
          })
      );
    }
    for (const img of images) {
      if (!ids.has(img.id)) continue;
      const { id: _i, createdAt: _c, bbox: _b, ...rest } = img;
      tasks.push(
        imageService.saveImage(id!, { ...rest, x: img.x + off, y: img.y + off }).then((nid) => {
          newIds.push(nid);
        })
      );
    }
    try {
      await Promise.all(tasks);
      selection.setMany(newIds, "elements");
      setEditingTextId(null);
      scheduleSave();
    } catch (e) {
      captureException(e, { op: "board.duplicate" });
      setErrorMessage("Failed to duplicate selection.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, selection.selectedIds, selection.setMany, paths, shapes, textElements, images, scheduleSave]);

  // --- Phase 10: clipboard (copy / paste) ---

  // Copy the current selection into the in-app clipboard store, stripping
  // identity so paste can re-stamp the destination board + pasting user. The
  // store is module-level, so the payload survives navigating to another board.
  const handleCopySelected = useCallback(() => {
    const ids = selection.selectedIds;
    if (ids.size === 0) return;
    const items: ClipItem[] = [];
    for (const p of paths) {
      if (!ids.has(p.id)) continue;
      const { id: _i, createdAt: _c, boardId: _b, userId: _u, ...rest } = p;
      items.push({ kind: "path", data: rest });
    }
    for (const s of shapes) {
      if (!ids.has(s.id)) continue;
      const { id: _i, createdAt: _c, boardId: _b, userId: _u, bbox: _bb, ...rest } = s;
      items.push({ kind: "shape", data: rest });
    }
    for (const el of textElements) {
      if (!ids.has(el.id)) continue;
      const { id: _i, createdAt: _c, boardId: _b, userId: _u, ...rest } = el;
      items.push({ kind: "text", data: rest });
    }
    for (const img of images) {
      if (!ids.has(img.id)) continue;
      // Image bytes are NOT re-copied: the payload keeps the source storage
      // paths + download URLs, so paste reuses them (no re-upload), matching the
      // duplicate behavior. Cross-board paste references the source board's
      // Storage object — deleting that board would orphan the pasted image.
      const { id: _i, createdAt: _c, boardId: _b, userId: _u, bbox: _bb, ...rest } = img;
      items.push({ kind: "image", data: rest });
    }
    setClipboard(items);
  }, [selection.selectedIds, paths, shapes, textElements, images]);

  // Paste the clipboard onto the *current* board (cross-board safe): re-stamp
  // boardId + the pasting user, cascade the offset down-right, and select the
  // new copies. Images reuse the source Storage objects via saveImage.
  const handlePasteClipboard = useCallback(async () => {
    const items = getClipboard();
    if (items.length === 0) return;
    const d = nextPasteOffset();
    const uid = user?.uid ?? "";
    const newIds: string[] = [];
    const tasks: Promise<void>[] = [];
    for (const item of items) {
      const off = offsetClipItem(item, d);
      if (off.kind === "path") {
        tasks.push(
          pathService
            .savePath(id!, { ...off.data, boardId: id!, userId: uid })
            .then((nid) => {
              newIds.push(nid);
            })
        );
      } else if (off.kind === "shape") {
        tasks.push(
          shapeService
            .saveShape(id!, { ...off.data, boardId: id!, userId: uid })
            .then((nid) => {
              newIds.push(nid);
            })
        );
      } else if (off.kind === "text") {
        tasks.push(
          pathService
            .saveTextElement(id!, { ...off.data, boardId: id!, userId: uid })
            .then((nid) => {
              newIds.push(nid);
            })
        );
      } else {
        tasks.push(
          imageService
            .saveImage(id!, { ...off.data, boardId: id!, userId: uid })
            .then((nid) => {
              newIds.push(nid);
            })
        );
      }
    }
    try {
      await Promise.all(tasks);
      setActiveTool("select");
      selection.setMany(newIds, "elements");
      setEditingTextId(null);
      scheduleSave();
    } catch (e) {
      captureException(e, { op: "board.paste" });
      setErrorMessage("Failed to paste.");
    }
    // selection methods are stable (useCallback in the slice); listing setMany.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user, selection.setMany, scheduleSave]);

  // Web: an image on the system clipboard (a screenshot / copied photo) lands as
  // a first-class image element through the same downscale → upload pipeline as
  // the toolbar picker (Phase 9).
  const pasteExternalImage = useCallback(
    async (file: Blob & { name?: string }) => {
      if (insertingImage) return;
      setInsertingImage(true);
      try {
        const prepared = await prepareWebFile(file);
        await uploadPreparedImage(prepared);
      } catch (e) {
        captureException(e, { op: "board.pasteImage" });
        setErrorMessage("Failed to paste image.");
      } finally {
        setInsertingImage(false);
      }
    },
    // uploadPreparedImage closes over the live viewport/canvas/id — intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [insertingImage, viewport, canvasSize, id, user]
  );

  const reorderSelected = async (dir: "front" | "back") => {
    const ids = selection.selectedIds;
    if (ids.size === 0) return;
    const pathPlan = planZOrder(paths, ids, dir);
    const shapePlan = planZOrder(shapes, ids, dir);
    const textPlan = planZOrder(textElements, ids, dir);
    const imagePlan = planZOrder(images, ids, dir);
    const zMap = (plan: { id: string; z: number }[]) => new Map(plan.map((p) => [p.id, p.z]));
    const pm = zMap(pathPlan);
    const sm = zMap(shapePlan);
    const tm = zMap(textPlan);
    const im = zMap(imagePlan);
    setPaths((prev) => prev.map((p) => (pm.has(p.id) ? { ...p, z: pm.get(p.id) } : p)));
    setShapes((prev) => prev.map((s) => (sm.has(s.id) ? { ...s, z: sm.get(s.id) } : s)));
    setTextElements((prev) => prev.map((el) => (tm.has(el.id) ? { ...el, z: tm.get(el.id) } : el)));
    setImages((prev) => prev.map((img) => (im.has(img.id) ? { ...img, z: im.get(img.id) } : img)));
    try {
      await Promise.all([
        pathService.batchUpdatePaths(id!, pathPlan.map((p) => ({ id: p.id, data: { z: p.z } }))),
        shapeService.batchUpdateShapes(id!, shapePlan.map((p) => ({ id: p.id, data: { z: p.z } }))),
        pathService.batchUpdateTextElements(id!, textPlan.map((p) => ({ id: p.id, data: { z: p.z } }))),
        imageService.batchUpdateImages(id!, imagePlan.map((p) => ({ id: p.id, data: { z: p.z } }))),
      ]);
      scheduleSave();
    } catch (e) {
      captureException(e, { op: "board.reorder" });
      setErrorMessage("Failed to reorder selection.");
    }
  };

  const handleBringToFront = () => reorderSelected("front");
  const handleSendToBack = () => reorderSelected("back");

  // --- Pass 2: resize / rotate handle drags ---

  const handleTransformStart = (h: HandleId) => {
    const u = selectionUnion;
    if (!u) return;
    const center = { x: (u.minX + u.maxX) / 2, y: (u.minY + u.maxY) / 2 };
    transformGestureRef.current = { handle: h, union: u, center, last: null };
    setMarquee(null);
  };

  const handleTransformMove = (h: HandleId, dx: number, dy: number) => {
    const g = transformGestureRef.current;
    if (!g) return;
    const u = g.union;
    if (h === "rotate") {
      const off = ROTATE_HANDLE_OFFSET / (viewport.scale || 1);
      const startPt = { x: g.center.x, y: u.minY - off };
      const pointer = { x: startPt.x + dx, y: startPt.y + dy };
      const a0 = Math.atan2(startPt.y - g.center.y, startPt.x - g.center.x);
      const a1 = Math.atan2(pointer.y - g.center.y, pointer.x - g.center.x);
      const theta = a1 - a0;
      g.last = { mode: "rotate", center: g.center, theta };
      setTransformPreview({ mode: "rotate", center: g.center, theta });
      return;
    }
    const startPt = handleStartPoint(h, u);
    const anchor = anchorPoint(h, u);
    const pointer = { x: startPt.x + dx, y: startPt.y + dy };
    const ow = u.maxX - u.minX;
    const oh = u.maxY - u.minY;
    let sx = 1;
    let sy = 1;
    if (handleInvolvesX(h)) sx = ow > 0 ? Math.abs(pointer.x - anchor.x) / ow : 1;
    if (handleInvolvesY(h)) sy = oh > 0 ? Math.abs(pointer.y - anchor.y) / oh : 1;
    // Corner handles scale uniformly unless Alt is held (web).
    if (isCornerHandle(h) && !altHeldRef.current) {
      const s = Math.max(sx, sy);
      sx = s;
      sy = s;
    }
    sx = Math.max(MIN_SCALE_FACTOR, sx);
    sy = Math.max(MIN_SCALE_FACTOR, sy);
    g.last = { mode: "resize", anchor, sx, sy };
    setTransformPreview({ mode: "resize", anchor, sx, sy, bounds: scaleBoundsAbout(u, anchor, sx, sy) });
  };

  const handleTransformEnd = async () => {
    const g = transformGestureRef.current;
    transformGestureRef.current = null;
    setTransformPreview(null);
    const last = g?.last;
    if (!last) return;
    if (last.mode === "resize") await commitResize(last.anchor, last.sx, last.sy);
    else await commitRotate(last.center, last.theta);
  };

  // Bake a uniform/non-uniform scale (about `anchor`) into every selected element.
  const commitResize = async (anchor: Point, sx: number, sy: number) => {
    const ids = selection.selectedIds;
    if (ids.size === 0 || (sx === 1 && sy === 1)) return;
    const pathUpdates: { id: string; data: any }[] = [];
    const shapeUpdates: { id: string; data: any }[] = [];
    const textUpdates: { id: string; data: any }[] = [];
    const imageUpdates: { id: string; data: any }[] = [];
    const nextPaths = paths.map((p) => {
      if (!ids.has(p.id)) return p;
      const points = p.points.map((pt) => scalePointAbout(pt, anchor, sx, sy));
      const base = boundsOfPoints(points);
      const rendered = p.tool === "eraser" ? p.strokeWidth + 10 : p.strokeWidth;
      const bbox = base ? inflateBounds(base, rendered / 2) : p.bbox;
      pathUpdates.push({ id: p.id, data: { points, ...(bbox ? { bbox } : {}) } });
      return { ...p, points, bbox };
    });
    const nextShapes = shapes.map((s) => {
      if (!ids.has(s.id)) return s;
      const np = scalePointAbout({ x: s.x, y: s.y }, anchor, sx, sy);
      const width = s.width * sx;
      const height = s.height * sy;
      const moved = { ...s, x: np.x, y: np.y, width, height };
      const bbox = shapeBbox(moved);
      shapeUpdates.push({ id: s.id, data: { x: np.x, y: np.y, width, height, bbox } });
      return { ...moved, bbox };
    });
    const nextText = textElements.map((el) => {
      if (!ids.has(el.id)) return el;
      const position = scalePointAbout(el.position, anchor, sx, sy);
      const width = el.width * sx;
      const height = el.height * sy;
      const fontSize = Math.max(1, Math.round(el.fontSize * sy));
      textUpdates.push({ id: el.id, data: { position, width, height, fontSize } });
      return { ...el, position, width, height, fontSize };
    });
    const nextImages = images.map((img) => {
      if (!ids.has(img.id)) return img;
      const np = scalePointAbout({ x: img.x, y: img.y }, anchor, sx, sy);
      const width = img.width * sx;
      const height = img.height * sy;
      const moved = { ...img, x: np.x, y: np.y, width, height };
      const bbox = imageBbox(moved);
      imageUpdates.push({ id: img.id, data: { x: np.x, y: np.y, width, height, bbox } });
      return { ...moved, bbox };
    });
    setPaths(nextPaths);
    setShapes(nextShapes);
    setTextElements(nextText);
    setImages(nextImages);
    try {
      await Promise.all([
        pathService.batchUpdatePaths(id!, pathUpdates),
        shapeService.batchUpdateShapes(id!, shapeUpdates),
        pathService.batchUpdateTextElements(id!, textUpdates),
        imageService.batchUpdateImages(id!, imageUpdates),
      ]);
      scheduleSave();
    } catch (e) {
      captureException(e, { op: "board.resizeSelection" });
      setErrorMessage("Failed to resize some elements.");
    }
  };

  // Bake a rotation (radians, about `center`) into every selected element.
  const commitRotate = async (center: Point, theta: number) => {
    const ids = selection.selectedIds;
    if (ids.size === 0 || theta === 0) return;
    const deg = (theta * 180) / Math.PI;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const pathUpdates: { id: string; data: any }[] = [];
    const shapeUpdates: { id: string; data: any }[] = [];
    const textUpdates: { id: string; data: any }[] = [];
    const imageUpdates: { id: string; data: any }[] = [];
    const nextPaths = paths.map((p) => {
      if (!ids.has(p.id)) return p;
      const points = p.points.map((pt) => rotatePointAbout(pt, center, theta));
      const base = boundsOfPoints(points);
      const rendered = p.tool === "eraser" ? p.strokeWidth + 10 : p.strokeWidth;
      const bbox = base ? inflateBounds(base, rendered / 2) : p.bbox;
      pathUpdates.push({ id: p.id, data: { points, ...(bbox ? { bbox } : {}) } });
      return { ...p, points, bbox };
    });
    const nextShapes = shapes.map((s) => {
      if (!ids.has(s.id)) return s;
      let moved: ShapeElement;
      if (s.shape === "line" || s.shape === "arrow") {
        // Lines render from (x,y) along (w,h) with no rotation field: rotate the
        // start point and the vector instead.
        const start = rotatePointAbout({ x: s.x, y: s.y }, center, theta);
        const width = s.width * cos - s.height * sin;
        const height = s.width * sin + s.height * cos;
        moved = { ...s, x: start.x, y: start.y, width, height };
      } else {
        // Box shapes: orbit the center about the group pivot and add to rotation.
        const oc = { x: s.x + s.width / 2, y: s.y + s.height / 2 };
        const nc = rotatePointAbout(oc, center, theta);
        moved = { ...s, x: nc.x - s.width / 2, y: nc.y - s.height / 2, rotation: (s.rotation ?? 0) + deg };
      }
      const bbox = shapeBbox(moved);
      const { id: _i, boardId: _b, userId: _u, createdAt: _c, bbox: _bb, ...rest } = moved;
      shapeUpdates.push({ id: s.id, data: { ...rest, bbox } });
      return { ...moved, bbox };
    });
    const nextText = textElements.map((el) => {
      if (!ids.has(el.id)) return el;
      const oc = { x: el.position.x + el.width / 2, y: el.position.y + el.height / 2 };
      const nc = rotatePointAbout(oc, center, theta);
      const position = { x: nc.x - el.width / 2, y: nc.y - el.height / 2 };
      const rotation = (el.rotation ?? 0) + deg;
      textUpdates.push({ id: el.id, data: { position, rotation } });
      return { ...el, position, rotation };
    });
    const nextImages = images.map((img) => {
      if (!ids.has(img.id)) return img;
      // Box-like: orbit the center about the group pivot, accumulate rotation.
      const oc = { x: img.x + img.width / 2, y: img.y + img.height / 2 };
      const nc = rotatePointAbout(oc, center, theta);
      const x = nc.x - img.width / 2;
      const y = nc.y - img.height / 2;
      const rotation = (img.rotation ?? 0) + deg;
      const moved = { ...img, x, y, rotation };
      const bbox = imageBbox(moved);
      imageUpdates.push({ id: img.id, data: { x, y, rotation, bbox } });
      return { ...moved, bbox };
    });
    setPaths(nextPaths);
    setShapes(nextShapes);
    setTextElements(nextText);
    setImages(nextImages);
    try {
      await Promise.all([
        pathService.batchUpdatePaths(id!, pathUpdates),
        shapeService.batchUpdateShapes(id!, shapeUpdates),
        pathService.batchUpdateTextElements(id!, textUpdates),
        imageService.batchUpdateImages(id!, imageUpdates),
      ]);
      scheduleSave();
    } catch (e) {
      captureException(e, { op: "board.rotateSelection" });
      setErrorMessage("Failed to rotate some elements.");
    }
  };

  // --- Canvas tap (point is board-space) ---

  const handleCanvasTap = (point: Point) => {
    if (activeTool === "hand") {
      // The Hand tool only pans; taps do nothing.
      return;
    }
    if (activeTool === "shape") {
      // Shapes require a drag to size them; a stray tap does nothing.
      return;
    }
    if (activeTool === "select") {
      selectAtPoint(point, shiftHeldRef.current);
      return;
    }
    if (activeTool === "text") {
      if (editingTextId || selection.count > 0) {
        // First tap on blank canvas deselects the active element
        setEditingTextId(null);
        selection.clear();
      } else {
        handleCreateTextElement(point);
      }
      return;
    }
    if (activeTool === "eraser") {
      // A stationary tap erases whatever is under it.
      erasedIdsRef.current = new Set();
      eraseAtPoint(point);
      erasedIdsRef.current = new Set();
      return;
    }
    // Pen: a stationary tap drops a single-point dot.
    handleDrawDot(point);
  };

  const handleDrawDot = async (point: Point) => {
    const dot: Omit<DrawPath, "id" | "createdAt"> = {
      boardId: id!,
      userId: user?.uid ?? "",
      points: [point],
      color: activeColor,
      strokeWidth: activeStrokeWidth,
      tool: "pen",
    };
    try {
      await pathService.savePath(id!, dot);
      setRedoStack([]);
      scheduleSave();
    } catch (e) {
      captureException(e, { op: "board.drawDot" });
      setErrorMessage("Failed to save.");
    }
  };

  // --- Text element handlers ---

  const handleCreateTextElement = async (point: Point) => {
    const DEFAULT_EL_WIDTH = 160;
    const DEFAULT_EL_HEIGHT = 52;
    // point is board-space; the board is unbounded, so no screen clamp.
    const newEl: Omit<TextElement, "id" | "createdAt"> = {
      boardId: id!,
      userId: user?.uid ?? "",
      text: "",
      position: {
        x: point.x - DEFAULT_EL_WIDTH / 2,
        y: point.y - DEFAULT_EL_HEIGHT / 2,
      },
      width: DEFAULT_EL_WIDTH,
      height: DEFAULT_EL_HEIGHT,
      fontSize: 20,
      color: activeColor,
    };
    try {
      const elId = await pathService.saveTextElement(id!, newEl);
      selection.select(elId);
      setEditingTextId(elId);
      scheduleSave();
    } catch {
      setErrorMessage("Failed to create text element.");
    }
  };

  const handleTextSelect = (elementId: string) => {
    // Shift-tap toggles membership (no inline edit); a plain tap selects + edits.
    if (shiftHeldRef.current) {
      selection.toggle(elementId);
      return;
    }
    selection.select(elementId);
    setEditingTextId(elementId);
  };

  const handleTextBlur = async (elementId: string, text: string) => {
    setEditingTextId(null);
    try {
      await pathService.updateTextElement(id!, elementId, { text });
      setTextElements((prev) =>
        prev.map((el) => (el.id === elementId ? { ...el, text } : el))
      );
      scheduleSave();
    } catch {
      setErrorMessage("Text save failed — changes may not persist.");
    }
  };

  const handleTextResize = async (
    elementId: string,
    width: number,
    height: number,
    fontSize: number
  ) => {
    try {
      await pathService.updateTextElement(id!, elementId, { width, height, fontSize });
      setTextElements((prev) =>
        prev.map((el) =>
          el.id === elementId ? { ...el, width, height, fontSize } : el
        )
      );
      scheduleSave();
    } catch {
      setErrorMessage("Resize save failed.");
    }
  };

  // --- Text note handlers ---

  const handleSubmitNote = async (content: string) => {
    if (!pendingNotePosition) return;

    const newNote: Omit<TextNote, "id" | "createdAt"> = {
      boardId: id!,
      userId: user?.uid ?? "",
      content,
      position: pendingNotePosition,
    };

    try {
      await pathService.saveTextNote(id!, newNote);
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to save note");
    }

    setPendingNotePosition(null);
  };

  const handleCancelNote = () => {
    setPendingNotePosition(null);
  };

  const handleDeleteNote = async (noteId: string) => {
    try {
      await pathService.deleteTextNote(id!, noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to delete note");
    }
  };

  // --- Toolbar actions ---

  const handleUndo = async () => {
    if (paths.length === 0) return;
    const targetPath = isAdmin
      ? paths[paths.length - 1]
      : [...paths].reverse().find((p) => p.userId === user?.uid);
    if (!targetPath) return;
    try {
      await pathService.deletePath(id!, targetPath.id);
      setPaths((prev) => prev.filter((p) => p.id !== targetPath.id));
      const { id: _id, createdAt: _createdAt, ...redoEntry } = targetPath;
      setRedoStack((prev) => [...prev, redoEntry]);
      scheduleSave();
    } catch {
      setErrorMessage("Undo failed.");
    }
  };

  const handleRedo = async () => {
    if (redoStack.length === 0) return;
    const redoEntry = redoStack[redoStack.length - 1];
    try {
      await pathService.savePath(id!, redoEntry);
      setRedoStack((prev) => prev.slice(0, -1));
      scheduleSave();
    } catch {
      setErrorMessage("Redo failed.");
    }
  };

  const handleClear = async () => {
    try {
      await Promise.all([
        pathService.clearBoardPaths(id!),
        pathService.clearBoardNotes(id!),
        pathService.clearBoardTextElements(id!),
        shapeService.clearBoardShapes(id!),
        imageService.clearBoardImages(id!),
      ]);
      setPaths([]);
      setNotes([]);
      setTextElements([]);
      setShapes([]);
      setImages([]);
      setEditingTextId(null);
      selection.clear();
      setRedoStack([]);
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to clear board");
    }
  };

  // Recolor every selected element: stroke for paths, stroke (+fill) for shapes,
  // text color for text. Applies to the whole multi-selection in one batch.
  const handleColorChange = (color: string) => {
    setActiveColor(color);
    const ids = selection.selectedIds;
    if (ids.size === 0) return;
    const pathUpdates: { id: string; data: any }[] = [];
    const shapeUpdates: { id: string; data: any }[] = [];
    const textUpdates: { id: string; data: any }[] = [];
    const nextPaths = paths.map((p) => {
      if (!ids.has(p.id) || p.tool === "eraser") return p;
      pathUpdates.push({ id: p.id, data: { color } });
      return { ...p, color };
    });
    const nextShapes = shapes.map((s) => {
      if (!ids.has(s.id)) return s;
      const data: Partial<ShapeElement> = { stroke: color };
      if (s.fill !== "none") data.fill = hexToRgba(color, SHAPE_FILL_ALPHA);
      shapeUpdates.push({ id: s.id, data });
      return { ...s, ...data };
    });
    const nextText = textElements.map((el) => {
      if (!ids.has(el.id)) return el;
      textUpdates.push({ id: el.id, data: { color } });
      return { ...el, color };
    });
    setPaths(nextPaths);
    setShapes(nextShapes);
    setTextElements(nextText);
    Promise.all([
      pathService.batchUpdatePaths(id!, pathUpdates),
      shapeService.batchUpdateShapes(id!, shapeUpdates),
      pathService.batchUpdateTextElements(id!, textUpdates),
    ])
      .then(scheduleSave)
      .catch((e) => {
        captureException(e, { op: "board.recolor" });
        setErrorMessage("Color update failed.");
      });
  };

  // Stroke width applies to the active tool and, when a selection exists, to its
  // strokeable members (paths + shapes; text uses fontSize, not stroke).
  const handleStrokeWidthChange = (w: number) => {
    setActiveStrokeWidth(w);
    const ids = selection.selectedIds;
    if (ids.size === 0) return;
    const pathUpdates: { id: string; data: any }[] = [];
    const shapeUpdates: { id: string; data: any }[] = [];
    const nextPaths = paths.map((p) => {
      if (!ids.has(p.id)) return p;
      const base = boundsOfPoints(p.points);
      const rendered = p.tool === "eraser" ? w + 10 : w;
      const bbox = base ? inflateBounds(base, rendered / 2) : p.bbox;
      pathUpdates.push({ id: p.id, data: { strokeWidth: w, ...(bbox ? { bbox } : {}) } });
      return { ...p, strokeWidth: w, bbox };
    });
    const nextShapes = shapes.map((s) => {
      if (!ids.has(s.id)) return s;
      const bbox = shapeBbox({ ...s, strokeWidth: w });
      shapeUpdates.push({ id: s.id, data: { strokeWidth: w, bbox } });
      return { ...s, strokeWidth: w, bbox };
    });
    setPaths(nextPaths);
    setShapes(nextShapes);
    Promise.all([
      pathService.batchUpdatePaths(id!, pathUpdates),
      shapeService.batchUpdateShapes(id!, shapeUpdates),
    ])
      .then(scheduleSave)
      .catch((e) => {
        captureException(e, { op: "board.strokeWidth" });
        setErrorMessage("Stroke width update failed.");
      });
  };

  // Shape-option cycles for the contextual ShapeOptionsBar.
  const cycleSnap = () =>
    setSnapGrid((g) => SNAP_CYCLE[(SNAP_CYCLE.indexOf(g) + 1) % SNAP_CYCLE.length]);
  const cycleArrowhead = () =>
    setShapeArrowheadEnd(
      (a) => ARROWHEAD_CYCLE[(ARROWHEAD_CYCLE.indexOf(a) + 1) % ARROWHEAD_CYCLE.length]
    );

  // --- Phase 9: insert an image element ---

  // Pick + downscale + upload an image, then place it centered on the current
  // viewport (board-space) at an aspect-preserving default size. The new element
  // is selected on arrival so it can be moved/resized immediately. On web the
  // `source` is ignored (a file dialog covers both); native offers gallery/camera.
  const insertImageFrom = async (source: ImageSource) => {
    if (insertingImage) return;
    setInsertingImage(true);
    try {
      const prepared = await pickAndPrepareImage(source);
      if (!prepared) return; // canceled / permission denied
      await uploadPreparedImage(prepared);
    } catch (e) {
      captureException(e, { op: "board.insertImage" });
      setErrorMessage("Failed to insert image.");
    } finally {
      setInsertingImage(false);
    }
  };

  // Upload an already-prepared (downscaled) image, place it aspect-fitted +
  // centered on the current viewport, and select it. Shared by the toolbar
  // picker and the web clipboard-paste path (Phase 10).
  const uploadPreparedImage = async (prepared: PreparedImage) => {
    const center = screenToBoard(viewport, {
      x: canvasSize.width / 2,
      y: canvasSize.height / 2,
    });
    const box = placementBox(prepared.naturalWidth, prepared.naturalHeight, center);
    const newId = await imageService.uploadImage(id!, user?.uid ?? "", prepared, {
      ...box,
      alt: prepared.alt,
    });
    setActiveTool("select");
    selection.select(newId, "elements");
    scheduleSave();
  };

  // The toolbar image button. Web → straight to the file dialog. Native → a
  // gallery/camera action sheet (both routes share the upload pipeline above).
  const handleInsertImage = () => {
    if (insertingImage) return;
    if (Platform.OS === "web") {
      insertImageFrom("library");
      return;
    }
    Alert.alert("Add image", undefined, [
      { text: "Photo Library", onPress: () => insertImageFrom("library") },
      { text: "Take Photo", onPress: () => insertImageFrom("camera") },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const showSaveToast = () => {
    saveOpacity.setValue(1);
    Animated.timing(saveOpacity, {
      toValue: 0,
      duration: 1500,
      delay: 800,
      useNativeDriver: true,
    }).start();
  };

  const handleSave = async () => {
    try {
      await boardService.updateBoard(id!, {});
      showSaveToast();
    } catch {
      setErrorMessage("Failed to save board.");
    }
  };

  const handleTextDelete = async (elementId: string) => {
    try {
      await pathService.deleteTextElement(id!, elementId);
      setTextElements((prev) => prev.filter((el) => el.id !== elementId));
      selection.remove(elementId);
      setEditingTextId(null);
      scheduleSave();
    } catch {
      setErrorMessage("Failed to delete text element.");
    }
  };

  // --- Blocked user handler ---

  const handleBlockUser = (userId: string) => {
    setBlockedIds((prev) => [...prev, userId]);
  };

  const handleAdminChanged = (newAdminId: string) => {
    setBoard((prev) => (prev ? { ...prev, adminId: newAdminId } : prev));
  };

  // Filter out blocked users' content, then order by z (Phase 8 z-order) so the
  // render order — and the newest-first hit-test that walks from the end — both
  // reflect the layer stack. Docs predating `z` read as 0 and keep their
  // createdAt order (the incoming arrays are already createdAt-asc, and sort is
  // stable). Memoized so culling/fit-to-content see a stable array identity.
  const byZ = <T extends { z?: number }>(a: T, b: T) => (a.z ?? 0) - (b.z ?? 0);
  const visiblePaths = useMemo(
    () => paths.filter((p) => !blockedIds.includes(p.userId)).sort(byZ),
    [paths, blockedIds]
  );
  const visibleNotes = useMemo(
    () => notes.filter((n) => !blockedIds.includes(n.userId)),
    [notes, blockedIds]
  );
  const visibleTextElements = useMemo(
    () => textElements.filter((el) => !blockedIds.includes(el.userId)).sort(byZ),
    [textElements, blockedIds]
  );
  const visibleShapes = useMemo(
    () => shapes.filter((s) => !blockedIds.includes(s.userId)).sort(byZ),
    [shapes, blockedIds]
  );
  const visibleImages = useMemo(
    () => images.filter((img) => !blockedIds.includes(img.userId)).sort(byZ),
    [images, blockedIds]
  );

  // Board-space box for any element kind (uses the persisted bbox when present).
  const pathBox = (p: DrawPath): Bounds =>
    p.bbox ?? boundsOfPoints(p.points) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const textBox = (el: TextElement): Bounds => ({
    minX: el.position.x,
    minY: el.position.y,
    maxX: el.position.x + el.width,
    maxY: el.position.y + el.height,
  });
  const shapeBox = (s: ShapeElement): Bounds => s.bbox ?? shapeBbox(s);
  const imgBox = (img: ImageElement): Bounds => img.bbox ?? imageBbox(img);

  // Keep the synchronous hit-test source (eraser/select) current.
  useEffect(() => {
    visiblePathsRef.current = visiblePaths;
  }, [visiblePaths]);
  useEffect(() => {
    visibleShapesRef.current = visibleShapes;
  }, [visibleShapes]);
  useEffect(() => {
    visibleTextElementsRef.current = visibleTextElements;
  }, [visibleTextElements]);
  useEffect(() => {
    visibleImagesRef.current = visibleImages;
  }, [visibleImages]);

  // Rebuild the marquee spatial index whenever the visible set changes. This is
  // the rbush index-maintenance path: O(n) bulk-load on change, amortized against
  // the many O(log n) queries a single marquee drag issues.
  useEffect(() => {
    const entries: IndexEntry[] = [
      ...visiblePaths.map((p) => entryFromBounds(p.id, "path", pathBox(p))),
      ...visibleShapes.map((s) => entryFromBounds(s.id, "shape", shapeBox(s))),
      ...visibleImages.map((img) => entryFromBounds(img.id, "image", imgBox(img))),
      ...visibleTextElements.map((el) => entryFromBounds(el.id, "text", textBox(el))),
    ];
    spatialIndexRef.current = buildElementIndex(entries);
  }, [visiblePaths, visibleShapes, visibleImages, visibleTextElements]);

  // Drop a stroke selection when leaving the select tool.
  useEffect(() => {
    if (activeTool !== "select") clearSelection();
  }, [activeTool, clearSelection]);

  // Board-space boxes of every selected element (mixed kinds), and their union
  // for the group overlay. Both update as the selection / elements change.
  const selectedBoxes = useMemo<Bounds[]>(() => {
    const ids = selection.selectedIds;
    if (ids.size === 0) return [];
    const boxes: Bounds[] = [];
    for (const p of visiblePaths) if (ids.has(p.id)) boxes.push(pathBox(p));
    for (const s of visibleShapes) if (ids.has(s.id)) boxes.push(shapeBox(s));
    for (const img of visibleImages) if (ids.has(img.id)) boxes.push(imgBox(img));
    for (const el of visibleTextElements) if (ids.has(el.id)) boxes.push(textBox(el));
    return boxes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.selectedIds, visiblePaths, visibleShapes, visibleImages, visibleTextElements]);
  const selectionUnion = useMemo(() => unionBounds(selectedBoxes), [selectedBoxes]);

  // --- Phase 11: keyboard shortcuts ---

  // Select every visible element across all four kinds, then switch to the
  // select tool so the result is immediately actionable.
  const selectAllVisible = useCallback(() => {
    selection.setMany(
      [
        ...visiblePathsRef.current.map((p) => p.id),
        ...visibleShapesRef.current.map((s) => s.id),
        ...visibleImagesRef.current.map((img) => img.id),
        ...visibleTextElementsRef.current.map((el) => el.id),
      ],
      "elements"
    );
    setActiveTool("select");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.setMany]);

  // Paste for the keyboard path. On web this is unreachable (the DOM `paste`
  // event below owns Cmd/Ctrl+V); on native it pulls an OS-clipboard image if
  // present, otherwise pastes the in-app clipboard.
  const handleShortcutPaste = useCallback(async () => {
    if (Platform.OS !== "web") {
      try {
        const osImg = await getClipboardImage();
        if (osImg?.uri && !insertingImage) {
          setInsertingImage(true);
          try {
            const prepared = await prepareNativeImageUri(
              osImg.uri,
              osImg.width,
              osImg.height,
              "pasted-image"
            );
            await uploadPreparedImage(prepared);
          } finally {
            setInsertingImage(false);
          }
          return;
        }
      } catch (e) {
        captureException(e, { op: "board.pasteImageNative" });
      }
    }
    if (hasClipboard()) handlePasteClipboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertingImage, handlePasteClipboard]);

  // The single resolved-action dispatcher. Kept on a ref and refreshed every
  // render so the (stable) listener callbacks always see the latest handlers
  // without re-binding DOM/native listeners on each render.
  const dispatchShortcutRef = useRef<(action: ShortcutAction) => void>(() => {});
  dispatchShortcutRef.current = (action: ShortcutAction) => {
    if (action.type === "tool") {
      setActiveTool(action.tool);
      if (action.tool !== "select") {
        selection.clear();
        setEditingTextId(null);
      }
      return;
    }
    if (action.type === "shape") {
      setActiveTool("shape");
      setActiveShapeKind(action.shape);
      return;
    }
    switch (action.name) {
      case "undo":
        handleUndo();
        break;
      case "redo":
        handleRedo();
        break;
      case "selectAll":
        selectAllVisible();
        break;
      case "copy":
        handleCopySelected();
        break;
      case "paste":
        handleShortcutPaste();
        break;
      case "duplicate":
        handleDuplicateSelected();
        break;
      case "delete":
        handleDeleteSelected();
        break;
      case "deselect":
        selection.clear();
        setEditingTextId(null);
        break;
      case "bringToFront":
        handleBringToFront();
        break;
      case "sendToBack":
        handleSendToBack();
        break;
      case "zoomIn":
        handleZoomIn();
        break;
      case "zoomOut":
        handleZoomOut();
        break;
      case "zoom100":
        viewportCtl.reset();
        break;
      case "zoomFit":
        handleFitToContent();
        break;
      case "help":
        setCheatSheetVisible((v) => !v);
        break;
    }
  };

  const onShortcutAction = useCallback((action: ShortcutAction) => {
    dispatchShortcutRef.current(action);
  }, []);
  const isEditingText = useCallback(() => editingTextIdRef.current !== null, []);
  const onModifiers = useCallback((m: { shift: boolean; alt: boolean }) => {
    shiftHeldRef.current = m.shift;
    altHeldRef.current = m.alt;
  }, []);

  useShortcuts({
    enabled: !!board,
    isEditingText,
    onAction: onShortcutAction,
    onModifiers,
    onSpace: setSpacePanActive,
  });

  // Web: handle paste (Cmd/Ctrl+V). An image on the system clipboard (screenshot
  // / copied photo) becomes an image element; otherwise fall back to the in-app
  // clipboard. The DOM `paste` event is the only place `clipboardData` is
  // readable, so paste lives here rather than in the keydown handler above.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onPaste = (e: ClipboardEvent) => {
      if (editingTextId) return; // let the text input handle its own paste
      const dt = e.clipboardData;
      if (dt && dt.items) {
        for (let i = 0; i < dt.items.length; i++) {
          const it = dt.items[i];
          if (it.kind === "file" && it.type.startsWith("image/")) {
            const file = it.getAsFile();
            if (file) {
              e.preventDefault();
              pasteExternalImage(file);
              return;
            }
          }
        }
      }
      // No external image → paste the in-app clipboard if it has anything.
      if (hasClipboard()) {
        e.preventDefault();
        handlePasteClipboard();
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [editingTextId, pasteExternalImage, handlePasteClipboard]);

  // (Shift/Alt tracking for shape-constrain + non-uniform resize is handled by
  // useShortcuts' `onModifiers` above.)

  // Phase 4 viewport culling — render only what overlaps the visible board rect.
  // Paths always carry a bbox (persisted on write, computed on read for legacy
  // docs); a path missing one is kept rather than risk dropping it. Notes/text
  // elements derive their box from position + size. The element being edited is
  // always kept so an off-screen edit can't be unmounted mid-keystroke.
  const culledPaths = useMemo(() => {
    const view = viewportBounds(cullViewport, canvasSize, CULL_MARGIN_PX);
    return visiblePaths.filter((p) => !p.bbox || boundsIntersect(p.bbox, view));
  }, [visiblePaths, cullViewport, canvasSize]);

  const culledNotes = useMemo(() => {
    const view = viewportBounds(cullViewport, canvasSize, CULL_MARGIN_PX);
    return visibleNotes.filter((n) =>
      boundsIntersect(
        { minX: n.position.x, minY: n.position.y, maxX: n.position.x, maxY: n.position.y },
        view
      )
    );
  }, [visibleNotes, cullViewport, canvasSize]);

  const culledTextElements = useMemo(() => {
    const view = viewportBounds(cullViewport, canvasSize, CULL_MARGIN_PX);
    return visibleTextElements.filter(
      (el) =>
        el.id === editingTextId ||
        boundsIntersect(
          {
            minX: el.position.x,
            minY: el.position.y,
            maxX: el.position.x + el.width,
            maxY: el.position.y + el.height,
          },
          view
        )
    );
  }, [visibleTextElements, cullViewport, canvasSize, editingTextId]);

  const culledShapes = useMemo(() => {
    const view = viewportBounds(cullViewport, canvasSize, CULL_MARGIN_PX);
    return visibleShapes.filter((s) => boundsIntersect(s.bbox ?? shapeBbox(s), view));
  }, [visibleShapes, cullViewport, canvasSize]);

  const culledImages = useMemo(() => {
    const view = viewportBounds(cullViewport, canvasSize, CULL_MARGIN_PX);
    return visibleImages.filter((img) => boundsIntersect(img.bbox ?? imageBbox(img), view));
  }, [visibleImages, cullViewport, canvasSize]);

  // Overlay transform — mirrors the SVG <G transform>. transformOrigin "0 0"
  // makes RN's transform anchor at the top-left so it matches SVG semantics
  // (screen = translate + scale * board), instead of RN's default center origin.
  const overlayTransformStyle = ENABLE_PAN_ZOOM
    ? {
        transform: [
          { translateX: viewport.x },
          { translateY: viewport.y },
          { scale: viewport.scale },
        ],
        transformOrigin: "0 0" as const,
      }
    : undefined;

  // Live group-gesture preview. The selected SVG elements render through one
  // transform string (translate for move, matrix for resize/rotate); text and
  // the overlay box derive an equivalent preview so everything tracks together.
  const selectedTransform = transformPreview
    ? transformPreview.mode === "resize"
      ? resizeMatrix(transformPreview.anchor, transformPreview.sx, transformPreview.sy)
      : rotateMatrix(transformPreview.center, transformPreview.theta)
    : dragOffset
    ? `translate(${dragOffset.dx}, ${dragOffset.dy})`
    : undefined;

  const overlayBounds =
    transformPreview?.mode === "resize"
      ? transformPreview.bounds
      : dragOffset && selectionUnion
      ? translateBounds(selectionUnion, dragOffset.dx, dragOffset.dy)
      : selectionUnion;
  const overlayRotation =
    transformPreview?.mode === "rotate" ? (transformPreview.theta * 180) / Math.PI : 0;

  // Apply the active live transform (move / resize / rotate) to a selected text
  // element so its preview matches the SVG layer.
  const previewText = (el: TextElement): TextElement => {
    if (!selection.isSelected(el.id)) return el;
    if (transformPreview?.mode === "resize") {
      const { anchor, sx, sy } = transformPreview;
      return {
        ...el,
        position: scalePointAbout(el.position, anchor, sx, sy),
        width: el.width * sx,
        height: el.height * sy,
        fontSize: Math.max(1, Math.round(el.fontSize * sy)),
      };
    }
    if (transformPreview?.mode === "rotate") {
      const { center, theta } = transformPreview;
      const oc = { x: el.position.x + el.width / 2, y: el.position.y + el.height / 2 };
      const nc = rotatePointAbout(oc, center, theta);
      return {
        ...el,
        position: { x: nc.x - el.width / 2, y: nc.y - el.height / 2 },
        rotation: (el.rotation ?? 0) + (theta * 180) / Math.PI,
      };
    }
    if (dragOffset) {
      return { ...el, position: { x: el.position.x + dragOffset.dx, y: el.position.y + dragOffset.dy } };
    }
    return el;
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  const currentUserInfo = {
    uid: user?.uid ?? "",
    displayName: userProfile?.displayName ?? user?.email ?? "User",
    email: userProfile?.email ?? user?.email ?? "",
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <JoinBoardModal
        visible={joinModalVisible}
        initialCode={deepLinkCode}
        onClose={handleDeepLinkCancel}
        onJoined={handleDeepLinkJoined}
      />

      <ShareBoardModal
        visible={shareBoardModalVisible}
        boardId={id!}
        inviteCode={board?.inviteCode ?? ""}
        members={board?.members ?? []}
        currentUserId={user?.uid ?? ""}
        onClose={() => setShareBoardModalVisible(false)}
        onMemberAdded={handleMemberAdded}
      />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={goBack}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color="#333" />
        </TouchableOpacity>

        <Text style={styles.title} numberOfLines={1}>
          {board?.title ?? "Board"}
        </Text>

        <View style={styles.headerRight}>
          <MemberList
            boardId={id!}
            memberUids={board?.members ?? []}
            currentUserId={user?.uid}
          />
          <BoardUserBar
            presence={presence}
            boardTitle={board?.title ?? "Board"}
            currentUser={currentUserInfo}
            blockedIds={blockedIds}
            onBlock={handleBlockUser}
            ownerId={board?.ownerId}
            adminId={board?.adminId}
            boardId={id}
            onAdminChanged={handleAdminChanged}
          />
          <TouchableOpacity
            onPress={() => setBgPickerVisible(true)}
            style={styles.iconBtn}
            hitSlop={8}
          >
            <Ionicons name="grid-outline" size={20} color="#2563eb" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleShare}
            style={styles.iconBtn}
            hitSlop={8}
          >
            <Ionicons name="share-outline" size={22} color="#2563eb" />
          </TouchableOpacity>
          {isAdmin && (
            <>
              {activeSession ? (
                <TouchableOpacity
                  style={styles.endSessionBtn}
                  onPress={handleEndSession}
                  disabled={endingSession}
                >
                  {endingSession ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons name="stop-circle-outline" size={16} color="#fff" />
                  )}
                  <Text style={styles.startSessionText}>End Session</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.startSessionBtn}
                  onPress={() => setSessionModalVisible(true)}
                >
                  <Ionicons name="play-circle-outline" size={16} color="#fff" />
                  <Text style={styles.startSessionText}>Session</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={() =>
                  Alert.alert(
                    "Board Admin",
                    "You are the admin of this board. You can delete any user's notes and clear the entire board.",
                    [{ text: "OK" }]
                  )
                }
              >
                <Ionicons name="shield-checkmark" size={20} color="#2563eb" />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {/* Save toast */}
      <Animated.View style={[styles.saveToast, { opacity: saveOpacity }]} pointerEvents="none">
        <Ionicons name="checkmark-circle" size={14} color="#16a34a" />
        <Text style={styles.saveToastText}>Saved</Text>
      </Animated.View>

      {/* Offline / syncing banner (Phase 6) */}
      <OfflineBanner />

      {/* Error banner */}
      {errorMessage && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={15} color="#b91c1c" />
          <Text style={styles.errorBannerText}>{errorMessage}</Text>
          <TouchableOpacity onPress={() => setErrorMessage(null)}>
            <Ionicons name="close" size={15} color="#b91c1c" />
          </TouchableOpacity>
        </View>
      )}

      {/* Canvas + Notes + Text Elements */}
      <View
        style={styles.canvasContainer}
        onLayout={(e) => setCanvasSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      >
        {!canvasReady && (
          <View style={styles.canvasLoadingOverlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#2563eb" />
            <Text style={styles.canvasLoadingText}>Loading canvas…</Text>
          </View>
        )}
        <DrawingCanvas
          ref={canvasSvgRef}
          paths={culledPaths}
          shapes={culledShapes}
          images={culledImages}
          shapeDraft={shapeDraft}
          guides={guides}
          selectedIds={selection.selectedIds}
          selectionBoxes={activeTool === "select" ? selectedBoxes : undefined}
          selectedTransform={selectedTransform}
          marquee={marquee}
          backgroundTemplate={board?.backgroundTemplate ?? "blank"}
          currentPath={currentPoints}
          color={activeColor}
          strokeWidth={activeStrokeWidth}
          tool={activeTool === "eraser" ? "eraser" : "pen"}
          viewport={viewport}
          enablePanZoom={ENABLE_PAN_ZOOM}
          panMode={activeTool === "hand" || spacePanActive}
          width={canvasSize.width}
          height={canvasSize.height}
          onStrokeStart={handleStrokeStart}
          onStrokeMove={handleStrokeMove}
          onStrokeEnd={handleStrokeEnd}
          onTap={handleCanvasTap}
          onPanBy={viewportCtl.panBy}
          onZoomAtPoint={viewportCtl.zoomAtPoint}
          onFling={viewportCtl.fling}
          onGestureStart={viewportCtl.stopFling}
        />
        {/* Overlay layer — shares the canvas viewport transform so text and
            notes stay locked to the strokes when panning/zooming. */}
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <View style={[StyleSheet.absoluteFill, overlayTransformStyle]} pointerEvents="box-none">
            <TextNoteOverlay
              notes={culledNotes}
              pendingNotePosition={pendingNotePosition}
              currentUserId={user?.uid ?? ""}
              isAdmin={isAdmin}
              onSubmitNote={handleSubmitNote}
              onCancelNote={handleCancelNote}
              onDeleteNote={handleDeleteNote}
            />
            {culledTextElements.map((el) => {
              const display = previewText(el);
              return (
                <TextElementView
                  key={el.id}
                  element={display}
                  isSelected={selection.isSelected(el.id)}
                  isEditing={editingTextId === el.id}
                  scale={viewport.scale}
                  onSelect={handleTextSelect}
                  onBlur={handleTextBlur}
                  onResize={handleTextResize}
                  onDelete={el.userId === user?.uid || isAdmin ? handleTextDelete : undefined}
                />
              );
            })}
            {overlayBounds && activeTool === "select" && !marquee && (
              <SelectionOverlay
                bounds={overlayBounds}
                rotation={overlayRotation}
                scale={viewport.scale}
                count={selection.count}
                showActions={!transformPreview && !dragOffset}
                onDelete={handleDeleteSelected}
                onDuplicate={handleDuplicateSelected}
                onBringToFront={handleBringToFront}
                onSendToBack={handleSendToBack}
                onTransformStart={handleTransformStart}
                onTransformMove={handleTransformMove}
                onTransformEnd={handleTransformEnd}
              />
            )}
          </View>
        </View>
        {ENABLE_PAN_ZOOM && (
          <ZoomControls
            scale={viewport.scale}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onReset={viewportCtl.reset}
            onFit={handleFitToContent}
          />
        )}
      </View>

      {/* Contextual shape options (Phase 7) — only while the shape tool is active */}
      {activeTool === "shape" && (
        <ShapeOptionsBar
          activeKind={activeShapeKind}
          onSelectKind={setActiveShapeKind}
          fillEnabled={shapeFillEnabled}
          onToggleFill={() => setShapeFillEnabled((v) => !v)}
          dashed={shapeDashed}
          onToggleDashed={() => setShapeDashed((v) => !v)}
          snapGrid={snapGrid}
          onCycleSnap={cycleSnap}
          arrowheadEnd={shapeArrowheadEnd}
          onCycleArrowhead={cycleArrowhead}
        />
      )}

      {/* Toolbar */}
      <Toolbar
        activeTool={activeTool}
        activeColor={activeColor}
        activeStrokeWidth={activeStrokeWidth}
        isAdmin={isAdmin}
        onToolChange={setActiveTool}
        onColorChange={handleColorChange}
        onStrokeWidthChange={handleStrokeWidthChange}
        onInsertImage={handleInsertImage}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canRedo={redoStack.length > 0}
        onClear={handleClear}
        onSave={handleSave}
      />

      {/* Keyboard-shortcuts cheat sheet (opened with `?`) */}
      <ShortcutsCheatSheet
        visible={cheatSheetVisible}
        onClose={() => setCheatSheetVisible(false)}
      />

      {/* Background-template picker (Phase 12) */}
      <BackgroundPicker
        visible={bgPickerVisible}
        active={board?.backgroundTemplate ?? "blank"}
        onSelect={handleSelectBackground}
        onClose={() => setBgPickerVisible(false)}
      />

      {isAdmin && (
        <StartSessionModal
          visible={sessionModalVisible}
          boardId={id!}
          boardTitle={board?.title ?? "Board"}
          adminId={user?.uid ?? ""}
          adminName={currentUserInfo.displayName}
          presenceUsers={presence}
          onClose={() => setSessionModalVisible(false)}
          onSessionCreated={() => {
            setSessionModalVisible(false);
            refreshActiveSession();
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  backBtn: {
    padding: 4,
    marginRight: 4,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    marginHorizontal: 8,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 32,
    justifyContent: "flex-end",
  },
  iconBtn: {
    padding: 4,
  },
  startSessionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#2563eb",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  endSessionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ef4444",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  startSessionText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  canvasContainer: {
    flex: 1,
  },
  canvasLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.85)",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    zIndex: 10,
  },
  canvasLoadingText: {
    fontSize: 14,
    color: "#6b7280",
    fontWeight: "500",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fef2f2",
    borderBottomWidth: 1,
    borderBottomColor: "#fecaca",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorBannerText: {
    flex: 1,
    fontSize: 13,
    color: "#b91c1c",
  },
  saveToast: {
    position: "absolute",
    top: 110,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#f0fdf4",
    borderWidth: 1,
    borderColor: "#bbf7d0",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    zIndex: 100,
  },
  saveToastText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#16a34a",
  },
});
