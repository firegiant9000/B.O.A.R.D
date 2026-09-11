import { useCallback, useEffect, useRef, useState } from "react";
import { ShortcutAction, CommandName } from "../lib/shortcuts";
import { Point } from "../lib/viewport";
import type { Bounds } from "../lib/viewport";
import {
  ShapeDraft,
  Guide,
  GRID_SIZES,
  GUIDE_TOLERANCE,
  MIN_SHAPE_SIZE,
  SHAPE_FILL_ALPHA,
  shapeBbox,
  snapPoint,
  constrainDraft,
  rectFromPoints,
  computeGuides,
  hexToRgba,
} from "../lib/shapes";
import { ArrowheadStyle, ShapeKind, ShapeRecognitionMode } from "../types";
import type { RecognizedShape } from "../lib/shapeRecognition";
import * as shapeRecognitionService from "../services/shapeRecognitionService";
import { captureException } from "../lib/errorReporting";
import { useShortcuts } from "./useShortcuts";
import { PenStyle, DEFAULT_ALPHA_FOR_STYLE } from "../lib/penStyles";

/**
 * The board's tool state (Month 5/6 Task 1 — extracted verbatim from
 * `app/board/[id].tsx`).
 *
 * Owns the active tool, the pen/shape style defaults, the contextual shape and
 * pen option state, the in-progress shape draft (with snap-to-grid, shift-
 * constrain and smart guides), and the keyboard-shortcut wiring.
 *
 * It never reaches into the element model: the screen passes the shape tool's
 * guide targets in as an argument and routes every non-tool shortcut back
 * through `onCommand`, so this hook composes with anything.
 *
 * NOTE: the plan's signature for this hook is `useBoardTools(boardId)`, but none
 * of its state is per-board — the tool defaults are session state and the
 * auto-perfect mode is per-*user* — so it takes the options bag alone rather
 * than carrying a dead parameter.
 */

/** The board's tools. A superset of `shortcuts.ts`'s `Tool` (which omits `comment`). */
export type Tool = "pen" | "eraser" | "text" | "select" | "shape" | "hand" | "comment" | "laser";

const ARROWHEAD_CYCLE: ArrowheadStyle[] = ["classic", "dot", "circle", "open", "none"];
const SNAP_CYCLE = [0, ...GRID_SIZES];

// Month 5 (ROADMAP item 12) — how many recently-used colours the picker's
// "recent" row keeps. Session-scoped only (plain `useState`, not persisted
// anywhere): a scoping choice for this pass, not an oversight — the
// per-workspace swatch row (workspaceService.ts) is the durable, shared
// palette; this row is a per-session convenience for "the last few colours
// I actually used," which resetting on reload is fine for.
const MAX_RECENT_COLORS = 8;

/** The "ask"-mode auto-perfect candidate: a just-saved stroke and its clean twin. */
export interface PerfectCandidate {
  pathId: string;
  shape: RecognizedShape;
  color: string;
  strokeWidth: number;
}

export interface BoardToolsOptions {
  /** Signed-in uid — the auto-perfect mode is stored on the user doc. */
  userId: string | undefined;
  /** Master switch for the keyboard listener — false while the board loads. */
  enabled: boolean;
  /** Id of the text element being edited inline; suppresses shortcuts while typing. */
  editingTextId: string | null;
  /** Web Shift/Alt tracking. Screen-owned, because the transform gesture reads it too. */
  onModifiers: (m: { shift: boolean; alt: boolean }) => void;
  /** Every non-tool shortcut action, dispatched by the screen. */
  onCommand: (name: CommandName) => void;
}

export interface BoardTools {
  activeTool: Tool;
  setActiveTool: (tool: Tool) => void;
  /** Switch to the select tool — new content lands ready to move. */
  activateSelect: () => void;
  activeColor: string;
  setActiveColor: (color: string) => void;
  activeStrokeWidth: number;
  setActiveStrokeWidth: (w: number) => void;

  // Colour + stroke polish (Month 5, ROADMAP item 12)
  /** Stroke alpha (0-1) for new pen strokes — see `DrawPath.opacity`. */
  activeAlpha: number;
  setActiveAlpha: (a: number) => void;
  /** The active pen variant. Changing it also resets `activeAlpha` to that
   *  variant's own default (see `chooseColor`'s sibling doc below) so
   *  switching to the highlighter is translucent immediately, not only after
   *  a user finds the alpha slider themselves. */
  activePenStyle: PenStyle;
  setActivePenStyle: (style: PenStyle) => void;
  /** Sets the active colour AND records it on the recent-colours row
   *  (deduped, newest-first, capped) — the one entry point every colour
   *  choice (hex input, workspace swatch tap, eyedropper sample) should go
   *  through instead of calling `setActiveColor` + hand-rolling the recents
   *  list at each call site. */
  chooseColor: (hex: string) => void;
  recentColors: string[];
  /** True while the eyedropper is armed: the *next* canvas tap samples a
   *  colour instead of acting on the current tool (see `BoardCanvas.tsx`'s
   *  `handleCanvasTap`/`handleStrokeStart`), then auto-disarms either way. */
  eyedropperArmed: boolean;
  armEyedropper: () => void;
  disarmEyedropper: () => void;
  /** What the eyedropper's own toolbar button toggles — arms it if idle,
   *  disarms it if already armed (a second tap cancels picking). */
  toggleEyedropper: () => void;

  // Shape tool (Phase 7)
  activeShapeKind: ShapeKind;
  setActiveShapeKind: (kind: ShapeKind) => void;
  shapeFillEnabled: boolean;
  toggleShapeFill: () => void;
  shapeDashed: boolean;
  toggleShapeDashed: () => void;
  shapeArrowheadEnd: ArrowheadStyle;
  cycleArrowhead: () => void;
  snapGrid: number;
  cycleSnap: () => void;

  /** The live shape draft, or null when no shape drag is in flight. */
  shapeDraft: ShapeDraft | null;
  /** Smart-guide lines for the live draft. */
  guides: Guide[];
  /** Start a shape drag: clears the previous draft. */
  beginShapeDraft: () => void;
  /**
   * Advance the shape drag. `guideTargets` are the on-screen shapes' boxes,
   * passed in by the screen so this hook never reads the element model.
   */
  moveShapeDraft: (point: Point, shiftHeld: boolean, guideTargets: Bounds[]) => void;
  /** End the shape drag; returns the draft to persist, or null for a stray tap. */
  endShapeDraft: () => ShapeDraft | null;

  // Auto-perfect (Phase 9)
  shapeRecMode: ShapeRecognitionMode;
  cycleShapeRecMode: () => void;
  perfectCandidate: PerfectCandidate | null;
  setPerfectCandidate: (c: PerfectCandidate | null) => void;
  dismissPerfect: () => void;

  // Keyboard (Phase 11)
  /** True while Space is held on web — a transient Hand tool. */
  spacePanActive: boolean;
  cheatSheetVisible: boolean;
  hideCheatSheet: () => void;
  toggleCheatSheet: () => void;
}

export function useBoardTools(opts: BoardToolsOptions): BoardTools {
  const { userId, enabled, editingTextId, onModifiers, onCommand } = opts;

  // Tool state
  const [activeTool, setActiveTool] = useState<Tool>("pen");
  const [activeColor, setActiveColor] = useState("#000000");
  const [activeStrokeWidth, setActiveStrokeWidth] = useState(5);

  // Colour + stroke polish (Month 5, ROADMAP item 12)
  const [activeAlpha, setActiveAlpha] = useState(1);
  const [activePenStyle, setActivePenStyleRaw] = useState<PenStyle>("pen");
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [eyedropperArmed, setEyedropperArmed] = useState(false);

  const setActivePenStyle = useCallback((style: PenStyle) => {
    setActivePenStyleRaw(style);
    setActiveAlpha(DEFAULT_ALPHA_FOR_STYLE[style]);
  }, []);

  const chooseColor = useCallback((hex: string) => {
    setActiveColor(hex);
    setRecentColors((prev) => [hex, ...prev.filter((c) => c !== hex)].slice(0, MAX_RECENT_COLORS));
  }, []);

  const armEyedropper = useCallback(() => setEyedropperArmed(true), []);
  const disarmEyedropper = useCallback(() => setEyedropperArmed(false), []);
  const toggleEyedropper = useCallback(() => setEyedropperArmed((v) => !v), []);

  // Shape tool state (Phase 7)
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
  const [perfectCandidate, setPerfectCandidate] = useState<PerfectCandidate | null>(null);

  // Phase 11: keyboard shortcuts. The `?` cheat sheet, and a transient pan mode
  // while Space is held on web (the Hand tool is the persistent equivalent).
  const [cheatSheetVisible, setCheatSheetVisible] = useState(false);
  const [spacePanActive, setSpacePanActive] = useState(false);

  // First corner of the in-progress shape drag, and the live draft (ref mirror of
  // state so the gesture's onEnd reads the latest without a stale closure).
  const shapeStartRef = useRef<Point | null>(null);
  const shapeDraftRef = useRef<ShapeDraft | null>(null);
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
    if (!userId) return;
    let cancelled = false;
    shapeRecognitionService.getShapeRecognitionMode(userId).then((m) => {
      if (!cancelled) setShapeRecMode(m);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Cycle the auto-perfect mode (Ask → Always → Off) and persist it. Clears any
  // pending prompt when switching off.
  const cycleShapeRecMode = useCallback(() => {
    setShapeRecMode((cur) => {
      const next: ShapeRecognitionMode =
        cur === "ask" ? "always" : cur === "always" ? "never" : "ask";
      if (next === "never") setPerfectCandidate(null);
      if (userId) {
        shapeRecognitionService
          .setShapeRecognitionMode(userId, next)
          .catch((e) => captureException(e, { op: "board.setShapeRecMode" }));
      }
      return next;
    });
  }, [userId]);

  // Shape-option cycles for the contextual ShapeOptionsBar.
  const cycleSnap = () =>
    setSnapGrid((g) => SNAP_CYCLE[(SNAP_CYCLE.indexOf(g) + 1) % SNAP_CYCLE.length]);
  const cycleArrowhead = () =>
    setShapeArrowheadEnd(
      (a) => ARROWHEAD_CYCLE[(ARROWHEAD_CYCLE.indexOf(a) + 1) % ARROWHEAD_CYCLE.length]
    );

  // --- Shape draft ---

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

  const beginShapeDraft = () => {
    shapeStartRef.current = null;
    shapeDraftRef.current = null;
    setShapeDraft(null);
    setGuides([]);
  };

  const moveShapeDraft = (point: Point, shiftHeld: boolean, guideTargets: Bounds[]) => {
    const cfg = shapeCfgRef.current;
    // First move of the drag fixes the start corner (snapped if grid is on).
    if (!shapeStartRef.current) {
      shapeStartRef.current = cfg.snapGrid > 0 ? snapPoint(point, cfg.snapGrid) : point;
      return;
    }
    const start = shapeStartRef.current;
    let end = cfg.snapGrid > 0 ? snapPoint(point, cfg.snapGrid) : point;
    if (shiftHeld) end = constrainDraft(cfg.kind, start, end);
    let draft = buildDraft(start, end);
    // Smart guides: align the draft's box to nearby shapes (8px tolerance).
    const g = computeGuides(shapeBbox(draft), guideTargets, GUIDE_TOLERANCE);
    if (g.dx || g.dy) draft = buildDraft(start, { x: end.x + g.dx, y: end.y + g.dy });
    shapeDraftRef.current = draft;
    setShapeDraft(draft);
    setGuides(g.guides);
  };

  const endShapeDraft = (): ShapeDraft | null => {
    const draft = shapeDraftRef.current;
    shapeStartRef.current = null;
    shapeDraftRef.current = null;
    setShapeDraft(null);
    setGuides([]);
    // Discard a stray tap / near-zero drag.
    if (!draft || (Math.abs(draft.width) < MIN_SHAPE_SIZE && Math.abs(draft.height) < MIN_SHAPE_SIZE)) {
      return null;
    }
    return draft;
  };

  // --- Phase 11: keyboard shortcuts ---

  // Ref so the shortcut callbacks always see the current editing id without
  // re-binding the (stable) DOM/native listeners.
  const editingTextIdRef = useRef<string | null>(null);
  useEffect(() => {
    editingTextIdRef.current = editingTextId;
  }, [editingTextId]);

  // The single resolved-action dispatcher. Kept on a ref and refreshed every
  // render so the (stable) listener callbacks always see the latest handlers
  // without re-binding DOM/native listeners on each render.
  const dispatchShortcutRef = useRef<(action: ShortcutAction) => void>(() => {});
  dispatchShortcutRef.current = (action: ShortcutAction) => {
    if (action.type === "tool") {
      setActiveTool(action.tool);
      // Leaving `select` drops the selection and closes the inline editor — the
      // exact body of the `deselect` command, so it routes through it.
      if (action.tool !== "select") onCommand("deselect");
      return;
    }
    if (action.type === "shape") {
      setActiveTool("shape");
      setActiveShapeKind(action.shape);
      return;
    }
    onCommand(action.name);
  };

  const onShortcutAction = useCallback((action: ShortcutAction) => {
    dispatchShortcutRef.current(action);
  }, []);
  const isEditingText = useCallback(() => editingTextIdRef.current !== null, []);

  useShortcuts({
    enabled,
    isEditingText,
    onAction: onShortcutAction,
    onModifiers,
    onSpace: setSpacePanActive,
  });

  // (Shift/Alt tracking for shape-constrain + non-uniform resize is handled by
  // useShortcuts' `onModifiers`, which the screen owns because the transform
  // gesture in useBoardElements reads the same flags.)

  const activateSelect = useCallback(() => setActiveTool("select"), []);

  return {
    activeTool,
    setActiveTool,
    activateSelect,
    activeColor,
    setActiveColor,
    activeStrokeWidth,
    setActiveStrokeWidth,

    activeAlpha,
    setActiveAlpha,
    activePenStyle,
    setActivePenStyle,
    chooseColor,
    recentColors,
    eyedropperArmed,
    armEyedropper,
    disarmEyedropper,
    toggleEyedropper,

    activeShapeKind,
    setActiveShapeKind,
    shapeFillEnabled,
    toggleShapeFill: () => setShapeFillEnabled((v) => !v),
    shapeDashed,
    toggleShapeDashed: () => setShapeDashed((v) => !v),
    shapeArrowheadEnd,
    cycleArrowhead,
    snapGrid,
    cycleSnap,

    shapeDraft,
    guides,
    beginShapeDraft,
    moveShapeDraft,
    endShapeDraft,

    shapeRecMode,
    cycleShapeRecMode,
    perfectCandidate,
    setPerfectCandidate,
    dismissPerfect: () => setPerfectCandidate(null),

    spacePanActive,
    cheatSheetVisible,
    hideCheatSheet: () => setCheatSheetVisible(false),
    toggleCheatSheet: () => setCheatSheetVisible((v) => !v),
  };
}
