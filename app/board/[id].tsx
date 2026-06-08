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
import OfflineBanner from "../../src/components/OfflineBanner";
import { useAuth } from "../../src/hooks/useAuth";
import { useViewport } from "../../src/hooks/useViewport";
import { useThrottledValue } from "../../src/hooks/useThrottledValue";
import { useSelection } from "../../src/hooks/useSelection";
import { Point, Bounds, boundsOfPoints, unionBounds } from "../../src/lib/viewport";
import { viewportBounds, boundsIntersect } from "../../src/lib/culling";
import { pointNearPolyline, boundsContainPoint } from "../../src/lib/hitTest";
import { rdpSimplify } from "../../src/lib/simplify";
import * as boardService from "../../src/services/boardService";
import * as pathService from "../../src/services/pathService";
import * as snapshotService from "../../src/services/snapshotService";
import * as presenceService from "../../src/services/presenceService";
import * as friendService from "../../src/services/friendService";
import * as sessionService from "../../src/services/sessionService";
import { captureSvgAsPng } from "../../src/utils/canvasCapture";
import { captureException } from "../../src/lib/errorReporting";
import { reportSyncState } from "../../src/lib/connectivity";
import { Board, BoardPresence, DrawPath, Session, TextNote, TextElement } from "../../src/types";

type Tool = "pen" | "eraser" | "text" | "select";

// Phase 5 hit-testing tolerances (board units, before zoom). Selection adds a
// generous reach around the thin stroke geometry so taps land; the eraser reach
// is derived per-stroke from the active width.
const SELECT_TAP_PADDING = 10;
const ERASER_PAD = 10; // matches the legacy white-eraser render inflation

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
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user, userProfile } = useAuth();

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

  // Text element state
  const [textElements, setTextElements] = useState<TextElement[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  // Tool state
  const [activeTool, setActiveTool] = useState<Tool>("pen");
  const [activeColor, setActiveColor] = useState("#000000");
  const [activeStrokeWidth, setActiveStrokeWidth] = useState(5);

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

  const handleStrokeStart = () => {
    if (!isDrawingTool) return;
    lastSampleRef.current = 0; // first move of a new stroke always records
    if (activeTool === "eraser") erasedIdsRef.current = new Set();
    setCurrentPoints([]);
  };

  const handleStrokeMove = (point: { x: number; y: number }) => {
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
    if (selection.selectedId && hits.includes(selection.selectedId)) selection.clear();
    hits.forEach((pathId) => {
      pathService.deletePath(id!, pathId).catch((e) => {
        captureException(e, { op: "board.erase" });
        setErrorMessage("Some strokes couldn't be erased.");
      });
    });
    scheduleSave();
  };

  // --- Selection: tap a stroke to select it (topmost wins) ---

  const selectAtPoint = (point: Point) => {
    // Iterate newest-first so the most recently drawn stroke under the tap wins.
    for (let i = visiblePathsRef.current.length - 1; i >= 0; i--) {
      const p = visiblePathsRef.current[i];
      const reach = SELECT_TAP_PADDING + p.strokeWidth / 2;
      if (p.bbox && !boundsContainPoint(p.bbox, point, reach)) continue;
      if (pointNearPolyline(p.points, point, reach)) {
        selection.select(p.id);
        setSelectedTextId(null);
        setEditingTextId(null);
        return;
      }
    }
    selection.clear();
  };

  const { selectedId, clear: clearSelection } = selection;
  const handleDeleteSelectedPath = useCallback(async () => {
    if (!selectedId) return;
    clearSelection();
    setPaths((prev) => prev.filter((p) => p.id !== selectedId));
    try {
      await pathService.deletePath(id!, selectedId);
      scheduleSave();
    } catch (e) {
      captureException(e, { op: "board.deleteSelected" });
      setErrorMessage("Failed to delete element.");
    }
  }, [id, selectedId, clearSelection, scheduleSave]);

  // --- Canvas tap (point is board-space) ---

  const handleCanvasTap = (point: Point) => {
    if (activeTool === "select") {
      selectAtPoint(point);
      return;
    }
    if (activeTool === "text") {
      if (selectedTextId || editingTextId) {
        // First tap on blank canvas deselects the active element
        setSelectedTextId(null);
        setEditingTextId(null);
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
      setSelectedTextId(elId);
      setEditingTextId(elId);
      scheduleSave();
    } catch {
      setErrorMessage("Failed to create text element.");
    }
  };

  const handleTextSelect = (elementId: string) => {
    setSelectedTextId(elementId);
    setEditingTextId(elementId);
  };

  const handleTextBlur = async (elementId: string, text: string) => {
    setEditingTextId(null);
    setSelectedTextId(null);
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
      ]);
      setPaths([]);
      setNotes([]);
      setTextElements([]);
      setSelectedTextId(null);
      setEditingTextId(null);
      selection.clear();
      setRedoStack([]);
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to clear board");
    }
  };

  const handleColorChange = (color: string) => {
    setActiveColor(color);
    if (selectedTextId) {
      pathService.updateTextElement(id!, selectedTextId, { color }).catch(() => setErrorMessage("Color update failed."));
      setTextElements((prev) =>
        prev.map((el) => (el.id === selectedTextId ? { ...el, color } : el))
      );
    }
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
      setSelectedTextId(null);
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

  // Filter out blocked users' content. Memoized so the culling pass below (and
  // fit-to-content) see a stable array identity between renders.
  const visiblePaths = useMemo(
    () => paths.filter((p) => !blockedIds.includes(p.userId)),
    [paths, blockedIds]
  );
  const visibleNotes = useMemo(
    () => notes.filter((n) => !blockedIds.includes(n.userId)),
    [notes, blockedIds]
  );
  const visibleTextElements = useMemo(
    () => textElements.filter((el) => !blockedIds.includes(el.userId)),
    [textElements, blockedIds]
  );

  // Keep the synchronous hit-test source (eraser/select) current.
  useEffect(() => {
    visiblePathsRef.current = visiblePaths;
  }, [visiblePaths]);

  // Drop a stroke selection when leaving the select tool.
  useEffect(() => {
    if (activeTool !== "select") clearSelection();
  }, [activeTool, clearSelection]);

  // The selected stroke (for the bounding-box overlay), if it still exists.
  const selectedPath = useMemo(
    () => (selection.selectedId ? visiblePaths.find((p) => p.id === selection.selectedId) ?? null : null),
    [selection.selectedId, visiblePaths]
  );
  const selectedPathBounds = useMemo(() => {
    if (!selectedPath) return null;
    return selectedPath.bbox ?? boundsOfPoints(selectedPath.points);
  }, [selectedPath]);

  // Web: Delete/Backspace removes the selected stroke (mobile uses the trash
  // affordance on the overlay). Ignore while editing text so it stays a normal
  // backspace there.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (editingTextId) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selection.selectedId) {
        e.preventDefault();
        handleDeleteSelectedPath();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selection.selectedId, editingTextId, handleDeleteSelectedPath]);

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
          currentPath={currentPoints}
          color={activeColor}
          strokeWidth={activeStrokeWidth}
          tool={activeTool === "eraser" ? "eraser" : "pen"}
          viewport={viewport}
          enablePanZoom={ENABLE_PAN_ZOOM}
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
            {culledTextElements.map((el) => (
              <TextElementView
                key={el.id}
                element={el}
                isSelected={selectedTextId === el.id}
                isEditing={editingTextId === el.id}
                scale={viewport.scale}
                onSelect={handleTextSelect}
                onBlur={handleTextBlur}
                onResize={handleTextResize}
                onDelete={el.userId === user?.uid || isAdmin ? handleTextDelete : undefined}
              />
            ))}
            {selectedPathBounds && (
              <SelectionOverlay
                bounds={selectedPathBounds}
                scale={viewport.scale}
                onDelete={handleDeleteSelectedPath}
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

      {/* Toolbar */}
      <Toolbar
        activeTool={activeTool}
        activeColor={activeColor}
        activeStrokeWidth={activeStrokeWidth}
        isAdmin={isAdmin}
        onToolChange={setActiveTool}
        onColorChange={handleColorChange}
        onStrokeWidthChange={setActiveStrokeWidth}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canRedo={redoStack.length > 0}
        onClear={handleClear}
        onSave={handleSave}
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
