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
import DiagramPromptModal from "../../src/components/DiagramPromptModal";
import ZoomControls from "../../src/components/ZoomControls";
import SelectionOverlay from "../../src/components/SelectionOverlay";
import ShapeOptionsBar from "../../src/components/ShapeOptionsBar";
import OfflineBanner from "../../src/components/OfflineBanner";
import ShortcutsCheatSheet from "../../src/components/ShortcutsCheatSheet";
import BackgroundPicker from "../../src/components/BackgroundPicker";
import CommentPinLayer, { CommentPin } from "../../src/components/CommentPinLayer";
import CommentThreadPanel from "../../src/components/CommentThreadPanel";
import BoardHistoryPanel from "../../src/components/BoardHistoryPanel";
import CursorLayer from "../../src/components/CursorLayer";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "../../src/hooks/useAuth";
import { useShortcuts } from "../../src/hooks/useShortcuts";
import { ShortcutAction } from "../../src/lib/shortcuts";
import { getClipboardImage } from "../../src/lib/osClipboard";
import { useViewport } from "../../src/hooks/useViewport";
import { useThrottledValue } from "../../src/hooks/useThrottledValue";
import { useSelection } from "../../src/hooks/useSelection";
import { Point, Bounds, boundsOfPoints, unionBounds, inflateBounds, screenToBoard, boardToScreen } from "../../src/lib/viewport";
import { toggleFollow, wouldCreateCycle, type FollowMap } from "../../src/lib/followMode";
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
import * as cursorService from "../../src/services/cursorService";
import * as friendService from "../../src/services/friendService";
import * as sessionService from "../../src/services/sessionService";
import * as commentService from "../../src/services/commentService";
import * as activityService from "../../src/services/activityService";
import { notifyMentions } from "../../src/services/notificationService";
import { MentionMember, extractMentionUids } from "../../src/lib/mentions";
import { captureBoardImage, captureSelectionImage } from "../../src/utils/canvasCapture";
import {
  recognizeHandwriting,
  isOcrConfigured,
  OCR_CONFIDENCE_THRESHOLD,
  explainSelection,
  isExplainConfigured,
  textToDiagram,
  isDiagramConfigured,
} from "../../src/services/aiService";
import { mermaidToBoard, EmptyDiagramError } from "../../src/lib/mermaid-to-board";
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
  BoardRole,
  Workspace,
  Comment,
  CommentAnchorKind,
  ShapeRecognitionMode,
} from "../../src/types";
import { getWorkspace } from "../../src/services/workspaceService";
import * as shapeRecognitionService from "../../src/services/shapeRecognitionService";
import { recognizeShape, RecognizedShape } from "../../src/lib/shapeRecognition";
import PenOptionsBar from "../../src/components/PenOptionsBar";

type Tool = "pen" | "eraser" | "text" | "select" | "shape" | "hand" | "comment";

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

/**
 * Phase 8 — `embedMode` renders the board chrome-stripped and read-only for an
 * embeddable iframe (the embed route at app/embed/b/[id].tsx passes it). The board
 * reads the same `id` route param either way. Editing is already gated by role
 * (an embed identity is not a board member, so `canEdit` is false), but embed mode
 * additionally hides the header + toolbar and suppresses presence/cursor writes
 * and the join prompt, which an embed viewer has no rights to.
 */
export default function BoardScreen({ embedMode = false }: { embedMode?: boolean } = {}) {
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
  // Phase 8: per-board activity history sidebar visibility.
  const [historyVisible, setHistoryVisible] = useState(false);
  // Phase 6 — the board's workspace, fetched for per-board role resolution (the
  // role floor). Null for legacy boards or while loading.
  const [boardWorkspace, setBoardWorkspace] = useState<Workspace | null>(null);
  // Phase 10 — workspace members resolved to {uid, displayName} for @-mention
  // autocomplete in the comment composer. Empty for legacy/no-workspace boards.
  const [mentionMembers, setMentionMembers] = useState<MentionMember[]>([]);
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
  // Phase 9 — auto-perfect. The per-user mode (loaded from the user doc on mount)
  // and, in "ask" mode, the pending candidate: the just-saved freehand stroke's
  // id plus the clean primitive it resembles, surfaced as a "perfect it?" prompt.
  const [shapeRecMode, setShapeRecMode] = useState<ShapeRecognitionMode>("ask");
  const [perfectCandidate, setPerfectCandidate] = useState<{
    pathId: string;
    shape: RecognizedShape;
    color: string;
    strokeWidth: number;
  } | null>(null);
  // Phase 10 — handwriting OCR. `ocrBusy` gates the in-flight call (button spinner);
  // `ocrCandidate` holds a low-confidence (<70%) result pending a confirm step
  // (Appendix B.7) — the board-space position is where the text element lands.
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrCandidate, setOcrCandidate] = useState<{
    text: string;
    position: Point;
    confidence: number;
  } | null>(null);
  // Phase 11 — explain selection. Gates the in-flight call (button spinner).
  const [explainBusy, setExplainBusy] = useState(false);
  // Phase 12 — text → diagram. The prompt panel's open state + draft text, and an
  // in-flight gate for the generate call (spinner + disabled submit).
  const [diagramOpen, setDiagramOpen] = useState(false);
  const [diagramPrompt, setDiagramPrompt] = useState("");
  const [diagramBusy, setDiagramBusy] = useState(false);
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

  // Phase 9 — load the user's auto-perfect mode once (AuthContext doesn't hydrate
  // it). Failure falls back to the service default inside the service itself.
  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    shapeRecognitionService.getShapeRecognitionMode(user.uid).then((m) => {
      if (!cancelled) setShapeRecMode(m);
    });
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  // Cycle the auto-perfect mode (Ask → Always → Off) and persist it. Clears any
  // pending prompt when switching off.
  const cycleShapeRecMode = useCallback(() => {
    setShapeRecMode((cur) => {
      const next: ShapeRecognitionMode =
        cur === "ask" ? "always" : cur === "always" ? "never" : "ask";
      if (next === "never") setPerfectCandidate(null);
      if (user?.uid) {
        shapeRecognitionService
          .setShapeRecognitionMode(user.uid, next)
          .catch((e) => captureException(e, { op: "board.setShapeRecMode" }));
      }
      return next;
    });
  }, [user?.uid]);

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

  // Phase 7 — follow mode. The presence user whose camera we're mirroring (or
  // null). `lastPointerRef` holds the latest board-space pointer so a viewport
  // broadcast can re-send the cursor position even when only the camera moved.
  const [followingId, setFollowingId] = useState<string | null>(null);
  const lastPointerRef = useRef<Point>({ x: 0, y: 0 });
  // Gates the viewport broadcast until the pointer has actually moved once, so a
  // user who only opens the board doesn't publish a phantom cursor at (0,0).
  const hasPointerRef = useRef(false);

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

  // Phase 7 — comments. The realtime thread set, the currently-open thread (or a
  // pending new-comment anchor), and a busy flag for in-flight writes. Unread is
  // client-side: a comment is unread when its latest activity is newer than the
  // viewer's last-seen baseline (persisted per board to AsyncStorage) and the
  // activity isn't the viewer's own.
  const [comments, setComments] = useState<Comment[]>([]);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<{
    anchorElementId: string;
    anchorKind: CommentAnchorKind;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentsViewedAt, setCommentsViewedAt] = useState(0);

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
  // Phase 6 — effective per-board role. Editors write canvas content; viewers/
  // commenters are read-only (the toolbar editing tools are hidden for them, and
  // the security rules enforce it server-side regardless).
  const effectiveRole: BoardRole | undefined =
    user && board
      ? boardService.effectiveBoardRole(board, boardWorkspace, user.uid)
      : undefined;
  const canEdit = boardService.canEditBoardRole(effectiveRole);
  // Phase 7 — commenters (and editors) may comment; pure viewers cannot.
  const canComment = boardService.canCommentBoardRole(effectiveRole);

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
  // Manual camera commands take back control from follow mode (Phase 7).
  const handleZoomIn = () => { setFollowingId(null); viewportCtl.zoomAtPoint(1.25, canvasCenter()); };
  const handleZoomOut = () => { setFollowingId(null); viewportCtl.zoomAtPoint(0.8, canvasCenter()); };
  const handleFitToContent = () => { setFollowingId(null); viewportCtl.fit(contentBounds(), canvasSize); };
  const handleResetViewport = () => { setFollowingId(null); viewportCtl.reset(); };

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

  // Presence: join on mount, subscribe to updates, leave on unmount. Skipped in
  // embed mode — the read-only embed identity has no write rights to presence.
  useEffect(() => {
    if (!id || !user || embedMode) return;

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
      // Phase 6: clear the ephemeral cursor doc on leave so it doesn't linger
      // (Firestore has no onDisconnect; stale cursors are also filtered on read).
      cursorService
        .removeCursor(id, user.uid)
        .catch((e) => captureException(e, { op: "board.removeCursor" }));
    };
  }, [id, user]);

  // Phase 6: publish the local pointer to the cursor side channel. Throttled
  // inside cursorService (~20Hz) and side-effect-only — it never sets state, so
  // a pointer move never re-renders the element tree (Appendix A.4 hard rule).
  const handlePointerMove = useCallback(
    (p: Point) => {
      if (!id || !user || embedMode) return;
      lastPointerRef.current = p;
      hasPointerRef.current = true;
      cursorService.publishCursor(id, user.uid, {
        displayName: userProfile?.displayName ?? user.email ?? "User",
        x: p.x,
        y: p.y,
        tool: activeTool,
        // Don't broadcast a viewport while following — ours is just a mirror of
        // the leader's, and re-broadcasting it is what would sustain an A↔B
        // oscillation (Phase 7 cycle guard, primary layer).
        viewport: followingId ? undefined : viewport,
        following: followingId,
      });
    },
    [id, user, userProfile?.displayName, activeTool, viewport, followingId, embedMode]
  );

  // Phase 7 — broadcast our viewport when it changes from our own pan/zoom, so
  // followers track moves that aren't pointer-driven (pinch, fling, zoom buttons).
  // Suppressed while following: that viewport is a mirror, not our intent.
  useEffect(() => {
    if (!id || !user || embedMode || followingId || !hasPointerRef.current) return;
    cursorService.publishCursor(id, user.uid, {
      displayName: userProfile?.displayName ?? user.email ?? "User",
      x: lastPointerRef.current.x,
      y: lastPointerRef.current.y,
      tool: activeTool,
      viewport,
      following: null,
    });
  }, [viewport, id, user, userProfile?.displayName, activeTool, followingId, embedMode]);

  // Stop following (own gesture, leader left, etc.). Stable so it can be wired
  // into the canvas gesture/tap and zoom-control handlers without re-creating.
  const exitFollow = useCallback(() => setFollowingId(null), []);

  // Avatar tap → toggle follow on that user (the subscription's cycle guard
  // catches the A↔B case once both viewports are visible).
  const handleFollowUser = useCallback(
    (targetId: string) => {
      setFollowingId((cur) => toggleFollow(cur, targetId, user?.uid ?? ""));
    },
    [user?.uid]
  );

  // Any of the follower's own camera commands take back control and exit follow.
  const handleGestureStart = useCallback(() => {
    setFollowingId(null);
    viewportCtl.stopFling();
  }, [viewportCtl]);

  // Phase 7 — while following, open a transient cursor subscription that drives
  // the camera toward the leader's broadcast viewport. It's the only extra
  // listener and lives only for the duration of the follow (within the A.6
  // listener budget). Cursor jitter still never touches the element tree —
  // this re-renders only via the viewport, exactly as a manual pan/zoom does.
  useEffect(() => {
    if (!id || !followingId || !user) return;
    const unsub = cursorService.subscribeToCursors(id, (cursors) => {
      const leader = cursors.find((c) => c.userId === followingId);
      if (!leader) return;
      // Secondary cycle guard: if the leader (transitively) follows us, break the
      // follow so the two cameras can't chase each other.
      const followMap: FollowMap = {};
      for (const c of cursors) followMap[c.userId] = c.following ?? null;
      if (wouldCreateCycle(followMap, user.uid, followingId)) {
        setFollowingId(null);
        return;
      }
      if (leader.viewport) viewportCtl.animateTo(leader.viewport);
    });
    return unsub;
  }, [id, followingId, user, viewportCtl]);

  // Stop following if the leader drops out of presence (left the board).
  useEffect(() => {
    if (!followingId) return;
    if (!presence.some((p) => p.userId === followingId)) setFollowingId(null);
  }, [presence, followingId]);

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

  // Phase 7 — realtime comments + the per-board unread baseline (AsyncStorage).
  useEffect(() => {
    if (!id) return;
    return commentService.subscribeToBoardComments(id, setComments);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    AsyncStorage.getItem(`comments-viewed:${id}`)
      .then((v) => {
        if (!cancelled) setCommentsViewedAt(v ? Number(v) || 0 : 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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

      // Phase 6 — resolve the board's workspace for per-board role math. Best-effort:
      // a failure (or a legacy board with no workspaceId) leaves the floor unset and
      // the resolver falls back to the legacy "any member edits" behavior.
      if (boardData.workspaceId) {
        getWorkspace(boardData.workspaceId)
          .then((ws) => {
            setBoardWorkspace(ws);
            // Phase 10 — resolve workspace member uids to display names for the
            // @-mention autocomplete. Best-effort: a failure just leaves the list
            // empty (no autocomplete), it never blocks the board.
            if (ws) {
              friendService
                .getUsersByIds(Object.keys(ws.members))
                .then((users) =>
                  setMentionMembers(
                    users.map((u) => ({ uid: u.uid, displayName: u.displayName }))
                  )
                )
                .catch(() => setMentionMembers([]));
            } else {
              setMentionMembers([]);
            }
          })
          .catch(() => {
            setBoardWorkspace(null);
            setMentionMembers([]);
          });
      } else {
        setBoardWorkspace(null);
        setMentionMembers([]);
      }

      // Deep-link gate: if the viewer isn't a member yet, prompt them to join.
      // Never in embed mode — an embed viewer is intentionally a non-member and
      // has no join path; the prompt would be a dead end.
      if (!embedMode && user && !boardData.members.includes(user.uid)) {
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
      // Phase 3: unified capture — web rasterizes the DOM <svg>, native uses
      // react-native-svg's toDataURL. Both go through captureBoardImage.
      const snapshot = await captureBoardImage(canvasSvgRef.current);
      console.log(
        "[end-session] snapshot=",
        snapshot ? `${Math.round(snapshot.length / 1024)}KB` : "null"
      );
      // Phase 4: a single lifecycle transition stamps endedAt, freezes the
      // participant snapshot, and persists the final canvas image together.
      const participants = await sessionService.resolveParticipantSnapshot(activeSession);
      await sessionService.endSession(activeSession.id, { participants, snapshot });
      // Phase 8: record the session end in the workspace activity feed
      // (fire-and-forget; logging never blocks ending the session).
      activityService.logSessionEnded({
        workspaceId: activeSession.workspaceId || board?.workspaceId || "",
        boardId: activeSession.boardId,
        sessionId: activeSession.id,
        actorId: user?.uid ?? "",
        actorName: userProfile?.displayName ?? user?.email ?? "User",
        participantCount: activeSession.participantIds.length,
        title: activeSession.title,
      });
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

    // Phase 9 — auto-perfect runs off the hot draw path, on stroke end only. Done
    // before the write so we can recognize against the full-fidelity stroke; the
    // pen color/width are captured now since state may change before the prompt.
    const recognized =
      shapeRecMode !== "never" ? recognizeShape(currentPoints) : null;
    const recColor = activeColor;
    const recWidth = activeStrokeWidth;

    try {
      const pathId = await pathService.savePath(id!, newPath);
      setRedoStack([]);
      scheduleSave();
      if (recognized) {
        if (shapeRecMode === "always") {
          await replaceStrokeWithShape(pathId, recognized, recColor, recWidth);
        } else {
          // "ask": leave the stroke in place and offer a discreet prompt.
          setPerfectCandidate({ pathId, shape: recognized, color: recColor, strokeWidth: recWidth });
        }
      }
    } catch {
      Alert.alert("Error", "Failed to save stroke");
    }

    setCurrentPoints(null);
  };

  // Phase 9 — swap a freehand stroke for the clean primitive the classifier
  // recognized: create the ShapeElement, then delete the originating path. The
  // shape inherits the stroke's color/width; fill stays off and rect/ellipse/
  // triangle use the recognized axis-aligned box (line keeps its start + vector).
  const replaceStrokeWithShape = async (
    pathId: string,
    rec: RecognizedShape,
    color: string,
    strokeWidth: number
  ) => {
    const shape: Omit<ShapeElement, "id" | "createdAt" | "bbox"> = {
      boardId: id!,
      userId: user?.uid ?? "",
      shape: rec.kind,
      x: rec.x,
      y: rec.y,
      width: rec.width,
      height: rec.height,
      rotation: 0,
      fill: "none",
      stroke: color,
      strokeWidth,
      dashed: false,
      arrowheadStart: "none",
      arrowheadEnd: "none",
    };
    try {
      await shapeService.saveShape(id!, shape);
      // Optimistic local removal keeps the swap instant; the subscription confirms.
      setPaths((prev) => prev.filter((p) => p.id !== pathId));
      await pathService.deletePath(id!, pathId);
      scheduleSave();
    } catch (e) {
      captureException(e, { op: "board.perfectShape" });
      setErrorMessage("Couldn't perfect the shape.");
    }
  };

  // "ask"-mode prompt actions: accept swaps the stroke; dismiss just drops the
  // candidate, leaving the freehand stroke untouched.
  const acceptPerfect = async () => {
    const c = perfectCandidate;
    setPerfectCandidate(null);
    if (c) await replaceStrokeWithShape(c.pathId, c.shape, c.color, c.strokeWidth);
  };
  const dismissPerfect = () => setPerfectCandidate(null);

  // --- Phase 10: handwriting OCR (selection → text element) ---

  // Place the recognized text as a new TextElement at the selection's top-left
  // (board space), then select it so it can be edited/moved immediately.
  const placeOcrText = async (text: string, position: Point) => {
    const newEl: Omit<TextElement, "id" | "createdAt"> = {
      boardId: id!,
      userId: user?.uid ?? "",
      text,
      position,
      width: 240,
      height: 96,
      fontSize: 20,
      color: activeColor,
    };
    const elId = await pathService.saveTextElement(id!, newEl);
    setActiveTool("select");
    selection.select(elId);
    setEditingTextId(elId);
    scheduleSave();
  };

  // Capture the selected region → OCR via the Cloud Function → place the text.
  // Low-confidence results route through a confirm prompt instead of landing
  // directly (Appendix B.7). The selected stroke ids are the cache key, so a
  // re-run on the same selection is a free server-side cache hit.
  const handleRecognizeText = async () => {
    if (ocrBusy) return;
    const u = selectionUnion;
    if (!u) return;
    const pathIds = visiblePaths.filter((p) => selection.isSelected(p.id)).map((p) => p.id);
    setOcrBusy(true);
    try {
      const tl = boardToScreen(viewport, { x: u.minX, y: u.minY });
      const br = boardToScreen(viewport, { x: u.maxX, y: u.maxY });
      const pad = 12;
      const rect = {
        x: tl.x - pad,
        y: tl.y - pad,
        width: br.x - tl.x + pad * 2,
        height: br.y - tl.y + pad * 2,
      };
      const image = await captureSelectionImage(canvasSvgRef.current, rect, canvasSize);
      if (!image) {
        setErrorMessage("Couldn't capture the selection for OCR.");
        return;
      }
      const result = await recognizeHandwriting(id!, image, pathIds);
      const position = { x: u.minX, y: u.minY };
      if (result.confidence < OCR_CONFIDENCE_THRESHOLD) {
        setOcrCandidate({ text: result.text, position, confidence: result.confidence });
      } else {
        await placeOcrText(result.text, position);
      }
    } catch (e: any) {
      captureException(e, { op: "board.ocr" });
      setErrorMessage(e?.message ?? "Couldn't recognize the handwriting.");
    } finally {
      setOcrBusy(false);
    }
  };

  // Low-confidence confirm-prompt actions: accept commits the text; dismiss drops it.
  const acceptOcr = async () => {
    const c = ocrCandidate;
    setOcrCandidate(null);
    if (c) {
      try {
        await placeOcrText(c.text, c.position);
      } catch (e) {
        captureException(e, { op: "board.ocrAccept" });
        setErrorMessage("Couldn't insert the recognized text.");
      }
    }
  };
  const dismissOcr = () => setOcrCandidate(null);

  // --- Phase 11: explain selection (selection → AI → text element beside it) ---

  // Capture the selected region + any selected text → explain via the Cloud
  // Function → drop the structured explanation as a TextElement to the right of the
  // selection. Works on any selection (strokes / text / image / mix): the image
  // carries the visual signal and the text carries transcribed content.
  const handleExplainSelection = async () => {
    if (explainBusy) return;
    const u = selectionUnion;
    if (!u) return;
    setExplainBusy(true);
    try {
      // Transcribed text from selected text elements + sticky notes (the model
      // reads this alongside the image so it isn't guessing at legible content).
      const selectedText = [
        ...visibleTextElements.filter((el) => selection.isSelected(el.id)).map((el) => el.text),
        ...visibleNotes.filter((n) => selection.isSelected(n.id)).map((n) => n.content),
      ]
        .map((t) => (t ?? "").trim())
        .filter(Boolean)
        .join("\n");

      const tl = boardToScreen(viewport, { x: u.minX, y: u.minY });
      const br = boardToScreen(viewport, { x: u.maxX, y: u.maxY });
      const pad = 12;
      const rect = {
        x: tl.x - pad,
        y: tl.y - pad,
        width: br.x - tl.x + pad * 2,
        height: br.y - tl.y + pad * 2,
      };
      const image = await captureSelectionImage(canvasSvgRef.current, rect, canvasSize);

      const { text } = await explainSelection(id!, image ?? undefined, selectedText || undefined);

      // Place beside (to the right of) the selection so it doesn't cover it.
      const newEl: Omit<TextElement, "id" | "createdAt"> = {
        boardId: id!,
        userId: user?.uid ?? "",
        text,
        position: { x: u.maxX + 24, y: u.minY },
        width: 280,
        height: 180,
        fontSize: 16,
        color: activeColor,
      };
      const elId = await pathService.saveTextElement(id!, newEl);
      setActiveTool("select");
      selection.select(elId);
      scheduleSave();
    } catch (e: any) {
      captureException(e, { op: "board.explain" });
      setErrorMessage(e?.message ?? "Couldn't explain the selection.");
    } finally {
      setExplainBusy(false);
    }
  };

  // --- Phase 12: text → diagram (prompt → Mermaid → native shapes/text) ---

  // Send the prompt to the Cloud Function, parse the returned Mermaid into native
  // element specs (`mermaid-to-board`), then write them as real ShapeElement/
  // TextElement docs centered on the current viewport. Nodes inherit the active
  // color; edges are lines/arrows. The whole batch is then selected so the user
  // can move/tweak it as a unit.
  const handleGenerateDiagram = async () => {
    const prompt = diagramPrompt.trim();
    if (diagramBusy || !prompt) return;
    setDiagramBusy(true);
    try {
      const { mermaid } = await textToDiagram(id!, prompt);
      const build = mermaidToBoard(mermaid);

      // Center the diagram on the viewport: translate diagram-local (0,0)-origin
      // coords so the diagram's center lands on the screen center in board space.
      const center = screenToBoard(viewport, {
        x: canvasSize.width / 2,
        y: canvasSize.height / 2,
      });
      const ox = center.x - build.width / 2;
      const oy = center.y - build.height / 2;
      const uid = user?.uid ?? "";

      const shapeIds = await Promise.all(
        build.shapes.map((s) =>
          shapeService.saveShape(id!, {
            boardId: id!,
            userId: uid,
            shape: s.shape,
            x: ox + s.x,
            y: oy + s.y,
            width: s.width,
            height: s.height,
            rotation: 0,
            fill: "none",
            stroke: activeColor,
            strokeWidth: activeStrokeWidth,
            dashed: s.dashed,
            arrowheadStart: "none",
            arrowheadEnd: s.arrowheadEnd,
          })
        )
      );
      const textIds = await Promise.all(
        build.texts.map((t) =>
          pathService.saveTextElement(id!, {
            boardId: id!,
            userId: uid,
            text: t.text,
            position: { x: ox + t.x, y: oy + t.y },
            width: t.width,
            height: t.height,
            // Edge labels are smaller than node labels so connectors stay legible.
            fontSize: t.role === "edge" ? 12 : 15,
            color: activeColor,
          })
        )
      );

      setActiveTool("select");
      selection.setMany([...shapeIds, ...textIds]);
      setDiagramOpen(false);
      setDiagramPrompt("");
      scheduleSave();
    } catch (e: any) {
      captureException(e, { op: "board.diagram" });
      setErrorMessage(
        e instanceof EmptyDiagramError
          ? "The AI couldn't turn that into a diagram. Try rephrasing it."
          : e?.message ?? "Couldn't generate the diagram."
      );
    } finally {
      setDiagramBusy(false);
    }
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
    // Phase 7: a tap while following hands control back to the follower and does
    // nothing else (the tap is consumed by exiting follow mode).
    if (followingId) {
      setFollowingId(null);
      return;
    }
    if (activeTool === "hand") {
      // The Hand tool only pans; taps do nothing.
      return;
    }
    if (activeTool === "shape") {
      // Shapes require a drag to size them; a stray tap does nothing.
      return;
    }
    if (activeTool === "comment") {
      // Anchor a new comment to the topmost element under the tap. A tap on empty
      // canvas does nothing — comments must attach to an element (Phase 7).
      const hit = hitTestAny(point);
      if (!hit) {
        setErrorMessage("Tap an element to anchor a comment to it.");
        return;
      }
      const box = boxOfElement(hit.id, hit.kind);
      if (!box) return;
      setActiveCommentId(null);
      setPendingAnchor({
        anchorElementId: hit.id,
        anchorKind: hit.kind as CommentAnchorKind,
        offsetX: point.x - box.minX,
        offsetY: point.y - box.minY,
      });
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
        commentService.clearBoardComments(id!),
      ]);
      setPaths([]);
      setNotes([]);
      setTextElements([]);
      setShapes([]);
      setImages([]);
      setComments([]);
      closeCommentPanel();
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

  // --- Phase 7: comment handlers ---

  const authorName = userProfile?.displayName ?? user?.email ?? "User";

  // Persist the unread baseline to "now" so currently-visible activity reads as
  // seen. Coarse but cheap (no per-comment write): opening any thread clears the
  // board's unread markers.
  const markCommentsViewed = useCallback(() => {
    const now = Date.now();
    setCommentsViewedAt(now);
    AsyncStorage.setItem(`comments-viewed:${id}`, String(now)).catch(() => {});
  }, [id]);

  const openCommentThread = (commentId: string) => {
    setPendingAnchor(null);
    setActiveCommentId(commentId);
    markCommentsViewed();
  };

  const closeCommentPanel = () => {
    setActiveCommentId(null);
    setPendingAnchor(null);
  };

  const handleCreateComment = async (body: string) => {
    if (!pendingAnchor || !user) return;
    setCommentBusy(true);
    try {
      const newId = await commentService.addComment(id!, {
        ...pendingAnchor,
        authorId: user.uid,
        authorName,
        body,
      });
      // Phase 8: log the new comment to the workspace activity feed (fire-and-forget).
      activityService.logCommentCreated({
        workspaceId: board?.workspaceId ?? "",
        boardId: id!,
        commentId: newId,
        actorId: user.uid,
        actorName: authorName,
        anchorElementId: pendingAnchor.anchorElementId,
      });
      // Phase 10: fan @-mentions out to push + in-app notifications (fire-and-forget).
      const mentionUids = extractMentionUids(body);
      if (mentionUids.length > 0) {
        notifyMentions({
          mentionUids,
          actorId: user.uid,
          actorName: authorName,
          boardId: id!,
          boardTitle: board?.title ?? "a board",
          commentId: newId,
          body,
        });
      }
      setPendingAnchor(null);
      setActiveCommentId(newId);
      markCommentsViewed();
    } catch (e) {
      captureException(e, { op: "board.addComment" });
      setErrorMessage("Failed to add comment.");
    } finally {
      setCommentBusy(false);
    }
  };

  const handleReplyComment = async (body: string) => {
    if (!activeCommentId || !user) return;
    setCommentBusy(true);
    try {
      await commentService.addReply(id!, activeCommentId, {
        authorId: user.uid,
        authorName,
        body,
        createdAtMs: Date.now(),
      });
      // Phase 10: fan @-mentions in the reply out to notifications (fire-and-forget).
      const mentionUids = extractMentionUids(body);
      if (mentionUids.length > 0) {
        notifyMentions({
          mentionUids,
          actorId: user.uid,
          actorName: authorName,
          boardId: id!,
          boardTitle: board?.title ?? "a board",
          commentId: activeCommentId,
          body,
        });
      }
      markCommentsViewed();
    } catch (e) {
      captureException(e, { op: "board.replyComment" });
      setErrorMessage("Failed to add reply.");
    } finally {
      setCommentBusy(false);
    }
  };

  const handleToggleResolve = async () => {
    if (!activeComment) return;
    setCommentBusy(true);
    try {
      await commentService.setResolved(id!, activeComment.id, !activeComment.resolved);
    } catch (e) {
      captureException(e, { op: "board.resolveComment" });
      setErrorMessage("Failed to update comment.");
    } finally {
      setCommentBusy(false);
    }
  };

  const handleDeleteComment = async () => {
    if (!activeComment) return;
    setCommentBusy(true);
    try {
      await commentService.deleteComment(id!, activeComment.id);
      closeCommentPanel();
    } catch (e) {
      captureException(e, { op: "board.deleteComment" });
      setErrorMessage("Failed to delete comment.");
    } finally {
      setCommentBusy(false);
    }
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

  // Phase 7 — current board-space box of an element by id, across every kind, used
  // to resolve a comment pin's live position from its anchor. Returns null when the
  // element no longer exists (the comment is "detached").
  const boxOfElement = (elId: string, kind?: string): Bounds | null => {
    if (!kind || kind === "path") {
      const p = visiblePaths.find((x) => x.id === elId);
      if (p) return pathBox(p);
    }
    if (!kind || kind === "shape") {
      const s = visibleShapes.find((x) => x.id === elId);
      if (s) return shapeBox(s);
    }
    if (!kind || kind === "text") {
      const t = visibleTextElements.find((x) => x.id === elId);
      if (t) return textBox(t);
    }
    if (!kind || kind === "image") {
      const im = visibleImages.find((x) => x.id === elId);
      if (im) return imgBox(im);
    }
    if (!kind || kind === "note") {
      const n = visibleNotes.find((x) => x.id === elId);
      if (n) return { minX: n.position.x, minY: n.position.y, maxX: n.position.x, maxY: n.position.y };
    }
    return null;
  };

  // Resolve every comment to a screen pin at its anchored element. Detached
  // comments (anchor deleted) get no pin. Numbering is creation order over the
  // full set so it stays stable as pins appear/disappear. Memoized over the
  // element sets + comments so panning (cullViewport) doesn't recompute pins.
  const commentPins = useMemo<CommentPin[]>(() => {
    const out: CommentPin[] = [];
    comments.forEach((c, i) => {
      const box = boxOfElement(c.anchorElementId, c.anchorKind);
      if (!box) return;
      const last = commentService.lastActivityMs(c);
      out.push({
        id: c.id,
        x: box.minX + c.offsetX,
        y: box.minY + c.offsetY,
        number: i + 1,
        resolved: c.resolved,
        unread: last > commentsViewedAt && c.authorId !== user?.uid,
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, visiblePaths, visibleShapes, visibleTextElements, visibleImages, visibleNotes, commentsViewedAt, user]);

  const activeComment = activeCommentId
    ? comments.find((c) => c.id === activeCommentId) ?? null
    : null;
  const activeCommentDetached =
    !!activeComment && boxOfElement(activeComment.anchorElementId, activeComment.anchorKind) === null;

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
        workspaceId={board?.workspaceId ?? ""}
        ownerId={board?.ownerId ?? ""}
        roles={board?.roles ?? {}}
        isAdmin={isAdmin}
        onClose={() => setShareBoardModalVisible(false)}
        onMemberAdded={handleMemberAdded}
        onAccessChanged={({ members, roles }) =>
          setBoard((prev) => (prev ? { ...prev, members, roles } : prev))
        }
      />

      <BoardHistoryPanel
        visible={historyVisible}
        workspaceId={board?.workspaceId ?? ""}
        boardId={id!}
        onClose={() => setHistoryVisible(false)}
      />

      {/* Header — hidden in embed mode so the board fills the parent frame. */}
      {!embedMode && (
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
            followingId={followingId}
            onFollow={handleFollowUser}
          />
          <TouchableOpacity
            onPress={() => setBgPickerVisible(true)}
            style={styles.iconBtn}
            hitSlop={8}
          >
            <Ionicons name="grid-outline" size={20} color="#2563eb" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setHistoryVisible(true)}
            style={styles.iconBtn}
            hitSlop={8}
          >
            <Ionicons name="time-outline" size={20} color="#2563eb" />
          </TouchableOpacity>
          {/* Phase 12 — text → diagram. Opens the prompt sheet; gated OFF until the
              diagram flag + AI gateway are both on. */}
          {isDiagramConfigured() && (
            <TouchableOpacity
              onPress={() => setDiagramOpen(true)}
              style={styles.iconBtn}
              hitSlop={8}
            >
              <Ionicons name="git-network-outline" size={20} color="#2563eb" />
            </TouchableOpacity>
          )}
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
      )}

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
          onPointerMove={handlePointerMove}
          onPanBy={viewportCtl.panBy}
          onZoomAtPoint={viewportCtl.zoomAtPoint}
          onFling={viewportCtl.fling}
          onGestureStart={handleGestureStart}
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
            {/* Phase 7 — comment pins, in the same board-space overlay so they
                track the canvas. Hidden during a group transform to avoid clutter. */}
            {!dragOffset && !transformPreview && (
              <CommentPinLayer
                pins={commentPins}
                scale={viewport.scale}
                activeId={activeCommentId}
                onPressPin={openCommentThread}
              />
            )}
          </View>
        </View>
        {/* Phase 6 — live cursors. A separate, self-subscribing top layer so
            remote cursor updates repaint only this overlay, never the element
            tree (Appendix A.4). Shares the live viewport to track pan/zoom. */}
        <CursorLayer
          boardId={id!}
          viewport={viewport}
          selfId={user?.uid}
          blockedIds={blockedIds}
        />
        {/* Phase 7 — follow-mode indicator. Tapping it (or the canvas) exits. */}
        {followingId && (
          <TouchableOpacity style={styles.followBanner} onPress={exitFollow} activeOpacity={0.85}>
            <Ionicons name="eye-outline" size={15} color="#fff" />
            <Text style={styles.followBannerText} numberOfLines={1}>
              Following {presence.find((p) => p.userId === followingId)?.displayName ?? "user"}
            </Text>
            <Ionicons name="close" size={15} color="#fff" />
          </TouchableOpacity>
        )}
        {ENABLE_PAN_ZOOM && (
          <ZoomControls
            scale={viewport.scale}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onReset={handleResetViewport}
            onFit={handleFitToContent}
          />
        )}
        {/* Phase 9 — "perfect it?" prompt (ask mode). Anchored in screen-space
            just above the recognized stroke; accepting swaps it for a clean
            primitive, dismissing leaves the freehand stroke as-is. */}
        {perfectCandidate && (() => {
          const s = perfectCandidate.shape;
          const anchor = boardToScreen(viewport, {
            x: s.x + s.width / 2,
            y: Math.min(s.y, s.y + s.height),
          });
          return (
            <View
              style={[styles.perfectPrompt, { left: anchor.x - 70, top: anchor.y - 52 }]}
              pointerEvents="box-none"
            >
              <Ionicons name="sparkles-outline" size={15} color="#2563eb" />
              <Text style={styles.perfectPromptText}>Perfect it?</Text>
              <TouchableOpacity style={styles.perfectAccept} onPress={acceptPerfect}>
                <Ionicons name="checkmark" size={16} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.perfectDismiss} onPress={dismissPerfect}>
                <Ionicons name="close" size={16} color="#6b7280" />
              </TouchableOpacity>
            </View>
          );
        })()}
        {/* Phase 10 — OCR affordance. A "Recognize text" button below the
            selection while strokes are selected; tapping it OCRs the region into
            a text element. Hidden during a transform/drag and while a low-
            confidence confirm prompt is open. */}
        {isOcrConfigured() &&
          activeTool === "select" &&
          selection.count > 0 &&
          selectionUnion &&
          !transformPreview &&
          !dragOffset &&
          !ocrCandidate &&
          (() => {
            const u = selectionUnion;
            const anchor = boardToScreen(viewport, {
              x: (u.minX + u.maxX) / 2,
              y: u.maxY,
            });
            return (
              <View
                style={[styles.ocrButton, { left: anchor.x - 74, top: anchor.y + 10 }]}
                pointerEvents="box-none"
              >
                <TouchableOpacity
                  style={styles.ocrButtonInner}
                  onPress={handleRecognizeText}
                  disabled={ocrBusy}
                  activeOpacity={0.85}
                >
                  {ocrBusy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons name="text-outline" size={15} color="#fff" />
                  )}
                  <Text style={styles.ocrButtonText}>
                    {ocrBusy ? "Reading…" : "Recognize text"}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })()}
        {/* Phase 11 — "Explain this" affordance. Shown below the selection for any
            selection (strokes / text / image / mix); tapping it sends the region to
            the AI and drops a concept/explanation/example block beside it. Stacks
            below the OCR button when that one is also visible. */}
        {isExplainConfigured() &&
          activeTool === "select" &&
          selection.count > 0 &&
          selectionUnion &&
          !transformPreview &&
          !dragOffset &&
          !ocrCandidate &&
          (() => {
            const u = selectionUnion;
            const anchor = boardToScreen(viewport, {
              x: (u.minX + u.maxX) / 2,
              y: u.maxY,
            });
            const dy = isOcrConfigured() ? 52 : 10;
            return (
              <View
                style={[styles.explainButton, { left: anchor.x - 60, top: anchor.y + dy }]}
                pointerEvents="box-none"
              >
                <TouchableOpacity
                  style={styles.explainButtonInner}
                  onPress={handleExplainSelection}
                  disabled={explainBusy}
                  activeOpacity={0.85}
                >
                  {explainBusy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons name="bulb-outline" size={15} color="#fff" />
                  )}
                  <Text style={styles.explainButtonText}>
                    {explainBusy ? "Thinking…" : "Explain this"}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })()}
        {/* Phase 10 — low-confidence confirm prompt (Appendix B.7). The OCR was
            unsure, so the text is held back until the user accepts. */}
        {ocrCandidate && (() => {
          const anchor = boardToScreen(viewport, ocrCandidate.position);
          return (
            <View
              style={[styles.ocrPrompt, { left: anchor.x, top: anchor.y - 92 }]}
              pointerEvents="box-none"
            >
              <View style={styles.ocrPromptHeader}>
                <Ionicons name="alert-circle-outline" size={15} color="#b45309" />
                <Text style={styles.ocrPromptTitle}>
                  Low confidence ({Math.round(ocrCandidate.confidence * 100)}%)
                </Text>
              </View>
              <Text style={styles.ocrPromptText} numberOfLines={3}>
                {ocrCandidate.text}
              </Text>
              <View style={styles.ocrPromptActions}>
                <TouchableOpacity style={styles.ocrPromptDismiss} onPress={dismissOcr}>
                  <Text style={styles.ocrPromptDismissText}>Discard</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.ocrPromptAccept} onPress={acceptOcr}>
                  <Text style={styles.ocrPromptAcceptText}>Insert anyway</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })()}
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

      {/* Contextual pen options (Phase 9) — auto-perfect toggle, only while the
          pen tool is active and the viewer can edit. Hidden in embed mode. */}
      {activeTool === "pen" && canEdit && !embedMode && (
        <PenOptionsBar mode={shapeRecMode} onCycleMode={cycleShapeRecMode} />
      )}

      {/* Toolbar */}
      {/* Toolbar — hidden in embed mode (read-only viewer has no editing tools). */}
      {!embedMode && (
      <Toolbar
        activeTool={activeTool}
        activeColor={activeColor}
        activeStrokeWidth={activeStrokeWidth}
        isAdmin={isAdmin}
        canEdit={canEdit}
        canComment={canComment}
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
      )}

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

      {/* Comment thread / new-comment composer (Phase 7) */}
      <CommentThreadPanel
        visible={!!activeComment || !!pendingAnchor}
        comment={activeComment}
        currentUserId={user?.uid ?? ""}
        isAdmin={isAdmin}
        canComment={canComment}
        busy={commentBusy}
        detached={activeCommentDetached}
        members={mentionMembers}
        onCreate={handleCreateComment}
        onReply={handleReplyComment}
        onToggleResolve={handleToggleResolve}
        onDelete={handleDeleteComment}
        onClose={closeCommentPanel}
      />

      {isAdmin && (
        <StartSessionModal
          visible={sessionModalVisible}
          boardId={id!}
          workspaceId={board?.workspaceId ?? ""}
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

      {/* Phase 12 — text → diagram prompt sheet. */}
      {isDiagramConfigured() && (
        <DiagramPromptModal
          visible={diagramOpen}
          prompt={diagramPrompt}
          busy={diagramBusy}
          onChangePrompt={setDiagramPrompt}
          onGenerate={handleGenerateDiagram}
          onClose={() => {
            if (!diagramBusy) setDiagramOpen(false);
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
  followBanner: {
    position: "absolute",
    top: 12,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 240,
    backgroundColor: "#7c3aed",
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 20,
    zIndex: 120,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  followBannerText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
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
  ocrButton: {
    position: "absolute",
    zIndex: 130,
  },
  ocrButtonInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#2563eb",
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 5,
  },
  ocrButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
  },
  explainButton: {
    position: "absolute",
    zIndex: 130,
  },
  explainButtonInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#7c3aed",
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 5,
  },
  explainButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
  },
  ocrPrompt: {
    position: "absolute",
    width: 220,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#fcd34d",
    padding: 10,
    borderRadius: 12,
    gap: 6,
    zIndex: 130,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 5,
  },
  ocrPromptHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  ocrPromptTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#b45309",
  },
  ocrPromptText: {
    fontSize: 13,
    color: "#374151",
  },
  ocrPromptActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 2,
  },
  ocrPromptDismiss: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#f3f4f6",
  },
  ocrPromptDismissText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6b7280",
  },
  ocrPromptAccept: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#2563eb",
  },
  ocrPromptAcceptText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#fff",
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
