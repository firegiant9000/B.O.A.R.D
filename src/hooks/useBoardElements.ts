import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform } from "react-native";
import {
  Point,
  Bounds,
  Viewport,
  boundsOfPoints,
  unionBounds,
  inflateBounds,
  screenToBoard,
} from "../lib/viewport";
import { viewportBounds, boundsIntersect } from "../lib/culling";
import { pointNearPolyline, boundsContainPoint, distanceToSegment } from "../lib/hitTest";
import { rdpSimplify } from "../lib/simplify";
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
} from "../lib/transform";
import type { HandleId } from "../components/SelectionOverlay";
import {
  ElementKind,
  IndexEntry,
  ElementIndex,
  buildElementIndex,
  entryFromBounds,
  queryBounds,
} from "../lib/spatialIndex";
import { ShapeDraft, SHAPE_FILL_ALPHA, shapeBbox, hexToRgba } from "../lib/shapes";
import { persistedStyleFields } from "../lib/penStyles";
import { imageBbox, placementBox, PreparedImage } from "../lib/images";
import { pickAndPrepareImage, prepareWebFile, prepareNativeImageUri, ImageSource } from "../lib/imagePicker";
import { getClipboardImage } from "../lib/osClipboard";
import {
  ClipItem,
  setClipboard,
  getClipboard,
  hasClipboard,
  nextPasteOffset,
  offsetClipItem,
} from "../lib/clipboard";
import * as pathService from "../services/pathService";
import * as shapeService from "../services/shapeService";
import * as imageService from "../services/imageService";
import * as scanService from "../services/scanService";
import * as audioService from "../services/audioService";
import * as mathService from "../services/mathService";
import * as snapshotService from "../services/snapshotService";
import { captureException } from "../lib/errorReporting";
import { reportSyncState } from "../lib/connectivity";
import type { RecognizedShape } from "../lib/shapeRecognition";
import type { DiagramBuild } from "../lib/mermaid-to-board";
import {
  DrawPath,
  TextNote,
  TextElement,
  ShapeElement,
  ImageElement,
  AudioElement,
  MathElement,
} from "../types";
import { useSelection, SelectionController } from "./useSelection";
import { useThrottledValue } from "./useThrottledValue";

/**
 * The board's element model (Month 5/6 Task 1 — extracted verbatim from
 * `app/board/[id].tsx`).
 *
 * One hook owns everything about the content on the canvas: the five realtime
 * collections, the Phase 7 snapshot cold-load + checkpoint trigger, the blocked-
 * user filter and z-order, the Phase 4 viewport culling, the rbush marquee index,
 * hit-testing, and every write path (draw, erase, move/resize/rotate, delete,
 * duplicate, clipboard, z-order, recolor, images, text elements, sticky notes).
 *
 * It also owns the **selection** slice: it calls `useSelection()` itself rather
 * than receiving a controller, so no other hook has to be threaded through it.
 * Every element write reads the selection directly, exactly as the screen used to.
 *
 * Everything the hook needs from the rest of the screen arrives as plain data or
 * a screen-owned callback (`opts`) — never as another hook's return value — so the
 * screen stays the single composition point.
 */

/*
 * SECTION MAP  — this file is long by design (see the Task 1 report, concern 2);
 * the sections below are the navigation. Each is marked in the source by a
 * matching `// ──── NAME ────` banner, in this order.
 *
 * Adding a new element kind touches the five sections flagged ADD HERE, in order:
 * its listener, its blocked-filter memo and sync ref, the spatial index, its
 * culling memo, and the returned object — plus whichever write paths it needs.
 *
 *   128  MODULE CONSTANTS & PURE GEOMETRY HELPERS       tolerances, cull settings, handle geometry, planZOrder, box helpers
 *   241  PUBLIC TYPES & THE BoardElements INTERFACE     start here: the contract every caller sees
 *   521  STATE & REFS                                   element arrays, selection, gesture refs, snapshot refs
 *   619  SUBSCRIPTIONS & SNAPSHOT CHECKPOINTING         ADD A NEW ELEMENT KIND'S LISTENER HERE
 *   746  BLOCKED-USER FILTER, Z-ORDER & HIT-TEST REFS   ADD A NEW KIND'S visible* MEMO + SYNC REF HERE
 *   845  SPATIAL INDEX (rbush, for marquee hit-testing) ADD A NEW KIND TO THE INDEX ENTRIES HERE
 *   860  VIEWPORT CULLING                               ADD A NEW KIND'S culled* MEMO HERE
 *   913  GEOMETRY & DERIVED SELECTION                   contentBounds, boxOfElement, selectedBoxes, selectionUnion
 *   994  HIT-TESTING & SELECTION ACTIONS                hitTestShape, hitTestAny, selectAtPoint, selectAllVisible
 *  1112  WRITE PATH — ERASER                            eraseAtPointWith
 *  1149  WRITE PATH — GROUP MOVE                        commitMove
 *  1228  GESTURE — SELECT / MARQUEE DRAG                begin/move/endSelectGesture
 *  1293  GESTURE — RESIZE / ROTATE                      begin/move/endTransform + commitResize + commitRotate
 *  1540  WRITE PATH — STROKES                           commitStroke, drawDot, replaceStrokeWithShape
 *  1648  WRITE PATH — SHAPES & DIAGRAMS                 saveShapeFromDraft, createDiagram
 *  1712  WRITE PATH — GROUP OPERATIONS                  deleteSelected, duplicateSelected
 *  1850  WRITE PATH — CLIPBOARD                         copySelected, pasteClipboard, shortcutPaste, DOM paste listener
 *  1947  WRITE PATH — IMAGES                            uploadPreparedImage, insertImage, scanDocument, pasteExternalImage
 *  2120  WRITE PATH — Z-ORDER                           reorderSelected, bringToFront, sendToBack
 *  2156  WRITE PATH — STYLE                             applyColor, applyStrokeWidth
 *  2257  WRITE PATH — TEXT ELEMENTS                     create/commitEdit/resize/delete/saveTextElement
 *  2336  WRITE PATH — MATH ELEMENTS                     createMathElement, updateMathLatex, latexOfMathElement
 *  2377  WRITE PATH — STICKY NOTES (legacy)             submitNote, cancelNote, deleteNote
 *  2417  WRITE PATH — UNDO / REDO / CLEAR               undo, redo, clearBoardElements, resetLocalElements
 *  2489  DERIVED GESTURE PREVIEW                        selectedTransform, overlayBounds, overlayRotation, previewText
 *  2542  RETURN                                         ADD A NEW MEMBER TO THE RETURNED OBJECT HERE
 */

// ────────── MODULE CONSTANTS & PURE GEOMETRY HELPERS ────────────────────

// Phase 5 hit-testing tolerances (board units, before zoom). Selection adds a
// generous reach around the thin stroke geometry so taps land; the eraser reach
// is derived per-stroke from the active width.
const SELECT_TAP_PADDING = 10;
const ERASER_PAD = 10; // matches the legacy white-eraser render inflation

// Phase 3 write-path perf: simplify with RDP (board-space tolerance, ≈px at 100%
// zoom) before persisting.
const RDP_TOLERANCE = 2.5;

// Phase 4 viewport culling: re-evaluate which elements are on screen at most
// every CULL_THROTTLE_MS during pan/zoom, keeping a CULL_MARGIN_PX screen-space
// buffer ring mounted so panned-in content never pops in a frame late.
const CULL_THROTTLE_MS = 50;
const CULL_MARGIN_PX = 200;

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

// Filter out blocked users' content, then order by z (Phase 8 z-order) so the
// render order — and the newest-first hit-test that walks from the end — both
// reflect the layer stack. Docs predating `z` read as 0 and keep their
// createdAt order (the incoming arrays are already createdAt-asc, and sort is
// stable).
const byZ = <T extends { z?: number }>(a: T, b: T) => (a.z ?? 0) - (b.z ?? 0);

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
// Month 6 — math elements. `width`/`height` are already the RENDERED box
// (natural size × `scale` — see MathElement's type comment), so this is the
// same x+width arithmetic as a text element's, not a re-derivation from the
// path data. Routed through mathService so the box is defined in exactly one
// place for the service, this hook and the canvas alike.
const mathBox = (m: MathElement): Bounds => mathService.mathElementBbox(m);
// The same box computed from geometry ALONE. Every write path below that has
// just changed x/y/width/height must use this one: `mathBox` deliberately
// prefers the element's stored `bbox`, so spreading new geometry over an old
// element and passing it there hands back the PRE-change box.
const mathBoxOf = mathService.mathBoxOf;

// Floor for a math element's `scale` under a resize drag. An equation scaled
// to zero is invisible and (being zero-area) untappable, so it could never be
// scaled back up or selected to delete.
const MIN_MATH_SCALE = 0.05;

// ────────── PUBLIC TYPES & THE BoardElements INTERFACE ──────────────────
/** A resolved hit-test result: which element, and which layer it lives in. */
export interface ElementHit {
  id: string;
  kind: ElementKind;
}

/** Month 5 (ROADMAP item 12) — the pen-variant/alpha pair `commitStroke`/
 *  `drawDot` accept, mirroring `DrawPath.penStyle`/`opacity`. */
export interface PenStrokeStyle {
  penStyle?: DrawPath["penStyle"];
  opacity?: number;
}

/** Live group-gesture preview: a resize about an anchor, or a rotation about a pivot. */
export type TransformPreview =
  | { mode: "resize"; anchor: Point; sx: number; sy: number; bounds: Bounds }
  | { mode: "rotate"; center: Point; theta: number };

/** Everything the element model needs from the rest of the screen. */
export interface BoardElementsOptions {
  /**
   * Viewer uid. Undefined before sign-in resolves — new docs fall back to an
   * empty string (as they always have), but ownership comparisons keep the
   * undefined so an unauthenticated viewer never matches an empty-uid doc.
   */
  userId: string | undefined;
  /** Canvas layout size — the culling window, and the image/paste placement box. */
  canvasSize: { width: number; height: number };
  /** Uids whose content the viewer has blocked; filtered out of every layer. */
  blockedIds: string[];
  /** Id of the text element being edited inline, or null. */
  editingTextId: string | null;
  /** True when the viewer is the board admin (undo reaches other users' strokes). */
  isAdmin: boolean;
  /** Alt held (web) → non-uniform corner resize. Read mid-gesture, so it's a getter. */
  isAltHeld: () => boolean;
  /** Open the inline text editor on `id`, or close it with null. */
  onEditText: (id: string | null) => void;
  /** Make `select` the active tool, so new content lands ready to move. */
  onActivateSelectTool: () => void;
  /** Bump the board's `updatedAt` (debounced by the screen). */
  onScheduleSave: () => void;
  /** Surface a user-facing failure in the screen's error banner. */
  onError: (message: string) => void;
  /** Month 6 — a scan's OCR step was denied `resource-exhausted` (the AI-call
   *  quota or the workspace rate throttle; the server doesn't distinguish
   *  them). The SAME callback `useBoardAI`'s `BoardAIBridge.onQuotaExceeded`
   *  uses, so Scan and the toolbar's "Recognize text" show one consistent
   *  upsell instead of two different behaviors for the same underlying
   *  denial. Never fired for any other OCR failure (disabled, no legible
   *  text, network) — those stay silent, matching `scanDocument`'s "a failed
   *  OCR never blocks or undoes the capture" contract. */
  onQuotaExceeded: () => void;
}

export interface BoardElements {
  paths: DrawPath[];
  shapes: ShapeElement[];
  texts: TextElement[];
  notes: TextNote[];
  images: ImageElement[];
  /** Voice notes (Month 5). Unlike every other array here, this is NOT run
   *  through the rbush spatial index / hit-testing / viewport culling —
   *  it's a lightweight badge layer (like `commentPins`, also unculled),
   *  not a selectable/movable canvas primitive. Each note carries its own
   *  `x`/`y` (see AudioElement's type comment), so a renderer needs nothing
   *  from its anchor beyond `anchorElementId` to know one exists. */
  audioNotes: AudioElement[];
  /** Math elements (Month 6). A full canvas primitive, unlike `audioNotes`:
   *  indexed, culled, hit-tested, selectable and transformable exactly like
   *  shapes and images, because it renders as an ordinary `<Path>`. */
  mathElements: MathElement[];
  /** Viewport-culled subsets the canvas actually renders. */
  visible: {
    paths: DrawPath[];
    shapes: ShapeElement[];
    texts: TextElement[];
    notes: TextNote[];
    images: ImageElement[];
    /** Blocked-user filtered, like every other `visible.*` array — NOT
     *  viewport-culled (see `audioNotes` above). */
    audioNotes: AudioElement[];
    mathElements: MathElement[];
  };
  /** True until the first Firestore snapshot (or snapshot cold-load) arrives. */
  loading: boolean;

  // --- Selection (owned here so element writes read it directly) ---
  selection: SelectionController;
  /** Board-space boxes of every selected element, mixed kinds. */
  selectedBoxes: Bounds[];
  /** Union of `selectedBoxes`, for the group overlay. Null when nothing is selected. */
  selectionUnion: Bounds | null;
  selectAllVisible: () => void;

  // --- Live gesture preview ---
  dragOffset: { dx: number; dy: number } | null;
  marquee: Bounds | null;
  transformPreview: TransformPreview | null;
  /** SVG transform string for the selected nodes during a live gesture. */
  selectedTransform: string | undefined;
  /** Bounds the selection overlay should draw, following the live gesture. */
  overlayBounds: Bounds | null;
  /** Degrees the selection overlay should be rotated by, following a live rotate. */
  overlayRotation: number;
  /** Apply the active live transform to a text element so its preview matches SVG. */
  previewText: (el: TextElement) => TextElement;

  // --- Geometry / hit-testing ---
  /** Board-space bounds of all content, for fit-to-content. */
  contentBounds: () => Bounds | null;
  /** Current board-space box of an element by id, or null when it no longer exists. */
  boxOfElement: (elId: string, kind?: string) => Bounds | null;
  /** Topmost element under a board-space point, across all kinds. */
  hitTestAny: (point: Point) => ElementHit | null;
  /**
   * Month 5 (ROADMAP item 12 — eyedropper). The sampleable colour of an
   * already-hit element (from `hitTestAny`/`ElementHit`), or `null` for a
   * kind that carries no single colour (an image) or an id no longer in the
   * visible set. Deliberately NOT a second hit-test: this only resolves a
   * colour for an element `hitTestAny` already found, so the eyedropper
   * reuses the exact same picking path as tap-to-select instead of adding a
   * new one — see `src/lib/hitTest.ts`'s header and `BoardCanvas.tsx`'s
   * eyedropper wiring.
   */
  colorOfElement: (elId: string, kind: ElementHit["kind"]) => string | null;
  /** Bounding boxes of the on-screen shapes, for the shape tool's smart guides. */
  shapeGuideTargets: () => Bounds[];
  /** Ids of the selected stroke paths (the OCR cache key). */
  selectedPathIds: () => string[];
  /** Transcribed text of the selected text elements + sticky notes. */
  selectionText: () => string;

  // --- Select-tool drag state machine ---
  beginSelectGesture: () => void;
  moveSelectGesture: (point: Point, shiftHeld: boolean) => void;
  endSelectGesture: () => Promise<void>;
  selectAtPoint: (point: Point, additive: boolean) => void;

  // --- Resize / rotate handle drags ---
  beginTransform: (h: HandleId) => void;
  moveTransform: (h: HandleId, dx: number, dy: number) => void;
  endTransform: () => Promise<void>;

  // --- Strokes ---
  /** Persist a finished freehand stroke; resolves to its id, or null on failure.
   *  `style` is the Month 5 pen-variant/alpha pair (ROADMAP item 12) — omitted
   *  entirely (not written as `undefined`/defaults) when the variant is plain
   *  "pen" at full opacity, so an ordinary stroke's doc shape is unchanged. */
  commitStroke: (
    points: Point[],
    color: string,
    strokeWidth: number,
    style?: PenStrokeStyle
  ) => Promise<string | null>;
  /** Persist a single-point dot (a stationary pen tap). */
  drawDot: (point: Point, color: string, strokeWidth: number, style?: PenStrokeStyle) => Promise<void>;
  /** Swap a freehand stroke for the clean primitive the classifier recognized. */
  replaceStrokeWithShape: (
    pathId: string,
    rec: RecognizedShape,
    color: string,
    strokeWidth: number
  ) => Promise<void>;

  // --- Eraser ---
  beginEraseStroke: () => void;
  endEraseStroke: () => void;
  /** `strokeWidth` is the active pen width, which sets the eraser's reach. */
  eraseAtPoint: (point: Point, strokeWidth: number) => void;
  /** A stationary eraser tap: erase whatever is under it, then reset the guard. */
  eraseTap: (point: Point, strokeWidth: number) => void;

  // --- Shapes ---
  saveShapeFromDraft: (draft: ShapeDraft) => Promise<void>;

  // --- Group operations ---
  deleteSelected: (ids: string[]) => Promise<void>;
  duplicateSelected: () => Promise<void>;
  copySelected: () => void;
  pasteClipboard: () => Promise<void>;
  /** Paste for the keyboard path (native pulls an OS-clipboard image first). */
  shortcutPaste: () => Promise<void>;
  bringToFront: () => Promise<void>;
  sendToBack: () => Promise<void>;
  applyColor: (color: string) => void;
  applyStrokeWidth: (w: number) => void;
  /** Month 5 (ROADMAP item 12) — applies stroke alpha to the selection's pen
   *  paths only (shapes/text have no `opacity` field in this model; an
   *  eraser path has neither a colour nor an opacity concept). No-op when
   *  nothing is selected, mirroring `applyColor`/`applyStrokeWidth`. */
  applyOpacity: (opacity: number) => void;

  // --- Text elements ---
  createTextElement: (point: Point, color: string) => Promise<void>;
  /** Persist the inline editor's text and close it. */
  commitTextEdit: (elementId: string, text: string) => Promise<void>;
  resizeTextElement: (
    elementId: string,
    width: number,
    height: number,
    fontSize: number
  ) => Promise<void>;
  deleteTextElement: (elementId: string) => Promise<void>;
  /** Create one text element and hand back its id (the AI affordances' write path). */
  saveTextElement: (el: Omit<TextElement, "id" | "createdAt">) => Promise<string>;

  // --- Sticky notes (legacy) ---
  pendingNotePosition: Point | null;
  cancelNote: () => void;
  submitNote: (content: string) => Promise<void>;
  deleteNote: (noteId: string) => Promise<void>;

  // --- Math elements (Month 6) ---
  /** Typeset `latex` and drop it on the board at `point`. Resolves to the new
   *  element's id. REJECTS on a TeX error (with TeX's own message) so the
   *  composer can stay open and show it — nothing is written on a failure. */
  createMathElement: (point: Point, latex: string) => Promise<string>;
  /** Re-typeset an existing element's source. The ONLY element write path
   *  that calls the render function; move/resize/rotate/delete never do. */
  updateMathLatex: (elementId: string, latex: string) => Promise<void>;
  /** The LaTeX behind a math element id, or null — what the composer is
   *  seeded with when an existing equation is opened for editing. */
  latexOfMathElement: (elementId: string) => string | null;

  // --- Images ---
  /** The toolbar image button: web goes straight to a file dialog, native asks. */
  insertImage: () => void;
  /** Month 6 — camera capture + OCR (descoped scanner; see `scanService`'s own
   *  header for why). Opens the camera, uploads the shot as an ordinary
   *  `ImageElement`, then runs it through the existing OCR pipeline. */
  scanDocument: () => Promise<void>;

  /**
   * Write a parsed diagram as real shape + text docs at a board-space origin
   * (the Phase 12 affordance's write path). Resolves to every new element id,
   * shapes first, so the caller can select the batch as a unit.
   */
  createDiagram: (
    build: DiagramBuild,
    ox: number,
    oy: number,
    style: { color: string; strokeWidth: number }
  ) => Promise<string[]>;

  // --- Undo / redo / clear ---
  canRedo: boolean;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** Fire the five element-collection clears; the screen composes the comment clear. */
  clearBoardElements: () => Promise<unknown>;
  /** Drop every local element array and the redo stack (after a successful clear). */
  resetLocalElements: () => void;
}

export function useBoardElements(
  boardId: string,
  viewport: Viewport,
  opts: BoardElementsOptions
): BoardElements {
  const {
    userId,
    canvasSize,
    blockedIds,
    editingTextId,
    isAdmin,
    isAltHeld,
    onEditText,
    onActivateSelectTool,
    onScheduleSave,
    onError,
    onQuotaExceeded,
  } = opts;

  // Uid stamped on new docs — every write site fell back to an empty string
  // before the split. Ownership *comparisons* (undo) use the raw `userId`
  // instead, so an unauthenticated viewer never matches an empty-uid doc.
  const authorId = userId ?? "";

  // ────────── STATE & REFS ──────────────────────────────────────────────
  // Drawing state
  const [paths, setPaths] = useState<DrawPath[]>([]);
  const [notes, setNotes] = useState<TextNote[]>([]);
  const [textElements, setTextElements] = useState<TextElement[]>([]);
  const [shapes, setShapes] = useState<ShapeElement[]>([]);
  const [images, setImages] = useState<ImageElement[]>([]);
  const [audioNotes, setAudioNotes] = useState<AudioElement[]>([]);
  const [mathElements, setMathElements] = useState<MathElement[]>([]);
  const [insertingImage, setInsertingImage] = useState(false);

  // Text note state (legacy sticky notes — kept for backwards compat)
  const [pendingNotePosition, setPendingNotePosition] = useState<Point | null>(null);

  // Redo stack — stores path data to re-save on redo
  const [redoStack, setRedoStack] = useState<Omit<DrawPath, "id" | "createdAt">[]>([]);

  // Canvas ready — true after the first Firestore snapshot arrives
  const [canvasReady, setCanvasReady] = useState(false);

  // Stroke selection (Phase 5). Own state slice so toolbar / comments / AI can
  // read it independently (ROADMAP A.3).
  const selection = useSelection();

  // Phase 8 group transform: live move offset (board units) applied to the
  // selection during a drag, plus the live marquee rectangle. Both are null
  // when no group gesture is in flight.
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [marquee, setMarquee] = useState<Bounds | null>(null);
  // Pass 2: live resize/rotate preview. `resize` carries the anchor + per-axis
  // factors; `rotate` carries the pivot + angle (radians). Null when idle.
  const [transformPreview, setTransformPreview] = useState<TransformPreview | null>(null);
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
  // Synchronous element sources for gesture-time hit-testing / guides.
  const visiblePathsRef = useRef<DrawPath[]>([]);
  const visibleShapesRef = useRef<ShapeElement[]>([]);
  const visibleTextElementsRef = useRef<TextElement[]>([]);
  const visibleImagesRef = useRef<ImageElement[]>([]);
  // Month 6 — math elements. A full hit-test/selection participant, so it
  // needs the same synchronous mirror every other selectable kind has.
  const visibleMathElementsRef = useRef<MathElement[]>([]);
  // Month 5 — synchronous source for the anchor-delete cascade (see
  // `cascadeDeleteVoiceNotes` below). Unfiltered (not the blocked-user
  // `visibleAudioNotes` memo): a blocked user's note must still be cascaded
  // away when its anchor is deleted, same as every other kind's delete path
  // doesn't consult the blocked-user filter either.
  const audioNotesRef = useRef<AudioElement[]>([]);
  // True once the audio subscription's first snapshot has landed. Firestore's
  // onSnapshot always fires once immediately with the current cached/server
  // state, so this flips shortly after mount — `cascadeDeleteVoiceNotes`
  // falls back to a real read only in the brief window before it does,
  // rather than trusting an empty initial array as "no notes exist".
  const audioNotesLoadedRef = useRef(false);
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

  // Phase 7 checkpointing. `lastSnapshotCountRef` is the stroke count captured by
  // the latest snapshot; the trigger fires once a full interval accrues past it.
  // The in-flight guard keeps a single snapshot write from racing itself.
  const lastSnapshotCountRef = useRef(0);
  const snapshotInFlightRef = useRef(false);
  // Gate the checkpoint trigger until cold-load has established the true baseline
  // count. Without it, the listener can push paths while lastSnapshotCountRef is
  // still 0, and shouldSnapshot(>=500, 0) would write a redundant snapshot on load.
  const snapshotBaselineReadyRef = useRef(false);

  // Ref so the text-element snapshot callback always sees the current editing ID
  const editingTextIdRef = useRef<string | null>(null);

  // Viewport sampled for culling — lags the live viewport so the rendered set
  // changes ~20×/s during pan/zoom instead of every frame.
  const cullViewport = useThrottledValue(viewport, CULL_THROTTLE_MS);

  // ────────── SUBSCRIPTIONS & SNAPSHOT CHECKPOINTING ────────────────────
  // Keep editingTextIdRef in sync for use inside snapshot callbacks
  useEffect(() => {
    editingTextIdRef.current = editingTextId;
  }, [editingTextId]);

  // Real-time subscriptions for board content
  useEffect(() => {
    if (!boardId) return;
    // Reporting sync state from the paths listener (always active on a board)
    // drives the offline/syncing banner without a second listener.
    return pathService.subscribeToBoardPaths(
      boardId,
      (incoming) => {
        setPaths(incoming);
        setCanvasReady(true);
      },
      reportSyncState
    );
  }, [boardId]);

  // Phase 7 cold-load fast path: if a snapshot exists, paint from snapshot + the
  // strokes drawn since its watermark (one snapshot read + a small delta) instead of
  // waiting on the full-collection listener to stream every doc. The realtime listener
  // above stays authoritative and reconciles to identical content. When no snapshot
  // exists we skip — the listener already does the only initial read.
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await snapshotService.getLatestSnapshot(boardId);
        if (cancelled) return;
        if (snap) {
          lastSnapshotCountRef.current = snap.pathCount;
          // Reuse the snapshot we just read instead of re-fetching it inside loadBoardState.
          const initial = await snapshotService.loadBoardState(boardId, snap);
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
  }, [boardId]);

  // Phase 7 trigger: once a full interval of strokes has accrued past the last
  // snapshot, compact the current path set into a new checkpoint. Guarded so the
  // write fires once per threshold crossing. Non-destructive — old path docs stay
  // (live-listener correctness); pruning is deferred to M5 (see snapshotService).
  useEffect(() => {
    if (!boardId || !snapshotBaselineReadyRef.current || snapshotInFlightRef.current) return;
    if (!snapshotService.shouldSnapshot(paths.length, lastSnapshotCountRef.current)) return;
    snapshotInFlightRef.current = true;
    const captured = paths;
    snapshotService
      .createSnapshot(boardId, captured)
      .then(() => {
        lastSnapshotCountRef.current = captured.length;
      })
      .catch((e) => captureException(e, { op: "board.createSnapshot" }))
      .finally(() => {
        snapshotInFlightRef.current = false;
      });
  }, [paths, boardId]);

  useEffect(() => {
    if (!boardId) return;
    return pathService.subscribeToBoardNotes(boardId, setNotes);
  }, [boardId]);

  useEffect(() => {
    if (!boardId) return;
    return shapeService.subscribeToBoardShapes(boardId, setShapes);
  }, [boardId]);

  useEffect(() => {
    if (!boardId) return;
    return imageService.subscribeToBoardImages(boardId, setImages);
  }, [boardId]);

  // Month 6 — math elements. An ordinary element subscription: the docs carry
  // their own cached `svgPath`, so a snapshot never triggers a render call.
  useEffect(() => {
    if (!boardId) return;
    return mathService.subscribeToBoardMathElements(boardId, setMathElements);
  }, [boardId]);

  // Month 5 — voice notes. A separate, independent subscription (its own
  // subcollection, no shared listener with any other kind) since it's not
  // part of the paths/shapes/text/images write-path family the rest of this
  // section mirrors. `audioNotesLoadedRef` flips on the first snapshot (see
  // its own comment) so the cascade below knows when the in-memory list
  // becomes trustworthy.
  useEffect(() => {
    if (!boardId) return;
    audioNotesLoadedRef.current = false;
    return audioService.subscribeToBoardAudio(boardId, (incoming) => {
      setAudioNotes(incoming);
      audioNotesLoadedRef.current = true;
    });
  }, [boardId]);

  useEffect(() => {
    if (!boardId) return;
    return pathService.subscribeToBoardTextElements(boardId, (incoming) => {
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
  }, [boardId]);

  // ────────── BLOCKED-USER FILTER, Z-ORDER & HIT-TEST REFS ──────────────
  // Filter out blocked users' content, then order by z. Memoized so
  // culling/fit-to-content see a stable array identity.
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
  // Month 6 — math elements. Blocked-user filtered AND z-ordered like every
  // other selectable layer (unlike `visibleAudioNotes` below, which is a
  // badge overlay with no z-stacking concept).
  const visibleMathElements = useMemo(
    () => mathElements.filter((m) => !blockedIds.includes(m.userId)).sort(byZ),
    [mathElements, blockedIds]
  );
  // Month 5 — voice notes. Blocked-user filtered like every other layer; not
  // z-ordered (no z-stacking concept for a badge overlay) and not fed into
  // the spatial index / culling below — see the BoardElements interface
  // comment on `audioNotes`.
  const visibleAudioNotes = useMemo(
    () => audioNotes.filter((a) => !blockedIds.includes(a.userId)),
    [audioNotes, blockedIds]
  );

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
  useEffect(() => {
    visibleMathElementsRef.current = visibleMathElements;
  }, [visibleMathElements]);
  // Month 5 — synced from the raw `audioNotes` state, not `visibleAudioNotes`
  // (see the ref's own comment on why blocked-user filtering doesn't apply
  // to the cascade).
  useEffect(() => {
    audioNotesRef.current = audioNotes;
  }, [audioNotes]);

  // Month 5 — anchor-delete cascade (the orphan fix's other half): any voice
  // note anchored to one of `elementIds` must not survive that element's
  // deletion. Filters the already-subscribed `audioNotesRef` in memory and
  // calls `audioService.batchDeleteVoiceNotes` directly on an actual match —
  // no Firestore read at all in the overwhelmingly common "no notes on this
  // board" case, unlike a naive per-call `getDocs`. A two-second eraser drag
  // samples this at ~30Hz (`STROKE_SAMPLE_MS`, BoardCanvas.tsx); this hook
  // already carries a live `onSnapshot` for every element kind precisely so
  // call sites don't have to re-fetch what's already in memory.
  //
  // Falls back to `audioService.deleteVoiceNotesForElements` (a real read)
  // only in the brief window before the subscription's first snapshot has
  // landed (`audioNotesLoadedRef`) — an empty initial array must not be
  // trusted as "this board has no notes." Every caller already treats this
  // as best-effort (fire-and-forget with its own `.catch`), so neither path
  // blocks or fails the element delete it's cascading from.
  const cascadeDeleteVoiceNotes = useCallback(
    (elementIds: string[]) => {
      if (elementIds.length === 0) return;
      if (!audioNotesLoadedRef.current) {
        audioService.deleteVoiceNotesForElements(boardId, elementIds).catch((e) => {
          captureException(e, { op: "board.audioCascade.fallbackRead" });
        });
        return;
      }
      const idSet = new Set(elementIds);
      const matchingIds = audioNotesRef.current
        .filter((a) => idSet.has(a.anchorElementId))
        .map((a) => a.id);
      if (matchingIds.length === 0) return;
      audioService.batchDeleteVoiceNotes(boardId, matchingIds).catch((e) => {
        captureException(e, { op: "board.audioCascade" });
      });
    },
    [boardId]
  );

  // ────────── SPATIAL INDEX (rbush, for marquee hit-testing) ────────────
  // Rebuild the marquee spatial index whenever the visible set changes. This is
  // the rbush index-maintenance path: O(n) bulk-load on change, amortized against
  // the many O(log n) queries a single marquee drag issues.
  useEffect(() => {
    const entries: IndexEntry[] = [
      ...visiblePaths.map((p) => entryFromBounds(p.id, "path", pathBox(p))),
      ...visibleShapes.map((s) => entryFromBounds(s.id, "shape", shapeBox(s))),
      ...visibleImages.map((img) => entryFromBounds(img.id, "image", imgBox(img))),
      ...visibleTextElements.map((el) => entryFromBounds(el.id, "text", textBox(el))),
      ...visibleMathElements.map((m) => entryFromBounds(m.id, "math", mathBox(m))),
    ];
    spatialIndexRef.current = buildElementIndex(entries);
  }, [visiblePaths, visibleShapes, visibleImages, visibleTextElements, visibleMathElements]);

  // ────────── VIEWPORT CULLING ──────────────────────────────────────────
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

  const culledMathElements = useMemo(() => {
    const view = viewportBounds(cullViewport, canvasSize, CULL_MARGIN_PX);
    return visibleMathElements.filter((m) => boundsIntersect(mathBox(m), view));
  }, [visibleMathElements, cullViewport, canvasSize]);

  // ────────── GEOMETRY & DERIVED SELECTION ──────────────────────────────
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
      ...visibleMathElements.map(mathBox),
    ]);

  // Phase 7 — current board-space box of an element by id, across every kind, used
  // to resolve a comment pin's live position from its anchor. Returns null when the
  // element no longer exists (the comment is "detached"). Memoized on the element
  // sets so a caller can memoize over it (the pin layer does) and panning — which
  // only moves `cullViewport` — never recomputes pins.
  const boxOfElement = useCallback(
    (elId: string, kind?: string): Bounds | null => {
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
      if (!kind || kind === "math") {
        const mEl = visibleMathElements.find((x) => x.id === elId);
        if (mEl) return mathBox(mEl);
      }
      if (!kind || kind === "note") {
        const n = visibleNotes.find((x) => x.id === elId);
        if (n) return { minX: n.position.x, minY: n.position.y, maxX: n.position.x, maxY: n.position.y };
      }
      return null;
    },
    [visiblePaths, visibleShapes, visibleTextElements, visibleImages, visibleMathElements, visibleNotes]
  );

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
    for (const mEl of visibleMathElements) if (ids.has(mEl.id)) boxes.push(mathBox(mEl));
    return boxes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selection.selectedIds,
    visiblePaths,
    visibleShapes,
    visibleImages,
    visibleTextElements,
    visibleMathElements,
  ]);
  const selectionUnion = useMemo(() => unionBounds(selectedBoxes), [selectedBoxes]);

  // ────────── HIT-TESTING & SELECTION ACTIONS ───────────────────────────
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
  const hitTestAny = (point: Point): ElementHit | null => {
    for (let i = visibleTextElementsRef.current.length - 1; i >= 0; i--) {
      const el = visibleTextElementsRef.current[i];
      if (boundsContainPoint(textBox(el), point, SELECT_TAP_PADDING)) {
        return { id: el.id, kind: "text" };
      }
    }
    // Month 6 — math elements. Ordered here because the hit-test walks
    // top-down and math renders directly above shapes in the SVG tree (see
    // DrawingCanvas); an equation annotated over with a stroke still loses
    // the tap to the equation, same as any other box-shaped element. Box
    // containment, like an image: an equation's glyphs are sparse, and
    // requiring a tap to land on actual ink would make selecting one
    // needlessly fiddly.
    for (let i = visibleMathElementsRef.current.length - 1; i >= 0; i--) {
      const mEl = visibleMathElementsRef.current[i];
      if (boundsContainPoint(mathBox(mEl), point, SELECT_TAP_PADDING)) {
        return { id: mEl.id, kind: "math" };
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

  // Month 5 (ROADMAP item 12 — eyedropper). Resolves the colour of a kind/id
  // pair `hitTestAny` already found; an image (no single sampleable colour)
  // or an id no longer present both resolve to null, which the caller (the
  // eyedropper) treats as "nothing to sample" rather than clearing the
  // active colour.
  const colorOfElement = (elId: string, kind: ElementHit["kind"]): string | null => {
    if (kind === "path") return visiblePaths.find((p) => p.id === elId)?.color ?? null;
    if (kind === "shape") return visibleShapes.find((s) => s.id === elId)?.stroke ?? null;
    if (kind === "text") return visibleTextElements.find((el) => el.id === elId)?.color ?? null;
    return null;
  };

  // Tap in select mode: hit-test the topmost element. Shift toggles it in/out of
  // the selection; a plain tap replaces the selection (or clears on empty).
  const selectAtPoint = (point: Point, additive: boolean) => {
    const hit = hitTestAny(point);
    if (!hit) {
      if (!additive) selection.clear();
      onEditText(null);
      return;
    }
    if (additive) selection.toggle(hit.id);
    else selection.select(hit.id);
    if (hit.kind !== "text") onEditText(null);
  };

  // Select every visible element across all four kinds, then switch to the
  // select tool so the result is immediately actionable.
  const selectAllVisible = useCallback(() => {
    selection.setMany(
      [
        ...visiblePathsRef.current.map((p) => p.id),
        ...visibleShapesRef.current.map((s) => s.id),
        ...visibleImagesRef.current.map((img) => img.id),
        ...visibleTextElementsRef.current.map((el) => el.id),
        ...visibleMathElementsRef.current.map((mEl) => mEl.id),
      ],
      "elements"
    );
    onActivateSelectTool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.setMany, onActivateSelectTool]);

  const shapeGuideTargets = () => visibleShapesRef.current.map((s) => s.bbox ?? shapeBbox(s));

  const selectedPathIds = () => visiblePaths.filter((p) => selection.isSelected(p.id)).map((p) => p.id);

  // Transcribed text from selected text elements + sticky notes (the model
  // reads this alongside the image so it isn't guessing at legible content).
  const selectionText = () =>
    [
      ...visibleTextElements.filter((el) => selection.isSelected(el.id)).map((el) => el.text),
      ...visibleNotes.filter((n) => selection.isSelected(n.id)).map((n) => n.content),
    ]
      .map((t) => (t ?? "").trim())
      .filter(Boolean)
      .join("\n");

  // ────────── WRITE PATH — ERASER ───────────────────────────────────────
  // --- Eraser: board-space hit-test → delete intersected strokes ---

  // Delete every not-yet-erased stroke whose geometry comes within the eraser
  // radius of `point`. Optimistic local removal keeps the UI responsive; the
  // Firestore subscription confirms (or, on failure, restores) the deletion.
  // `strokeWidth` is the active pen width, which sets the eraser's reach.
  const eraseAtPointWith = (point: Point, strokeWidth: number) => {
    const radius = (strokeWidth + ERASER_PAD) / 2;
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
      pathService.deletePath(boardId, pathId).catch((e) => {
        captureException(e, { op: "board.erase" });
        onError("Some strokes couldn't be erased.");
      });
    });
    // Month 5 — anchor cascade: an erased stroke can carry a voice note.
    // In-memory lookup (see `cascadeDeleteVoiceNotes`) — a two-second eraser
    // drag calls this at ~30Hz, so this must never be a Firestore read.
    cascadeDeleteVoiceNotes(hits);
    onScheduleSave();
  };

  // ────────── WRITE PATH — GROUP MOVE ───────────────────────────────────
  // --- Group move ---

  // Resolve the per-element field deltas for a group translate and commit them
  // (optimistic local update + one batch write per collection).
  const commitMove = async (dx: number, dy: number) => {
    const ids = selection.selectedIds;
    if (ids.size === 0 || (dx === 0 && dy === 0)) return;

    const pathUpdates: { id: string; data: any }[] = [];
    const shapeUpdates: { id: string; data: any }[] = [];
    const textUpdates: { id: string; data: any }[] = [];
    const imageUpdates: { id: string; data: any }[] = [];
    const mathUpdates: { id: string; data: any }[] = [];

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
    // Month 6 — math elements. A move is pure geometry: `latex` and the
    // cached `svgPath` are untouched, so no render call happens here.
    const nextMath = mathElements.map((mEl) => {
      if (!ids.has(mEl.id)) return mEl;
      const x = mEl.x + dx;
      const y = mEl.y + dy;
      const bbox = translateBounds(mathBox(mEl), dx, dy);
      mathUpdates.push({ id: mEl.id, data: { x, y, bbox } });
      return { ...mEl, x, y, bbox };
    });
    setPaths(nextPaths);
    setShapes(nextShapes);
    setTextElements(nextText);
    setImages(nextImages);
    setMathElements(nextMath);

    try {
      await Promise.all([
        pathService.batchUpdatePaths(boardId, pathUpdates),
        shapeService.batchUpdateShapes(boardId, shapeUpdates),
        pathService.batchUpdateTextElements(boardId, textUpdates),
        imageService.batchUpdateImages(boardId, imageUpdates),
        mathService.batchUpdateMathElements(boardId, mathUpdates),
      ]);
      onScheduleSave();
    } catch (e) {
      captureException(e, { op: "board.moveSelection" });
      onError("Failed to move some elements.");
    }
  };

  // ────────── GESTURE — SELECT / MARQUEE DRAG ───────────────────────────
  // --- Select-tool drag state machine ---

  const beginSelectGesture = () => {
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
  };

  const moveSelectGesture = (point: Point, shiftHeld: boolean) => {
    const g = selectGestureRef.current;
    if (g.mode === "pending") {
      g.start = point;
      const hit = hitTestAny(point);
      if (hit && selection.isSelected(hit.id)) {
        g.mode = "move";
      } else if (hit) {
        // Drag began on an unselected element: grab it (shift adds), then move.
        if (shiftHeld) selection.toggle(hit.id);
        else selection.select(hit.id);
        onEditText(null);
        g.mode = "move";
      } else {
        // Empty canvas → rubber-band. Shift keeps the prior selection as a base.
        g.mode = "marquee";
        g.baseIds = shiftHeld ? [...selection.selectedIds] : [];
        if (!shiftHeld) selection.clear();
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
  };

  const endSelectGesture = async () => {
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
  };

  // ────────── GESTURE — RESIZE / ROTATE ─────────────────────────────────
  // --- Pass 2: resize / rotate handle drags ---

  const beginTransform = (h: HandleId) => {
    const u = selectionUnion;
    if (!u) return;
    const center = { x: (u.minX + u.maxX) / 2, y: (u.minY + u.maxY) / 2 };
    transformGestureRef.current = { handle: h, union: u, center, last: null };
    setMarquee(null);
  };

  const moveTransform = (h: HandleId, dx: number, dy: number) => {
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
    if (isCornerHandle(h) && !isAltHeld()) {
      const s = Math.max(sx, sy);
      sx = s;
      sy = s;
    }
    sx = Math.max(MIN_SCALE_FACTOR, sx);
    sy = Math.max(MIN_SCALE_FACTOR, sy);
    g.last = { mode: "resize", anchor, sx, sy };
    setTransformPreview({ mode: "resize", anchor, sx, sy, bounds: scaleBoundsAbout(u, anchor, sx, sy) });
  };

  const endTransform = async () => {
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
    const mathUpdates: { id: string; data: any }[] = [];
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
    // Month 6 — math elements. An equation resizes by its `scale`, not by
    // re-typesetting: the path data is resolution-independent vector outline,
    // so scaling it is exact and — crucially — free, with no render call.
    // A non-uniform drag (alt-held corner, an edge handle) has no meaning for
    // a glyph outline, so the larger of the two factors is applied uniformly
    // rather than stretching the letterforms; the box is then re-derived from
    // the new scale so the selection outline matches what is drawn.
    const nextMath = mathElements.map((mEl) => {
      if (!ids.has(mEl.id)) return mEl;
      const np = scalePointAbout({ x: mEl.x, y: mEl.y }, anchor, sx, sy);
      const factor = Math.max(Math.abs(sx), Math.abs(sy));
      const scale = Math.max(MIN_MATH_SCALE, mEl.scale * factor);
      const applied = scale / mEl.scale;
      const width = mEl.width * applied;
      const height = mEl.height * applied;
      const moved = { ...mEl, x: np.x, y: np.y, width, height, scale };
      const bbox = mathBoxOf(moved);
      mathUpdates.push({ id: mEl.id, data: { x: np.x, y: np.y, width, height, scale, bbox } });
      return { ...moved, bbox };
    });
    setPaths(nextPaths);
    setShapes(nextShapes);
    setTextElements(nextText);
    setImages(nextImages);
    setMathElements(nextMath);
    try {
      await Promise.all([
        pathService.batchUpdatePaths(boardId, pathUpdates),
        shapeService.batchUpdateShapes(boardId, shapeUpdates),
        pathService.batchUpdateTextElements(boardId, textUpdates),
        imageService.batchUpdateImages(boardId, imageUpdates),
        mathService.batchUpdateMathElements(boardId, mathUpdates),
      ]);
      onScheduleSave();
    } catch (e) {
      captureException(e, { op: "board.resizeSelection" });
      onError("Failed to resize some elements.");
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
    const mathUpdates: { id: string; data: any }[] = [];
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
    // Month 6 — math elements. MathElement has NO `rotation` field (see its
    // type comment), so a group rotate ORBITS an equation about the pivot
    // without spinning it. That is a deliberate, visible compromise: the
    // alternative — skipping math entirely — would leave the equation behind
    // while the rest of the selection swung away, silently breaking the
    // group. Orbiting keeps the layout coherent; only the glyph angle is
    // unchanged. Adding real rotation means adding the field and threading it
    // through MathElementView's transform.
    const nextMath = mathElements.map((mEl) => {
      if (!ids.has(mEl.id)) return mEl;
      const oc = { x: mEl.x + mEl.width / 2, y: mEl.y + mEl.height / 2 };
      const nc = rotatePointAbout(oc, center, theta);
      const x = nc.x - mEl.width / 2;
      const y = nc.y - mEl.height / 2;
      const moved = { ...mEl, x, y };
      const bbox = mathBoxOf(moved);
      mathUpdates.push({ id: mEl.id, data: { x, y, bbox } });
      return { ...moved, bbox };
    });
    setPaths(nextPaths);
    setShapes(nextShapes);
    setTextElements(nextText);
    setImages(nextImages);
    setMathElements(nextMath);
    try {
      await Promise.all([
        pathService.batchUpdatePaths(boardId, pathUpdates),
        shapeService.batchUpdateShapes(boardId, shapeUpdates),
        pathService.batchUpdateTextElements(boardId, textUpdates),
        imageService.batchUpdateImages(boardId, imageUpdates),
        mathService.batchUpdateMathElements(boardId, mathUpdates),
      ]);
      onScheduleSave();
    } catch (e) {
      captureException(e, { op: "board.rotateSelection" });
      onError("Failed to rotate some elements.");
    }
  };

  // ────────── WRITE PATH — STROKES ──────────────────────────────────────
  // --- Strokes ---

  // RDP-simplify in board-space before the write: fewer points = smaller doc,
  // cheaper sync, and lighter render — without a visible change to the stroke.
  // Month 5 (ROADMAP item 12) — delegates to the pure, unit-tested
  // `persistedStyleFields` (see its own header for the fix-round-1 defect it
  // guards against: comparing opacity to a hardcoded 1 instead of the
  // style's own default reverted a full-opacity highlighter to 35% on the
  // very next render).
  const penStyleFields = (style?: PenStrokeStyle): Partial<Pick<DrawPath, "penStyle" | "opacity">> =>
    persistedStyleFields(style?.penStyle, style?.opacity);

  const commitStroke = async (
    points: Point[],
    color: string,
    strokeWidth: number,
    style?: PenStrokeStyle
  ): Promise<string | null> => {
    const simplified = rdpSimplify(points, RDP_TOLERANCE);

    const newPath: Omit<DrawPath, "id" | "createdAt"> = {
      boardId,
      userId: authorId,
      points: simplified,
      color,
      strokeWidth,
      tool: "pen",
      ...penStyleFields(style),
    };

    try {
      const pathId = await pathService.savePath(boardId, newPath);
      setRedoStack([]);
      onScheduleSave();
      return pathId;
    } catch {
      Alert.alert("Error", "Failed to save stroke");
      return null;
    }
  };

  const drawDot = async (point: Point, color: string, strokeWidth: number, style?: PenStrokeStyle) => {
    const dot: Omit<DrawPath, "id" | "createdAt"> = {
      boardId,
      userId: authorId,
      points: [point],
      color,
      strokeWidth,
      tool: "pen",
      ...penStyleFields(style),
    };
    try {
      await pathService.savePath(boardId, dot);
      setRedoStack([]);
      onScheduleSave();
    } catch (e) {
      captureException(e, { op: "board.drawDot" });
      onError("Failed to save.");
    }
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
      boardId,
      userId: authorId,
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
      await shapeService.saveShape(boardId, shape);
      // Optimistic local removal keeps the swap instant; the subscription confirms.
      setPaths((prev) => prev.filter((p) => p.id !== pathId));
      await pathService.deletePath(boardId, pathId);
      onScheduleSave();
      // Month 5 — anchor cascade: the stroke being replaced could carry a
      // voice note. The new shape gets a different id, so re-anchoring isn't
      // attempted here (out of scope — a rare path: shape recognition on a
      // stroke that already has a note); deleting it is the deliberate
      // trade-off over leaving it permanently orphaned and unreachable (its
      // `anchorElementId` would point at nothing this hook ever renders
      // again).
      cascadeDeleteVoiceNotes([pathId]);
    } catch (e) {
      captureException(e, { op: "board.perfectShape" });
      onError("Couldn't perfect the shape.");
    }
  };

  // ────────── WRITE PATH — SHAPES & DIAGRAMS ────────────────────────────
  // --- Shapes ---

  const saveShapeFromDraft = async (draft: ShapeDraft) => {
    const newShape: Omit<ShapeElement, "id" | "createdAt" | "bbox"> = {
      boardId,
      userId: authorId,
      ...draft,
    };
    try {
      await shapeService.saveShape(boardId, newShape);
      onScheduleSave();
    } catch (e) {
      captureException(e, { op: "board.saveShape" });
      onError("Failed to save shape.");
    }
  };

  // Write a parsed diagram as real ShapeElement/TextElement docs at (ox, oy).
  // Nodes inherit the caller's active color; edges are lines/arrows.
  const createDiagram = async (
    build: DiagramBuild,
    ox: number,
    oy: number,
    style: { color: string; strokeWidth: number }
  ) => {
    const shapeIds = await Promise.all(
      build.shapes.map((s) =>
        shapeService.saveShape(boardId, {
          boardId,
          userId: authorId,
          shape: s.shape,
          x: ox + s.x,
          y: oy + s.y,
          width: s.width,
          height: s.height,
          rotation: 0,
          fill: "none",
          stroke: style.color,
          strokeWidth: style.strokeWidth,
          dashed: s.dashed,
          arrowheadStart: "none",
          arrowheadEnd: s.arrowheadEnd,
        })
      )
    );
    const textIds = await Promise.all(
      build.texts.map((t) =>
        pathService.saveTextElement(boardId, {
          boardId,
          userId: authorId,
          text: t.text,
          position: { x: ox + t.x, y: oy + t.y },
          width: t.width,
          height: t.height,
          // Edge labels are smaller than node labels so connectors stay legible.
          fontSize: t.role === "edge" ? 12 : 15,
          color: style.color,
        })
      )
    );
    return [...shapeIds, ...textIds];
  };

  // ────────── WRITE PATH — GROUP OPERATIONS ─────────────────────────────
  // --- Group operations ---

  // The caller clears the selection + inline editor before calling this (the
  // screen owns that ordering, exactly as the original handler did).
  const deleteSelected = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const shapeIds = visibleShapesRef.current.filter((s) => idSet.has(s.id)).map((s) => s.id);
      const textIds = visibleTextElementsRef.current.filter((el) => idSet.has(el.id)).map((el) => el.id);
      const imageIds = visibleImagesRef.current.filter((img) => idSet.has(img.id)).map((img) => img.id);
      const mathIds = visibleMathElementsRef.current
        .filter((mEl) => idSet.has(mEl.id))
        .map((mEl) => mEl.id);
      // Whatever is left over is a stroke. Month 6: `mathIds` has to be
      // subtracted here as well, or every deleted equation would ALSO be
      // issued as a delete against the `paths` collection.
      const pathIds = ids.filter(
        (i) =>
          !shapeIds.includes(i) &&
          !textIds.includes(i) &&
          !imageIds.includes(i) &&
          !mathIds.includes(i)
      );
      setShapes((prev) => prev.filter((s) => !idSet.has(s.id)));
      setTextElements((prev) => prev.filter((el) => !idSet.has(el.id)));
      setImages((prev) => prev.filter((img) => !idSet.has(img.id)));
      setMathElements((prev) => prev.filter((mEl) => !idSet.has(mEl.id)));
      setPaths((prev) => prev.filter((p) => !idSet.has(p.id)));
      try {
        await Promise.all([
          pathService.batchDeletePaths(boardId, pathIds),
          shapeService.batchDeleteShapes(boardId, shapeIds),
          pathService.batchDeleteTextElements(boardId, textIds),
          imageService.batchDeleteImages(boardId, imageIds),
          mathService.batchDeleteMathElements(boardId, mathIds),
        ]);
        onScheduleSave();
        // Month 5 — anchor cascade (the other half of the orphan fix): any
        // voice note anchored to one of these ids must not survive them.
        // Only fires once the real deletes have actually committed.
        cascadeDeleteVoiceNotes(ids);
      } catch (e) {
        captureException(e, { op: "board.deleteSelected" });
        onError("Failed to delete some elements.");
      }
    },
    [boardId, onScheduleSave, onError, cascadeDeleteVoiceNotes]
  );

  // Duplicate the selection 16px down-right; the copies become the new selection.
  const duplicateSelected = useCallback(async () => {
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
          .savePath(boardId, { ...rest, points: translatePoints(p.points, off, off) })
          .then((nid) => {
            newIds.push(nid);
          })
      );
    }
    for (const s of shapes) {
      if (!ids.has(s.id)) continue;
      const { id: _i, createdAt: _c, bbox: _b, ...rest } = s;
      tasks.push(
        shapeService.saveShape(boardId, { ...rest, x: s.x + off, y: s.y + off }).then((nid) => {
          newIds.push(nid);
        })
      );
    }
    for (const el of textElements) {
      if (!ids.has(el.id)) continue;
      const { id: _i, createdAt: _c, ...rest } = el;
      tasks.push(
        pathService
          .saveTextElement(boardId, {
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
        imageService.saveImage(boardId, { ...rest, x: img.x + off, y: img.y + off }).then((nid) => {
          newIds.push(nid);
        })
      );
    }
    // Month 6 — math elements. `saveMathElement`, not `createMathElement`:
    // the copy already has typeset path data, so duplicating an equation is
    // one Firestore write with no render call at all.
    for (const mEl of mathElements) {
      if (!ids.has(mEl.id)) continue;
      const { id: _i, createdAt: _c, bbox: _b, ...rest } = mEl;
      tasks.push(
        mathService
          .saveMathElement(boardId, { ...rest, x: mEl.x + off, y: mEl.y + off })
          .then((nid) => {
            newIds.push(nid);
          })
      );
    }
    try {
      await Promise.all(tasks);
      selection.setMany(newIds, "elements");
      onEditText(null);
      onScheduleSave();
    } catch (e) {
      captureException(e, { op: "board.duplicate" });
      onError("Failed to duplicate selection.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    boardId,
    selection.selectedIds,
    selection.setMany,
    paths,
    shapes,
    textElements,
    images,
    onEditText,
    onScheduleSave,
    onError,
  ]);

  // ────────── WRITE PATH — CLIPBOARD ────────────────────────────────────
  // --- Phase 10: clipboard (copy / paste) ---

  // Copy the current selection into the in-app clipboard store, stripping
  // identity so paste can re-stamp the destination board + pasting user. The
  // store is module-level, so the payload survives navigating to another board.
  const copySelected = useCallback(() => {
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
  const pasteClipboard = useCallback(async () => {
    const items = getClipboard();
    if (items.length === 0) return;
    const d = nextPasteOffset();
    const uid = authorId;
    const newIds: string[] = [];
    const tasks: Promise<void>[] = [];
    for (const item of items) {
      const off = offsetClipItem(item, d);
      if (off.kind === "path") {
        tasks.push(
          pathService
            .savePath(boardId, { ...off.data, boardId, userId: uid })
            .then((nid) => {
              newIds.push(nid);
            })
        );
      } else if (off.kind === "shape") {
        tasks.push(
          shapeService
            .saveShape(boardId, { ...off.data, boardId, userId: uid })
            .then((nid) => {
              newIds.push(nid);
            })
        );
      } else if (off.kind === "text") {
        tasks.push(
          pathService
            .saveTextElement(boardId, { ...off.data, boardId, userId: uid })
            .then((nid) => {
              newIds.push(nid);
            })
        );
      } else {
        tasks.push(
          imageService
            .saveImage(boardId, { ...off.data, boardId, userId: uid })
            .then((nid) => {
              newIds.push(nid);
            })
        );
      }
    }
    try {
      await Promise.all(tasks);
      onActivateSelectTool();
      selection.setMany(newIds, "elements");
      onEditText(null);
      onScheduleSave();
    } catch (e) {
      captureException(e, { op: "board.paste" });
      onError("Failed to paste.");
    }
    // selection methods are stable (useCallback in the slice); listing setMany.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, userId, selection.setMany, onActivateSelectTool, onEditText, onScheduleSave, onError]);

  // ────────── WRITE PATH — IMAGES ───────────────────────────────────────
  // --- Images ---

  // Upload an already-prepared (downscaled) image, place it aspect-fitted +
  // centered on the current viewport, and select it. Shared by the toolbar
  // picker and the web clipboard-paste path (Phase 10).
  const uploadPreparedImage = async (prepared: PreparedImage) => {
    const center = screenToBoard(viewport, {
      x: canvasSize.width / 2,
      y: canvasSize.height / 2,
    });
    const box = placementBox(prepared.naturalWidth, prepared.naturalHeight, center);
    const newId = await imageService.uploadImage(boardId, authorId, prepared, {
      ...box,
      alt: prepared.alt,
    });
    onActivateSelectTool();
    selection.select(newId, "elements");
    onScheduleSave();
  };

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
      onError("Failed to insert image.");
    } finally {
      setInsertingImage(false);
    }
  };

  // The toolbar image button. Web → straight to the file dialog. Native → a
  // gallery/camera action sheet (both routes share the upload pipeline above).
  const insertImage = () => {
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

  // Month 6 — camera capture + OCR (descoped scanner). Shares `insertImage`'s
  // busy gate (`insertingImage`) since both end in the same upload pipeline;
  // `scanService` owns capture → upload → OCR, this just supplies the
  // board-space placement center and adopts the result the same way every
  // other insert path here does (select tool, select the element, schedule a
  // save). A canceled camera / denied permission resolves to null and no-ops,
  // matching `insertImageFrom`. `result.ocrQuotaExceeded` routes to the same
  // `onQuotaExceeded` upsell `useBoardAI`'s "Recognize text" uses for the
  // identical resource-exhausted denial — the image itself already landed
  // either way, so this never gates the capture, only the OCR notice.
  const scanDocument = async () => {
    if (insertingImage) return;
    setInsertingImage(true);
    try {
      const center = screenToBoard(viewport, {
        x: canvasSize.width / 2,
        y: canvasSize.height / 2,
      });
      const result = await scanService.scanDocument(boardId, authorId, center);
      if (!result) return; // canceled / permission denied
      onActivateSelectTool();
      selection.select(result.imageId, "elements");
      onScheduleSave();
      // The image landed regardless; this only decides whether the upsell
      // shows for the OCR half — same denial, same modal as "Recognize text".
      if (result.ocrQuotaExceeded) onQuotaExceeded();
    } catch (e) {
      captureException(e, { op: "board.scanDocument" });
      onError("Failed to scan the document.");
    } finally {
      setInsertingImage(false);
    }
  };

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
        onError("Failed to paste image.");
      } finally {
        setInsertingImage(false);
      }
    },
    // uploadPreparedImage closes over the live viewport/canvas/boardId — intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [insertingImage, viewport, canvasSize, boardId, userId]
  );

  // Paste for the keyboard path. On web this is unreachable (the DOM `paste`
  // event below owns Cmd/Ctrl+V); on native it pulls an OS-clipboard image if
  // present, otherwise pastes the in-app clipboard.
  const shortcutPaste = useCallback(async () => {
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
    if (hasClipboard()) pasteClipboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertingImage, pasteClipboard]);

  // Web: handle paste (Cmd/Ctrl+V). An image on the system clipboard (screenshot
  // / copied photo) becomes an image element; otherwise fall back to the in-app
  // clipboard. The DOM `paste` event is the only place `clipboardData` is
  // readable, so paste lives here rather than in the keydown handler.
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
        pasteClipboard();
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [editingTextId, pasteExternalImage, pasteClipboard]);

  // ────────── WRITE PATH — Z-ORDER ──────────────────────────────────────
  // --- Z-order ---

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
        pathService.batchUpdatePaths(boardId, pathPlan.map((p) => ({ id: p.id, data: { z: p.z } }))),
        shapeService.batchUpdateShapes(boardId, shapePlan.map((p) => ({ id: p.id, data: { z: p.z } }))),
        pathService.batchUpdateTextElements(boardId, textPlan.map((p) => ({ id: p.id, data: { z: p.z } }))),
        imageService.batchUpdateImages(boardId, imagePlan.map((p) => ({ id: p.id, data: { z: p.z } }))),
      ]);
      onScheduleSave();
    } catch (e) {
      captureException(e, { op: "board.reorder" });
      onError("Failed to reorder selection.");
    }
  };

  const bringToFront = () => reorderSelected("front");
  const sendToBack = () => reorderSelected("back");

  // ────────── WRITE PATH — STYLE ────────────────────────────────────────
  // --- Style ---

  // Recolor every selected element: stroke for paths, stroke (+fill) for shapes,
  // text color for text. Applies to the whole multi-selection in one batch.
  const applyColor = (color: string) => {
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
      pathService.batchUpdatePaths(boardId, pathUpdates),
      shapeService.batchUpdateShapes(boardId, shapeUpdates),
      pathService.batchUpdateTextElements(boardId, textUpdates),
    ])
      .then(onScheduleSave)
      .catch((e) => {
        captureException(e, { op: "board.recolor" });
        onError("Color update failed.");
      });
  };

  // Stroke width applies to the active tool and, when a selection exists, to its
  // strokeable members (paths + shapes; text uses fontSize, not stroke).
  const applyStrokeWidth = (w: number) => {
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
      pathService.batchUpdatePaths(boardId, pathUpdates),
      shapeService.batchUpdateShapes(boardId, shapeUpdates),
    ])
      .then(onScheduleSave)
      .catch((e) => {
        captureException(e, { op: "board.strokeWidth" });
        onError("Stroke width update failed.");
      });
  };

  // Month 5 (ROADMAP item 12) — alpha applies to the selection's pen paths
  // only. Shapes/text have no `opacity` field in this model (a deliberate
  // scoping decision — see DrawPath.opacity's own comment); an eraser path
  // has no colour to make translucent either, so it's excluded the same way
  // applyColor already excludes it.
  const applyOpacity = (opacity: number) => {
    const ids = selection.selectedIds;
    if (ids.size === 0) return;
    const pathUpdates: { id: string; data: any }[] = [];
    const nextPaths = paths.map((p) => {
      if (!ids.has(p.id) || p.tool === "eraser") return p;
      pathUpdates.push({ id: p.id, data: { opacity } });
      return { ...p, opacity };
    });
    setPaths(nextPaths);
    pathService
      .batchUpdatePaths(boardId, pathUpdates)
      .then(onScheduleSave)
      .catch((e) => {
        captureException(e, { op: "board.opacity" });
        onError("Opacity update failed.");
      });
  };

  // ────────── WRITE PATH — TEXT ELEMENTS ────────────────────────────────
  // --- Text element handlers ---

  const createTextElement = async (point: Point, color: string) => {
    const DEFAULT_EL_WIDTH = 160;
    const DEFAULT_EL_HEIGHT = 52;
    // point is board-space; the board is unbounded, so no screen clamp.
    const newEl: Omit<TextElement, "id" | "createdAt"> = {
      boardId,
      userId: authorId,
      text: "",
      position: {
        x: point.x - DEFAULT_EL_WIDTH / 2,
        y: point.y - DEFAULT_EL_HEIGHT / 2,
      },
      width: DEFAULT_EL_WIDTH,
      height: DEFAULT_EL_HEIGHT,
      fontSize: 20,
      color,
    };
    try {
      const elId = await pathService.saveTextElement(boardId, newEl);
      selection.select(elId);
      onEditText(elId);
      onScheduleSave();
    } catch {
      onError("Failed to create text element.");
    }
  };

  const commitTextEdit = async (elementId: string, text: string) => {
    onEditText(null);
    try {
      await pathService.updateTextElement(boardId, elementId, { text });
      setTextElements((prev) =>
        prev.map((el) => (el.id === elementId ? { ...el, text } : el))
      );
      onScheduleSave();
    } catch {
      onError("Text save failed — changes may not persist.");
    }
  };

  const resizeTextElement = async (
    elementId: string,
    width: number,
    height: number,
    fontSize: number
  ) => {
    try {
      await pathService.updateTextElement(boardId, elementId, { width, height, fontSize });
      setTextElements((prev) =>
        prev.map((el) =>
          el.id === elementId ? { ...el, width, height, fontSize } : el
        )
      );
      onScheduleSave();
    } catch {
      onError("Resize save failed.");
    }
  };

  const deleteTextElement = async (elementId: string) => {
    try {
      await pathService.deleteTextElement(boardId, elementId);
      setTextElements((prev) => prev.filter((el) => el.id !== elementId));
      selection.remove(elementId);
      onEditText(null);
      onScheduleSave();
      // Month 5 — anchor cascade: a text element can carry a voice note.
      cascadeDeleteVoiceNotes([elementId]);
    } catch {
      onError("Failed to delete text element.");
    }
  };

  const saveTextElement = (el: Omit<TextElement, "id" | "createdAt">) =>
    pathService.saveTextElement(boardId, el);

  // ────────── WRITE PATH — MATH ELEMENTS ────────────────────────────────
  // Month 6. The ONLY two element write paths that call the render function;
  // move / resize / rotate / delete / duplicate above deliberately do not,
  // because `svgPath` is cached on the document and only `latex` invalidates
  // it.
  //
  // Both REJECT on failure rather than swallowing into `onError`, unlike
  // every other write path in this file. The composer is a modal that stays
  // open on a bad expression and shows TeX's own message inline ("Missing
  // close brace"), which it cannot do if the error has already been turned
  // into a board-level banner and discarded. Callers here own the message.

  const createMathElement = async (point: Point, latex: string): Promise<string> => {
    const id = await mathService.createMathElement({
      boardId,
      latex,
      x: point.x,
      y: point.y,
      userId: authorId,
    });
    // Land ready to move, exactly as an inserted image or shape does.
    selection.select(id);
    onActivateSelectTool();
    onScheduleSave();
    return id;
  };

  const updateMathLatex = async (elementId: string, latex: string): Promise<void> => {
    const current = mathElements.find((mEl) => mEl.id === elementId);
    if (!current) return;
    await mathService.updateMathLatex(boardId, elementId, latex, {
      x: current.x,
      y: current.y,
      scale: current.scale,
    });
    onScheduleSave();
  };

  const latexOfMathElement = (elementId: string): string | null =>
    mathElements.find((mEl) => mEl.id === elementId)?.latex ?? null;

  // ────────── WRITE PATH — STICKY NOTES (legacy) ────────────────────────
  // --- Text note handlers ---

  const submitNote = async (content: string) => {
    if (!pendingNotePosition) return;

    const newNote: Omit<TextNote, "id" | "createdAt"> = {
      boardId,
      userId: authorId,
      content,
      position: pendingNotePosition,
    };

    try {
      await pathService.saveTextNote(boardId, newNote);
      onScheduleSave();
    } catch {
      Alert.alert("Error", "Failed to save note");
    }

    setPendingNotePosition(null);
  };

  const cancelNote = () => {
    setPendingNotePosition(null);
  };

  const deleteNote = async (noteId: string) => {
    try {
      await pathService.deleteTextNote(boardId, noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      onScheduleSave();
      // Month 5 — anchor cascade: a sticky note can carry a voice note
      // (ROADMAP.md:584 names "sticky" explicitly).
      cascadeDeleteVoiceNotes([noteId]);
    } catch {
      Alert.alert("Error", "Failed to delete note");
    }
  };

  // ────────── WRITE PATH — UNDO / REDO / CLEAR ──────────────────────────
  // --- Undo / redo / clear ---

  const undo = async () => {
    if (paths.length === 0) return;
    const targetPath = isAdmin
      ? paths[paths.length - 1]
      : [...paths].reverse().find((p) => p.userId === userId);
    if (!targetPath) return;
    try {
      await pathService.deletePath(boardId, targetPath.id);
      setPaths((prev) => prev.filter((p) => p.id !== targetPath.id));
      const { id: _id, createdAt: _createdAt, ...redoEntry } = targetPath;
      setRedoStack((prev) => [...prev, redoEntry]);
      onScheduleSave();
      // Month 5 — anchor cascade: the undone stroke can carry a voice note.
      // Redo re-creates the stroke as a NEW doc/id (savePath below), so a
      // cascaded note can't be un-deleted by redo either way — same
      // trade-off as replaceStrokeWithShape's comment.
      cascadeDeleteVoiceNotes([targetPath.id]);
    } catch {
      onError("Undo failed.");
    }
  };

  const redo = async () => {
    if (redoStack.length === 0) return;
    const redoEntry = redoStack[redoStack.length - 1];
    try {
      await pathService.savePath(boardId, redoEntry);
      setRedoStack((prev) => prev.slice(0, -1));
      onScheduleSave();
    } catch {
      onError("Redo failed.");
    }
  };

  const clearBoardElements = () =>
    Promise.all([
      pathService.clearBoardPaths(boardId),
      pathService.clearBoardNotes(boardId),
      pathService.clearBoardTextElements(boardId),
      shapeService.clearBoardShapes(boardId),
      imageService.clearBoardImages(boardId),
      // Month 5 — voice notes are Storage-backed like images, so clear-board
      // must remove their objects too or they orphan exactly like the M2
      // carry-forward defect fixed for images this task (see imageService's
      // clearBoardImages comment). Voice notes aren't part of this hook's own
      // element state (no selection/multi-delete wiring yet — Month 5 scope
      // is record/play only), so this is the only call site that needs to
      // know about them.
      audioService.clearBoardVoiceNotes(boardId),
      // Month 6 — math elements. Nothing is Storage-backed here (the path
      // data lives on the document), so this is a plain subcollection wipe.
      mathService.clearBoardMathElements(boardId),
    ]);

  const resetLocalElements = () => {
    setPaths([]);
    setNotes([]);
    setTextElements([]);
    setShapes([]);
    setImages([]);
    // Item 12, fix round 1: this was the one kind missing from the
    // optimistic reset — clearBoardElements already removes every audio doc
    // server-side (clearBoardVoiceNotes), but without this line their
    // badges lingered on screen until the next snapshot caught up.
    setAudioNotes([]);
    setMathElements([]);
    setRedoStack([]);
  };

  // ────────── DERIVED GESTURE PREVIEW ───────────────────────────────────
  // --- Live gesture preview, derived ---

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

  // ────────── RETURN ────────────────────────────────────────────────────
  return {
    paths,
    shapes,
    texts: textElements,
    notes,
    images,
    audioNotes,
    mathElements,
    visible: {
      paths: culledPaths,
      shapes: culledShapes,
      texts: culledTextElements,
      notes: culledNotes,
      images: culledImages,
      // Not viewport-culled — see the BoardElements interface comment.
      audioNotes: visibleAudioNotes,
      mathElements: culledMathElements,
    },
    loading: !canvasReady,

    selection,
    selectedBoxes,
    selectionUnion,
    selectAllVisible,

    dragOffset,
    marquee,
    transformPreview,
    selectedTransform,
    overlayBounds,
    overlayRotation,
    previewText,

    contentBounds,
    boxOfElement,
    hitTestAny,
    colorOfElement,
    shapeGuideTargets,
    selectedPathIds,
    selectionText,

    beginSelectGesture,
    moveSelectGesture,
    endSelectGesture,
    selectAtPoint,

    beginTransform,
    moveTransform,
    endTransform,

    commitStroke,
    drawDot,
    replaceStrokeWithShape,

    beginEraseStroke: () => {
      erasedIdsRef.current = new Set();
    },
    endEraseStroke: () => {
      erasedIdsRef.current = new Set();
    },
    eraseAtPoint: eraseAtPointWith,
    eraseTap: (point: Point, strokeWidth: number) => {
      // A stationary tap erases whatever is under it.
      erasedIdsRef.current = new Set();
      eraseAtPointWith(point, strokeWidth);
      erasedIdsRef.current = new Set();
    },

    saveShapeFromDraft,

    deleteSelected,
    duplicateSelected,
    copySelected,
    pasteClipboard,
    shortcutPaste,
    bringToFront,
    sendToBack,
    applyColor,
    applyStrokeWidth,
    applyOpacity,

    createTextElement,
    commitTextEdit,
    resizeTextElement,
    deleteTextElement,
    saveTextElement,

    pendingNotePosition,
    cancelNote,
    submitNote,
    deleteNote,

    createMathElement,
    updateMathLatex,
    latexOfMathElement,

    insertImage,
    scanDocument,

    createDiagram,

    canRedo: redoStack.length > 0,
    undo,
    redo,
    clearBoardElements,
    resetLocalElements,
  };
}
