/**
 * Characterisation harness for `useBoardElements` (3,109 lines, previously
 * untested). It documents what the hook does TODAY — it is not a spec, and one
 * test below deliberately pins behaviour that looks like a defect (see
 * "SUSPECTED DEFECT").
 *
 * Follows `useBoardCollab.test.ts`: `jest.mock` each service namespace at the
 * top, `renderHook`/`act` from `@testing-library/react-native`, stable
 * module-scope fixtures for anything that must not churn between renders.
 *
 * Scope is deliberately narrow — `commitResize` (via the public
 * begin/move/endTransform trio), `deleteSelected`, and the copy/paste round
 * trip. The drawing gesture path, the rbush index (`src/lib/spatialIndex.ts`),
 * viewport culling (`src/lib/viewport.ts`, `src/lib/culling.ts`) and the
 * image-picker plumbing are out of scope, and the pure modules those live in
 * are already covered by their own suites — notably `src/lib/__tests__/
 * clipboard.test.ts`, which owns `offsetClipItem`/`nextPasteOffset`, so nothing
 * below re-derives that arithmetic; it only pins that the hook routes through
 * it once per paste.
 */

// ────────── SERVICE MOCKS ───────────────────────────────────────────────
// Every mock RECORDS its call and returns a fixture. The only functions given
// a real body are the four pure bbox helpers the hook captures at module scope
// (see the mathService mock's comment) — none of the resize/delete/paste
// arithmetic under test is supplied by a mock.

jest.mock("../../services/pathService", () => ({
  subscribeToBoardPaths: jest.fn(),
  subscribeToBoardNotes: jest.fn(),
  subscribeToBoardTextElements: jest.fn(),
  savePath: jest.fn(),
  saveTextElement: jest.fn(),
  saveTextNote: jest.fn(),
  deletePath: jest.fn().mockResolvedValue(undefined),
  deleteTextElement: jest.fn().mockResolvedValue(undefined),
  deleteTextNote: jest.fn().mockResolvedValue(undefined),
  updateTextElement: jest.fn().mockResolvedValue(undefined),
  batchUpdatePaths: jest.fn().mockResolvedValue(undefined),
  batchUpdateTextElements: jest.fn().mockResolvedValue(undefined),
  batchDeletePaths: jest.fn().mockResolvedValue(undefined),
  batchDeleteTextElements: jest.fn().mockResolvedValue(undefined),
  batchDeleteTextNotes: jest.fn().mockResolvedValue(undefined),
  clearBoardPaths: jest.fn().mockResolvedValue(undefined),
  clearBoardNotes: jest.fn().mockResolvedValue(undefined),
  clearBoardTextElements: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/shapeService", () => ({
  subscribeToBoardShapes: jest.fn(),
  saveShape: jest.fn(),
  batchUpdateShapes: jest.fn().mockResolvedValue(undefined),
  batchDeleteShapes: jest.fn().mockResolvedValue(undefined),
  clearBoardShapes: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/imageService", () => ({
  subscribeToBoardImages: jest.fn(),
  saveImage: jest.fn(),
  uploadImage: jest.fn(),
  batchUpdateImages: jest.fn().mockResolvedValue(undefined),
  batchDeleteImages: jest.fn().mockResolvedValue(undefined),
  clearBoardImages: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/scanService", () => ({
  scanDocument: jest.fn(),
}));

jest.mock("../../services/audioService", () => ({
  subscribeToBoardAudio: jest.fn(),
  batchDeleteVoiceNotes: jest.fn().mockResolvedValue(undefined),
  deleteVoiceNotesForElements: jest.fn().mockResolvedValue(undefined),
  clearBoardVoiceNotes: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/mathService", () => ({
  subscribeToBoardMathElements: jest.fn(),
  createMathElement: jest.fn(),
  updateMathLatex: jest.fn(),
  saveMathElement: jest.fn(),
  batchUpdateMathElements: jest.fn().mockResolvedValue(undefined),
  batchDeleteMathElements: jest.fn().mockResolvedValue(undefined),
  clearBoardMathElements: jest.fn().mockResolvedValue(undefined),
  // NOT stubs. `useBoardElements.ts:235-240` captures `mathBoxOf` into a
  // module-scope const at import time and calls `mathElementBbox` from its own
  // `mathBox` helper, so a `jest.fn()` here would be `undefined` at call time.
  // Both are reproduced verbatim from `src/services/mathService.ts` (pure
  // geometry, covered by src/services/__tests__/mathService.test.ts). They are
  // faithful on purpose: the resize tests assert which of the two the write
  // path picked — `mathBoxOf` recomputes from geometry, `mathElementBbox`
  // prefers the element's STORED bbox — and a fake would make that
  // distinction untestable.
  mathBoxOf: (el: { x: number; y: number; width: number; height: number }) => ({
    minX: el.x,
    minY: el.y,
    maxX: el.x + el.width,
    maxY: el.y + el.height,
  }),
  mathElementBbox: (el: {
    x: number;
    y: number;
    width: number;
    height: number;
    bbox?: unknown;
  }) =>
    el.bbox ?? {
      minX: el.x,
      minY: el.y,
      maxX: el.x + el.width,
      maxY: el.y + el.height,
    },
}));

jest.mock("../../services/codeService", () => ({
  subscribeToBoardCodeElements: jest.fn(),
  createCodeElement: jest.fn(),
  updateCodeSource: jest.fn(),
  saveCodeElement: jest.fn(),
  batchUpdateCodeElements: jest.fn().mockResolvedValue(undefined),
  batchDeleteCodeElements: jest.fn().mockResolvedValue(undefined),
  clearBoardCodeElements: jest.fn().mockResolvedValue(undefined),
  // Real bodies, for exactly the reason mathBoxOf/mathElementBbox above have
  // them (see src/services/codeService.ts:51 / :284).
  codeBoxOf: (el: { x: number; y: number; width: number; height: number }) => ({
    minX: el.x,
    minY: el.y,
    maxX: el.x + el.width,
    maxY: el.y + el.height,
  }),
  codeElementBbox: (el: {
    x: number;
    y: number;
    width: number;
    height: number;
    bbox?: unknown;
  }) =>
    el.bbox ?? {
      minX: el.x,
      minY: el.y,
      maxX: el.x + el.width,
      maxY: el.y + el.height,
    },
}));

jest.mock("../../services/snapshotService", () => ({
  // No snapshot exists: the cold-load effect takes its "skip" branch and the
  // realtime listener below is the only seed, which is what the seeding helper
  // drives. `shouldSnapshot: false` keeps the checkpoint trigger quiet.
  getLatestSnapshot: jest.fn().mockResolvedValue(null),
  loadBoardState: jest.fn().mockResolvedValue([]),
  shouldSnapshot: jest.fn().mockReturnValue(false),
  createSnapshot: jest.fn().mockResolvedValue(undefined),
}));

import { renderHook, act } from "@testing-library/react-native";
import { useBoardElements, type BoardElementsOptions } from "../useBoardElements";
import * as pathService from "../../services/pathService";
import * as shapeService from "../../services/shapeService";
import * as imageService from "../../services/imageService";
import * as mathService from "../../services/mathService";
import * as codeService from "../../services/codeService";
import * as audioService from "../../services/audioService";
import { clearClipboard } from "../../lib/clipboard";
import { MIN_SCALE_FACTOR } from "../../lib/transform";
import type {
  DrawPath,
  ShapeElement,
  TextElement,
  TextNote,
  ImageElement,
  MathElement,
  CodeElement,
} from "../../types";

const subscribeToBoardPaths = pathService.subscribeToBoardPaths as jest.Mock;
const subscribeToBoardNotes = pathService.subscribeToBoardNotes as jest.Mock;
const subscribeToBoardTextElements = pathService.subscribeToBoardTextElements as jest.Mock;
const subscribeToBoardShapes = shapeService.subscribeToBoardShapes as jest.Mock;
const subscribeToBoardImages = imageService.subscribeToBoardImages as jest.Mock;
const subscribeToBoardMathElements = mathService.subscribeToBoardMathElements as jest.Mock;
const subscribeToBoardCodeElements = codeService.subscribeToBoardCodeElements as jest.Mock;
const subscribeToBoardAudio = audioService.subscribeToBoardAudio as jest.Mock;

const batchUpdatePaths = pathService.batchUpdatePaths as jest.Mock;
const batchUpdateTextElements = pathService.batchUpdateTextElements as jest.Mock;
const batchUpdateShapes = shapeService.batchUpdateShapes as jest.Mock;
const batchUpdateImages = imageService.batchUpdateImages as jest.Mock;
const batchUpdateMathElements = mathService.batchUpdateMathElements as jest.Mock;
const batchUpdateCodeElements = codeService.batchUpdateCodeElements as jest.Mock;

const batchDeletePaths = pathService.batchDeletePaths as jest.Mock;
const batchDeleteTextElements = pathService.batchDeleteTextElements as jest.Mock;
const batchDeleteTextNotes = pathService.batchDeleteTextNotes as jest.Mock;
const batchDeleteShapes = shapeService.batchDeleteShapes as jest.Mock;
const batchDeleteImages = imageService.batchDeleteImages as jest.Mock;
const batchDeleteMathElements = mathService.batchDeleteMathElements as jest.Mock;
const batchDeleteCodeElements = codeService.batchDeleteCodeElements as jest.Mock;

const savePath = pathService.savePath as jest.Mock;
const saveTextElement = pathService.saveTextElement as jest.Mock;
const saveShape = shapeService.saveShape as jest.Mock;
const saveImage = imageService.saveImage as jest.Mock;
const saveMathElement = mathService.saveMathElement as jest.Mock;
const saveCodeElement = codeService.saveCodeElement as jest.Mock;

// ────────── FIXTURES ────────────────────────────────────────────────────
// Stable at module scope for the same reason `useBoardCollab.test.ts`'s SELF /
// VIEWPORT are: `blockedIds`, `canvasSize` and `viewport` are compared by
// identity inside the hook's `useMemo` deps, so fresh literals per render would
// churn every `visible*` memo, the spatial index and the culling pass on every
// rerender and make an assertion about *what* was persisted hostage to *when*.
const BOARD = "board-1";
const USER = "user-1";
const NO_BLOCKED: string[] = [];
const CANVAS = { width: 800, height: 600 };
const VIEWPORT = { x: 0, y: 0, scale: 1 };
const T0 = new Date(0);

// The selected set's boxes union to exactly { 0, 0, 100, 100 }, so every scale
// factor in the resize tests below is a whole number the expectations state
// literally instead of re-deriving. One element of each kind the resize path
// handles, including both Month 6 kinds.
//
// Each stored `bbox` is what that kind's own write path would actually have
// persisted, not a tidied-up geometry box: a path's is inflated by half its
// stroke width (`commitStroke`), a shape's likewise (`lib/shapes.ts#shapeBbox`).
// The geometry is chosen so the faithful boxes still land on round numbers.
const PATH_1: DrawPath = {
  id: "path-1",
  boardId: BOARD,
  userId: USER,
  points: [
    { x: 2, y: 2 },
    { x: 38, y: 38 },
  ],
  color: "#111111",
  strokeWidth: 4,
  tool: "pen",
  bbox: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
  createdAt: T0,
};

const SHAPE_1: ShapeElement = {
  id: "shape-1",
  boardId: BOARD,
  userId: USER,
  shape: "rect",
  x: 51,
  y: 1,
  width: 48,
  height: 48,
  rotation: 0,
  fill: "none",
  stroke: "#222222",
  strokeWidth: 2,
  dashed: false,
  arrowheadStart: "none",
  arrowheadEnd: "none",
  bbox: { minX: 50, minY: 0, maxX: 100, maxY: 50 },
  createdAt: T0,
};

// Never selected in any test — the control that proves each per-kind update /
// delete list is filtered by the selection rather than sent wholesale.
const SHAPE_2: ShapeElement = {
  ...SHAPE_1,
  id: "shape-2",
  x: 401,
  y: 401,
  bbox: { minX: 400, minY: 400, maxX: 450, maxY: 450 },
};

const TEXT_1: TextElement = {
  id: "text-1",
  boardId: BOARD,
  userId: USER,
  text: "hello",
  position: { x: 0, y: 50 },
  width: 50,
  height: 50,
  fontSize: 16,
  color: "#333333",
  createdAt: T0,
};

// Present on the board but never selected for a resize — proves an absent kind
// still gets its own (empty) persist call rather than being skipped.
const IMAGE_1: ImageElement = {
  id: "image-1",
  boardId: BOARD,
  userId: USER,
  storagePath: "boards/board-1/img.png",
  thumbnailPath: "boards/board-1/img_thumb.png",
  url: "https://example.test/img.png",
  thumbnailUrl: "https://example.test/img_thumb.png",
  x: 400,
  y: 0,
  width: 40,
  height: 40,
  rotation: 0,
  naturalWidth: 400,
  naturalHeight: 400,
  alt: "",
  bbox: { minX: 400, minY: 0, maxX: 440, maxY: 40 },
  createdAt: T0,
};

// `bbox` is stored and CORRECT for the pre-resize geometry, which is what makes
// the post-resize bbox assertions load-bearing: `mathBox`(= mathElementBbox)
// would hand back this stored box, `mathBoxOf` recomputes from the new
// geometry, and only one of those matches the expectation.
const MATH_1: MathElement = {
  id: "math-1",
  schemaVersion: 1,
  type: "math",
  boardId: BOARD,
  userId: USER,
  latex: "x^2",
  svgPath: "M0 0 L10 10",
  width: 50,
  height: 50,
  x: 50,
  y: 50,
  scale: 1,
  bbox: { minX: 50, minY: 50, maxX: 100, maxY: 100 },
  createdAt: T0,
};

const CODE_1: CodeElement = {
  id: "code-1",
  schemaVersion: 1,
  type: "code",
  boardId: BOARD,
  userId: USER,
  code: "print(1)",
  language: "py",
  x: 90,
  y: 90,
  width: 10,
  height: 10,
  fontSize: 12,
  bbox: { minX: 90, minY: 90, maxX: 100, maxY: 100 },
  createdAt: T0,
};

const NOTE_1: TextNote = {
  id: "note-1",
  boardId: BOARD,
  userId: USER,
  content: "a sticky",
  position: { x: 200, y: 200 },
  createdAt: T0,
};

/** Ids of the five elements whose boxes union to { 0, 0, 100, 100 }. */
const RESIZE_SELECTION = ["path-1", "shape-1", "text-1", "math-1", "code-1"];

// ────────── HARNESS ─────────────────────────────────────────────────────

/** The `(incoming) => void` callback a mocked subscription most recently registered. */
function latestCallback(mock: jest.Mock, argIndex = 1): (incoming: unknown[]) => void {
  const calls = mock.mock.calls;
  if (calls.length === 0) throw new Error("subscription was never registered");
  return calls[calls.length - 1][argIndex];
}

function makeOpts(over: Partial<BoardElementsOptions> = {}): BoardElementsOptions {
  return {
    userId: USER,
    canvasSize: CANVAS,
    blockedIds: NO_BLOCKED,
    editingTextId: null,
    isAdmin: false,
    isAltHeld: () => false,
    onEditText: jest.fn(),
    onActivateSelectTool: jest.fn(),
    onScheduleSave: jest.fn(),
    onError: jest.fn(),
    onQuotaExceeded: jest.fn(),
    ...over,
  };
}

function renderElements(opts: BoardElementsOptions = makeOpts(), boardId = BOARD) {
  return renderHook(() => useBoardElements(boardId, VIEWPORT, opts));
}

interface Seed {
  paths?: DrawPath[];
  shapes?: ShapeElement[];
  texts?: TextElement[];
  notes?: TextNote[];
  images?: ImageElement[];
  math?: MathElement[];
  code?: CodeElement[];
}

/**
 * Push one realistic snapshot per collection through the captured subscription
 * callbacks. `canvasReady` only flips on the PATHS listener (see
 * `useBoardElements.ts:711-719`), so the paths callback always fires — with an
 * empty array when the seed has no strokes — or the harness could only ever
 * exercise the loading state.
 */
function seed(s: Seed) {
  act(() => {
    latestCallback(subscribeToBoardPaths)(s.paths ?? []);
    latestCallback(subscribeToBoardShapes)(s.shapes ?? []);
    latestCallback(subscribeToBoardTextElements)(s.texts ?? []);
    latestCallback(subscribeToBoardNotes)(s.notes ?? []);
    latestCallback(subscribeToBoardImages)(s.images ?? []);
    latestCallback(subscribeToBoardMathElements)(s.math ?? []);
    latestCallback(subscribeToBoardCodeElements)(s.code ?? []);
    latestCallback(subscribeToBoardAudio)([]);
  });
}

/** Everything the resize tests need on the board, selected set already applied. */
function seedBoardAndSelect(
  result: { current: ReturnType<typeof useBoardElements> },
  ids: string[] = RESIZE_SELECTION
) {
  seed({
    paths: [PATH_1],
    shapes: [SHAPE_1, SHAPE_2],
    texts: [TEXT_1],
    images: [IMAGE_1],
    math: [MATH_1],
    code: [CODE_1],
    notes: [NOTE_1],
  });
  act(() => {
    result.current.selection.setMany(ids, "elements");
  });
}

/** Drive one complete resize drag: grab `handle`, move by (dx, dy), release. */
async function dragHandle(
  result: { current: ReturnType<typeof useBoardElements> },
  handle: "br" | "r",
  dx: number,
  dy: number
) {
  act(() => {
    result.current.beginTransform(handle);
  });
  act(() => {
    result.current.moveTransform(handle, dx, dy);
  });
  await act(async () => {
    await result.current.endTransform();
  });
}

/**
 * The bottom-right handle. With the union at { 0, 0, 100, 100 } its anchor is
 * (0, 0) and it starts at (100, 100), so `moveTransform`'s factors come out as
 * |100 + d| / 100 per axis.
 */
const dragBottomRight = (
  result: { current: ReturnType<typeof useBoardElements> },
  dx: number,
  dy: number
) => dragHandle(result, "br", dx, dy);

/** The single `{ id, data }` the given batch-update mock was handed for `id`.
 *  `data` is the hook's own `{ id: string; data: any }` payload shape. */
function updateFor(mock: jest.Mock, id: string): Record<string, any> {
  const updates = mock.mock.calls[mock.mock.calls.length - 1][1] as {
    id: string;
    data: Record<string, any>;
  }[];
  const hit = updates.find((u) => u.id === id);
  if (!hit) throw new Error(`no update recorded for ${id} (got ${updates.map((u) => u.id)})`);
  return hit.data;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearClipboard();
  // Unsubscribe functions, and a fresh capture slot per subscription.
  for (const m of [
    subscribeToBoardPaths,
    subscribeToBoardNotes,
    subscribeToBoardTextElements,
    subscribeToBoardShapes,
    subscribeToBoardImages,
    subscribeToBoardMathElements,
    subscribeToBoardCodeElements,
    subscribeToBoardAudio,
  ]) {
    m.mockReturnValue(jest.fn());
  }
  // Distinct, recognisably-new ids so a paste that reused a source id would be
  // visible rather than merely equal-by-accident.
  savePath.mockImplementation(async () => "new-path");
  saveShape.mockImplementation(async () => "new-shape");
  saveTextElement.mockImplementation(async () => "new-text");
  saveImage.mockImplementation(async () => "new-image");
  saveMathElement.mockImplementation(async () => "new-math");
  saveCodeElement.mockImplementation(async () => "new-code");
});

// ────────── HARNESS SANITY ──────────────────────────────────────────────

describe("useBoardElements — harness seeding", () => {
  it("stays loading until the paths snapshot arrives, then exposes every seeded kind", () => {
    const { result } = renderElements();
    expect(result.current.loading).toBe(true);

    seedBoardAndSelect(result, []);

    expect(result.current.loading).toBe(false);
    expect(result.current.paths.map((p) => p.id)).toEqual(["path-1"]);
    expect(result.current.shapes.map((s) => s.id)).toEqual(["shape-1", "shape-2"]);
    expect(result.current.texts.map((t) => t.id)).toEqual(["text-1"]);
    expect(result.current.images.map((i) => i.id)).toEqual(["image-1"]);
    expect(result.current.mathElements.map((m) => m.id)).toEqual(["math-1"]);
    expect(result.current.codeElements.map((c) => c.id)).toEqual(["code-1"]);
    expect(result.current.notes.map((n) => n.id)).toEqual(["note-1"]);
  });

  it("unions the five selected boxes into the group overlay box the resize anchors on", () => {
    const { result } = renderElements();
    seedBoardAndSelect(result);
    // Every expectation in the resize block below is stated as a literal on the
    // assumption that this union is exactly 100x100 at the origin.
    expect(result.current.selectionUnion).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });
});

// ────────── 1. commitResize — scale arithmetic ──────────────────────────

describe("useBoardElements — commitResize scale arithmetic", () => {
  it("a uniform 2x corner drag persists doubled geometry for the path, shape, text, math and code element in the selection", async () => {
    const { result } = renderElements();
    seedBoardAndSelect(result);

    // (100 + 100) / 100 = 2 on both axes.
    await dragBottomRight(result, 100, 100);

    // Path: points scaled about (0,0); bbox re-inflated by half the (unscaled)
    // stroke width, 4 / 2 = 2.
    expect(updateFor(batchUpdatePaths, "path-1")).toEqual({
      points: [
        { x: 4, y: 4 },
        { x: 76, y: 76 },
      ],
      bbox: { minX: 2, minY: 2, maxX: 78, maxY: 78 },
    });

    // Shape: top-left scaled about the anchor, box doubled; bbox inflated by
    // half the (unscaled) stroke width, 2 / 2 = 1.
    expect(updateFor(batchUpdateShapes, "shape-1")).toEqual({
      x: 102,
      y: 2,
      width: 96,
      height: 96,
      bbox: { minX: 101, minY: 1, maxX: 199, maxY: 99 },
    });

    // Text: position + box doubled, fontSize taken from sy (16 * 2, rounded).
    expect(updateFor(batchUpdateTextElements, "text-1")).toEqual({
      position: { x: 0, y: 100 },
      width: 100,
      height: 100,
      fontSize: 32,
    });

    // Math: resizes by `scale`, and the persisted bbox is recomputed from the
    // NEW geometry — MATH_1 carries a stored bbox of { 50, 50, 100, 100 }, so
    // this also pins that the write path used `mathBoxOf`, not `mathBox`.
    expect(updateFor(batchUpdateMathElements, "math-1")).toEqual({
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      scale: 2,
      bbox: { minX: 100, minY: 100, maxX: 200, maxY: 200 },
    });

    // Code: box doubled per axis and fontSize from sy (12 * 2); bbox from the
    // new geometry, same `codeBoxOf` vs `codeBox` distinction as math above.
    expect(updateFor(batchUpdateCodeElements, "code-1")).toEqual({
      x: 180,
      y: 180,
      width: 20,
      height: 20,
      fontSize: 24,
      bbox: { minX: 180, minY: 180, maxX: 200, maxY: 200 },
    });
  });

  it("issues the images batch call with an empty list when no image is selected, and omits the unselected shape", async () => {
    const { result } = renderElements();
    seedBoardAndSelect(result);

    await dragBottomRight(result, 100, 100);

    // IMAGE_1 is on the board but unselected: the kind still gets its own
    // persist call (so a future selection cannot silently skip it) with nothing
    // in it.
    expect(batchUpdateImages).toHaveBeenCalledWith(BOARD, []);
    // SHAPE_2 is on the board and unselected: present in neither list.
    const shapeUpdates = batchUpdateShapes.mock.calls[0][1] as { id: string }[];
    expect(shapeUpdates.map((u) => u.id)).toEqual(["shape-1"]);
  });

  it("uniformizes a horizontal-only corner drag to max(sx, sy) unless alt is held", async () => {
    // Same drag both times — 2x on x, 1x on y — so the only difference is the
    // alt getter `moveTransform` reads mid-gesture.
    const uniform = renderElements(makeOpts({ isAltHeld: () => false }));
    seedBoardAndSelect(uniform.result);
    await dragBottomRight(uniform.result, 100, 0);

    expect(updateFor(batchUpdateShapes, "shape-1")).toEqual(
      expect.objectContaining({ width: 96, height: 96 })
    );
    expect(updateFor(batchUpdateTextElements, "text-1")).toEqual(
      expect.objectContaining({ height: 100, fontSize: 32 })
    );

    jest.clearAllMocks();

    const alt = renderElements(makeOpts({ isAltHeld: () => true }));
    seedBoardAndSelect(alt.result);
    await dragBottomRight(alt.result, 100, 0);

    // sy stays 1: the height and the sy-derived fontSize are untouched while
    // the width still doubles.
    expect(updateFor(batchUpdateShapes, "shape-1")).toEqual(
      expect.objectContaining({ width: 96, height: 48 })
    );
    expect(updateFor(batchUpdateTextElements, "text-1")).toEqual(
      expect.objectContaining({ width: 100, height: 50, fontSize: 16 })
    );
  });

  it("scales a math element by max(|sx|,|sy|) on both axes under an alt-held non-uniform drag, while the code element scales per axis", async () => {
    const { result } = renderElements(makeOpts({ isAltHeld: () => true }));
    seedBoardAndSelect(result);

    // sx = 2, sy = 1.
    await dragBottomRight(result, 100, 0);

    // A glyph outline is never stretched: both dimensions take the larger
    // factor, so height grows even though sy is 1.
    expect(updateFor(batchUpdateMathElements, "math-1")).toEqual({
      x: 100,
      y: 50,
      width: 100,
      height: 100,
      scale: 2,
      bbox: { minX: 100, minY: 50, maxX: 200, maxY: 150 },
    });

    // The code element, on the same drag, takes sx and sy independently.
    expect(updateFor(batchUpdateCodeElements, "code-1")).toEqual({
      x: 180,
      y: 90,
      width: 20,
      height: 10,
      fontSize: 12,
      bbox: { minX: 180, minY: 90, maxX: 200, maxY: 100 },
    });
  });

  it("floors a drag back onto the anchor at MIN_SCALE_FACTOR, leaving every persisted dimension above zero", async () => {
    const { result } = renderElements();
    seedBoardAndSelect(result);

    // pointer lands exactly on the anchor: the raw factor is 0 on both axes.
    await dragBottomRight(result, -100, -100);

    const s = MIN_SCALE_FACTOR; // 0.02
    const shape = updateFor(batchUpdateShapes, "shape-1");
    expect(shape.width).toBeCloseTo(48 * s, 10);
    expect(shape.height).toBeCloseTo(48 * s, 10);
    expect(shape.width).toBeGreaterThan(0);
    expect(shape.height).toBeGreaterThan(0);

    const text = updateFor(batchUpdateTextElements, "text-1");
    expect(text.width).toBeCloseTo(50 * s, 10);
    // Math.round(16 * 0.02) is 0; the separate `Math.max(1, ...)` floor is what
    // keeps the element legible rather than MIN_SCALE_FACTOR.
    expect(text.fontSize).toBe(1);

    // MIN_MATH_SCALE (0.05) is a higher floor than 1 * MIN_SCALE_FACTOR, so it
    // is the one that binds here.
    const math = updateFor(batchUpdateMathElements, "math-1");
    expect(math.scale).toBe(0.05);
    expect(math.width).toBeCloseTo(2.5, 10);
    expect(math.height).toBeCloseTo(2.5, 10);

    const code = updateFor(batchUpdateCodeElements, "code-1");
    expect(code.width).toBeCloseTo(10 * s, 10);
    expect(code.width).toBeGreaterThan(0);
    // Math.round(12 * 0.02) is 0; MIN_CODE_FONT_SIZE is the binding floor.
    expect(code.fontSize).toBe(6);
  });

  it("turns an edge drag past the anchor into a positive (mirrored) x factor rather than a negative one", async () => {
    const { result } = renderElements();
    seedBoardAndSelect(result);

    // The right-edge handle anchors at (0, 50) and starts at (100, 50), so a
    // 300-unit drag left puts the pointer at x = -200 — 200 units on the FAR
    // side of the anchor. An edge handle is deliberately used rather than a
    // corner: `isCornerHandle`'s `Math.max(sx, sy)` would let the y axis's own
    // (still absolute) factor mask a negative x one, so only here is
    // `Math.abs` the single thing keeping the factor positive.
    await dragHandle(result, "r", -300, 0);

    // |−200 − 0| / 100 = 2, not −2, so the box grows instead of inverting; sy
    // stays 1 because "r" involves no y axis at all.
    expect(updateFor(batchUpdateShapes, "shape-1")).toEqual(
      expect.objectContaining({ x: 102, y: 1, width: 96, height: 48 })
    );
  });

  it("persists nothing when the handle is released back at its start (sx and sy both 1)", async () => {
    const opts = makeOpts();
    const { result } = renderElements(opts);
    seedBoardAndSelect(result);

    await dragBottomRight(result, 0, 0);

    expect(batchUpdatePaths).not.toHaveBeenCalled();
    expect(batchUpdateShapes).not.toHaveBeenCalled();
    expect(batchUpdateTextElements).not.toHaveBeenCalled();
    expect(batchUpdateImages).not.toHaveBeenCalled();
    expect(batchUpdateMathElements).not.toHaveBeenCalled();
    expect(batchUpdateCodeElements).not.toHaveBeenCalled();
    expect(opts.onScheduleSave).not.toHaveBeenCalled();
  });
});

// ────────── 2. deleteSelected — id subtraction ──────────────────────────

describe("useBoardElements — deleteSelected id routing", () => {
  it("routes one id of each kind to that kind's own batch delete and to no other", async () => {
    const { result } = renderElements();
    seedBoardAndSelect(result, []);

    await act(async () => {
      await result.current.deleteSelected([
        "path-1",
        "shape-1",
        "text-1",
        "image-1",
        "math-1",
        "code-1",
      ]);
    });

    expect(batchDeletePaths).toHaveBeenCalledWith(BOARD, ["path-1"]);
    expect(batchDeleteShapes).toHaveBeenCalledWith(BOARD, ["shape-1"]);
    expect(batchDeleteTextElements).toHaveBeenCalledWith(BOARD, ["text-1"]);
    expect(batchDeleteImages).toHaveBeenCalledWith(BOARD, ["image-1"]);
    expect(batchDeleteMathElements).toHaveBeenCalledWith(BOARD, ["math-1"]);
    expect(batchDeleteCodeElements).toHaveBeenCalledWith(BOARD, ["code-1"]);
  });

  it("leaves the unselected shape and image out of every delete call", async () => {
    const { result } = renderElements();
    seedBoardAndSelect(result, []);

    await act(async () => {
      await result.current.deleteSelected(["shape-1"]);
    });

    expect(batchDeleteShapes).toHaveBeenCalledWith(BOARD, ["shape-1"]);
    for (const m of [
      batchDeletePaths,
      batchDeleteTextElements,
      batchDeleteImages,
      batchDeleteMathElements,
      batchDeleteCodeElements,
    ]) {
      expect(m).toHaveBeenCalledWith(BOARD, []);
    }
    const everyId = [
      ...batchDeletePaths.mock.calls,
      ...batchDeleteShapes.mock.calls,
      ...batchDeleteTextElements.mock.calls,
      ...batchDeleteImages.mock.calls,
      ...batchDeleteMathElements.mock.calls,
      ...batchDeleteCodeElements.mock.calls,
    ].flatMap((c) => c[1] as string[]);
    expect(everyId).not.toContain("shape-2");
    expect(everyId).not.toContain("image-1");
  });

  it("sends an id that matches no element on the board to the paths collection (the documented leftover rule)", async () => {
    const { result } = renderElements();
    seedBoardAndSelect(result, []);

    await act(async () => {
      await result.current.deleteSelected(["ghost-1"]);
    });

    // `pathIds` is "whatever is left over" — see useBoardElements.ts:1964.
    expect(batchDeletePaths).toHaveBeenCalledWith(BOARD, ["ghost-1"]);
  });

  it("resolves rather than rejecting when a per-kind delete fails, and reports it through onError", async () => {
    const opts = makeOpts();
    const { result } = renderElements(opts);
    seedBoardAndSelect(result, []);
    batchDeleteShapes.mockRejectedValueOnce(new Error("offline"));

    await act(async () => {
      await expect(result.current.deleteSelected(["shape-1"])).resolves.toBeUndefined();
    });

    expect(opts.onError).toHaveBeenCalledWith("Failed to delete some elements.");
    expect(opts.onScheduleSave).not.toHaveBeenCalled();
  });

  it("does nothing at all for an empty id list", async () => {
    const opts = makeOpts();
    const { result } = renderElements(opts);
    seedBoardAndSelect(result, []);

    await act(async () => {
      await result.current.deleteSelected([]);
    });

    expect(batchDeletePaths).not.toHaveBeenCalled();
    expect(batchDeleteShapes).not.toHaveBeenCalled();
    expect(opts.onScheduleSave).not.toHaveBeenCalled();
  });

  /**
   * SUSPECTED DEFECT — documented, NOT fixed.
   *
   * `deleteSelected` classifies an id against shapes / text elements / images /
   * math / code and treats everything left over as a stroke
   * (`useBoardElements.ts:1967`). Sticky notes (`TextNote`) live in their own
   * collection and are absent from that classification, so a selected note's id
   * is issued as a delete against `paths` — where no such document exists — and
   * the note itself is never deleted. The local `notes` array is not filtered
   * either, so the note stays on screen.
   *
   * A note id genuinely reaches the selection in production: "note" is in
   * `CANVAS_CITATION_KINDS` (src/services/boardQaService.ts:78) and
   * `handleSelectCitation` (app/board/[id].tsx:535) calls
   * `elements.selection.select(elementId)` for it, after which the screen's
   * `handleDeleteSelected` (app/board/[id].tsx:582-586) passes that id straight
   * here. The hook's own `selectionText()` (useBoardElements.ts:1284) likewise
   * assumes notes can be selected.
   *
   * This test pins TODAY'S behaviour so a fix has something to flip.
   */
  it("SUSPECTED DEFECT: issues a selected sticky note's id against the paths collection and never deletes the note", async () => {
    const { result } = renderElements();
    seedBoardAndSelect(result, []);

    await act(async () => {
      await result.current.deleteSelected(["note-1"]);
    });

    // The misrouted delete.
    expect(batchDeletePaths).toHaveBeenCalledWith(BOARD, ["note-1"]);
    // No note delete is issued on any path (`batchDeleteTextNotes` is only ever
    // reached by the anchor cascade, which matches on `anchorElementId`, not id).
    expect(batchDeleteTextNotes).not.toHaveBeenCalled();
    expect(pathService.deleteTextNote).not.toHaveBeenCalled();
    // And the note survives locally.
    expect(result.current.notes.map((n) => n.id)).toEqual(["note-1"]);
  });
});

// ────────── 3. copy / paste round trip ──────────────────────────────────

describe("useBoardElements — copy/paste round trip", () => {
  it("pastes one element per copied kind, each through its own save service", async () => {
    const { result } = renderElements();
    seedBoardAndSelect(result, [...RESIZE_SELECTION, "image-1"]);

    act(() => {
      result.current.copySelected();
    });
    await act(async () => {
      await result.current.pasteClipboard();
    });

    expect(savePath).toHaveBeenCalledTimes(1);
    expect(saveShape).toHaveBeenCalledTimes(1);
    expect(saveTextElement).toHaveBeenCalledTimes(1);
    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(saveMathElement).toHaveBeenCalledTimes(1);
    expect(saveCodeElement).toHaveBeenCalledTimes(1);
  });

  it("selects only the ids the save services handed back, none of which is a source id", async () => {
    const { result } = renderElements();
    seedBoardAndSelect(result, RESIZE_SELECTION);

    act(() => {
      result.current.copySelected();
    });
    await act(async () => {
      await result.current.pasteClipboard();
    });

    expect([...result.current.selection.selectedIds].sort()).toEqual([
      "new-code",
      "new-math",
      "new-path",
      "new-shape",
      "new-text",
    ]);
    for (const sourceId of RESIZE_SELECTION) {
      expect(result.current.selection.selectedIds.has(sourceId)).toBe(false);
    }
  });

  it("strips id and createdAt from every pasted payload and re-stamps the pasting board and user", async () => {
    const first = renderElements();
    seedBoardAndSelect(first.result, ["shape-1", "path-1"]);
    act(() => {
      first.result.current.copySelected();
    });

    // The clipboard store is module-level precisely so a payload survives to
    // another board (src/lib/clipboard.ts's header) — paste from a second hook
    // on a different board, as a real cross-board paste would.
    const second = renderElements(makeOpts({ userId: "user-2" }), "board-2");
    await act(async () => {
      await second.result.current.pasteClipboard();
    });

    const [boardArg, shapePayload] = saveShape.mock.calls[0];
    expect(boardArg).toBe("board-2");
    expect(shapePayload).not.toHaveProperty("id");
    expect(shapePayload).not.toHaveProperty("createdAt");
    expect(shapePayload).toMatchObject({ boardId: "board-2", userId: "user-2" });

    const [, pathPayload] = savePath.mock.calls[0];
    expect(pathPayload).not.toHaveProperty("id");
    expect(pathPayload).not.toHaveProperty("createdAt");
    expect(pathPayload).toMatchObject({ boardId: "board-2", userId: "user-2" });
  });

  it("offsets the first paste by one step down-right and the second by two", async () => {
    // The cascade arithmetic itself is `nextPasteOffset`/`offsetClipItem`, both
    // covered in src/lib/__tests__/clipboard.test.ts. What is pinned here is
    // that the hook advances the cascade exactly once per paste and applies the
    // result to the payload it persists.
    const { result } = renderElements();
    seedBoardAndSelect(result, ["shape-1"]);

    act(() => {
      result.current.copySelected();
    });
    await act(async () => {
      await result.current.pasteClipboard();
    });
    await act(async () => {
      await result.current.pasteClipboard();
    });

    // SHAPE_1 sits at (51, 1); DUPLICATE_OFFSET is 16.
    expect(saveShape.mock.calls[0][1]).toMatchObject({ x: 67, y: 17 });
    expect(saveShape.mock.calls[1][1]).toMatchObject({ x: 83, y: 33 });
  });

  it("is a no-op on an empty clipboard: no save, no selection change, no throw", async () => {
    const opts = makeOpts();
    const { result } = renderElements(opts);
    seedBoardAndSelect(result, ["shape-1"]);

    await act(async () => {
      await expect(result.current.pasteClipboard()).resolves.toBeUndefined();
    });

    expect(saveShape).not.toHaveBeenCalled();
    expect(savePath).not.toHaveBeenCalled();
    expect(opts.onActivateSelectTool).not.toHaveBeenCalled();
    expect(opts.onScheduleSave).not.toHaveBeenCalled();
    // The pre-existing selection is left alone rather than replaced with [].
    expect([...result.current.selection.selectedIds]).toEqual(["shape-1"]);
  });

  it("copies nothing for a selected sticky note, so pasting a note-only selection writes nothing", async () => {
    // The same gap the delete defect above documents: `copySelected` iterates
    // paths/shapes/texts/images/math/code and never `notes`.
    const { result } = renderElements();
    seedBoardAndSelect(result, ["note-1"]);

    act(() => {
      result.current.copySelected();
    });
    await act(async () => {
      await result.current.pasteClipboard();
    });

    expect(pathService.saveTextNote).not.toHaveBeenCalled();
    expect(savePath).not.toHaveBeenCalled();
    expect(saveShape).not.toHaveBeenCalled();
  });
});
