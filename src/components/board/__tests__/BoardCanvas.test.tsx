jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

// The cursor side channel is CursorLayer's own subscription (not a BoardCanvas
// prop) — stub it so mounting BoardCanvas never reaches real Firestore.
jest.mock("../../../services/cursorService", () => ({
  subscribeToCursors: jest.fn(() => jest.fn()),
  visibleCursors: jest.fn(() => []),
  CURSOR_STALE_MS: 10000,
}));

// DrawingCanvas is the gesture source: mocking it lets tests drive
// onStrokeStart/onStrokeMove/onStrokeEnd/onTap directly instead of simulating
// react-native-gesture-handler's recognizer.
let mockDrawingCanvasProps: any = null;
jest.mock("../../DrawingCanvas", () => ({
  __esModule: true,
  default: (props: any) => {
    mockDrawingCanvasProps = props;
    return null;
  },
}));

// The three content-creation call sites (item 1) are wired as props to these
// three children — mocking them lets the tests assert on exactly what
// BoardCanvas decided to pass (a real handler vs. `undefined`) rather than
// hand-tracing through each child's own rendering.
let mockOverlayProps: any = null;
jest.mock("../BoardOverlayLayer", () => ({
  __esModule: true,
  default: (props: any) => {
    mockOverlayProps = props;
    return null;
  },
}));

let mockAiSelectionProps: any = null;
jest.mock("../AiSelectionActions", () => ({
  __esModule: true,
  default: (props: any) => {
    mockAiSelectionProps = props;
    return null;
  },
}));

let mockPerfectShapePromptProps: any = null;
jest.mock("../PerfectShapePrompt", () => ({
  __esModule: true,
  default: (props: any) => {
    mockPerfectShapePromptProps = props;
    return null;
  },
}));

import React from "react";
import { render, screen, act } from "@testing-library/react-native";
import BoardCanvas from "../BoardCanvas";
import type { BoardElements } from "../../../hooks/useBoardElements";
import type { BoardTools, Tool } from "../../../hooks/useBoardTools";
import type { BoardCollab } from "../../../hooks/useBoardCollab";
import type { BoardAI } from "../../../hooks/useBoardAI";
import type { BoardComments } from "../../../hooks/useBoardComments";

/**
 * BoardCanvas.test.tsx (Task 14 fix round).
 *
 * BoardCanvas takes every hook as a prop, so it's testable without a live
 * board: build a complete, jest.fn()-backed double for each hook, mock the
 * heavy children (DrawingCanvas for gestures; BoardOverlayLayer /
 * AiSelectionActions / PerfectShapePrompt for the three content-creation call
 * sites), and drive the captured callbacks directly.
 */

function makeElements(overrides: Partial<BoardElements> = {}): BoardElements {
  return {
    paths: [],
    shapes: [],
    texts: [],
    notes: [],
    images: [],
    visible: { paths: [], shapes: [], texts: [], notes: [], images: [] },
    loading: false,

    selection: {
      selectedIds: new Set(),
      selectedId: null,
      count: 0,
      anchor: "elements",
      isSelected: jest.fn(() => false),
      select: jest.fn(),
      setMany: jest.fn(),
      addMany: jest.fn(),
      toggle: jest.fn(),
      remove: jest.fn(),
      clear: jest.fn(),
    },
    selectedBoxes: [],
    selectionUnion: null,
    selectAllVisible: jest.fn(),

    dragOffset: null,
    marquee: null,
    transformPreview: null,
    selectedTransform: undefined,
    overlayBounds: null,
    overlayRotation: 0,
    previewText: jest.fn((el) => el),

    contentBounds: jest.fn(() => null),
    boxOfElement: jest.fn(() => null),
    hitTestAny: jest.fn(() => null),
    shapeGuideTargets: jest.fn(() => []),
    selectedPathIds: jest.fn(() => []),
    selectionText: jest.fn(() => ""),

    beginSelectGesture: jest.fn(),
    moveSelectGesture: jest.fn(),
    endSelectGesture: jest.fn().mockResolvedValue(undefined),
    selectAtPoint: jest.fn(),

    beginTransform: jest.fn(),
    moveTransform: jest.fn(),
    endTransform: jest.fn().mockResolvedValue(undefined),

    commitStroke: jest.fn().mockResolvedValue("path-1"),
    drawDot: jest.fn().mockResolvedValue(undefined),
    replaceStrokeWithShape: jest.fn().mockResolvedValue(undefined),

    beginEraseStroke: jest.fn(),
    endEraseStroke: jest.fn(),
    eraseAtPoint: jest.fn(),
    eraseTap: jest.fn(),

    saveShapeFromDraft: jest.fn().mockResolvedValue(undefined),

    deleteSelected: jest.fn().mockResolvedValue(undefined),
    duplicateSelected: jest.fn().mockResolvedValue(undefined),
    copySelected: jest.fn(),
    pasteClipboard: jest.fn().mockResolvedValue(undefined),
    shortcutPaste: jest.fn().mockResolvedValue(undefined),
    bringToFront: jest.fn().mockResolvedValue(undefined),
    sendToBack: jest.fn().mockResolvedValue(undefined),
    applyColor: jest.fn(),
    applyStrokeWidth: jest.fn(),

    createTextElement: jest.fn().mockResolvedValue(undefined),
    commitTextEdit: jest.fn().mockResolvedValue(undefined),
    resizeTextElement: jest.fn().mockResolvedValue(undefined),
    deleteTextElement: jest.fn().mockResolvedValue(undefined),
    saveTextElement: jest.fn().mockResolvedValue("text-1"),

    pendingNotePosition: null,
    cancelNote: jest.fn(),
    submitNote: jest.fn().mockResolvedValue(undefined),
    deleteNote: jest.fn().mockResolvedValue(undefined),

    insertImage: jest.fn(),

    createDiagram: jest.fn().mockResolvedValue([]),

    canRedo: false,
    undo: jest.fn().mockResolvedValue(undefined),
    redo: jest.fn().mockResolvedValue(undefined),
    clearBoardElements: jest.fn().mockResolvedValue(undefined),
    resetLocalElements: jest.fn(),

    ...overrides,
  };
}

function makeTools(overrides: Partial<BoardTools> & { activeTool: Tool }): BoardTools {
  return {
    setActiveTool: jest.fn(),
    activateSelect: jest.fn(),
    activeColor: "#000000",
    setActiveColor: jest.fn(),
    activeStrokeWidth: 4,
    setActiveStrokeWidth: jest.fn(),

    activeShapeKind: "rect",
    setActiveShapeKind: jest.fn(),
    shapeFillEnabled: false,
    toggleShapeFill: jest.fn(),
    shapeDashed: false,
    toggleShapeDashed: jest.fn(),
    shapeArrowheadEnd: "none",
    cycleArrowhead: jest.fn(),
    snapGrid: 0,
    cycleSnap: jest.fn(),

    shapeDraft: null,
    guides: [],
    beginShapeDraft: jest.fn(),
    moveShapeDraft: jest.fn(),
    endShapeDraft: jest.fn(() => null),

    shapeRecMode: "never",
    cycleShapeRecMode: jest.fn(),
    perfectCandidate: null,
    setPerfectCandidate: jest.fn(),
    dismissPerfect: jest.fn(),

    spacePanActive: false,
    cheatSheetVisible: false,
    hideCheatSheet: jest.fn(),
    toggleCheatSheet: jest.fn(),

    ...overrides,
  };
}

function makeCollab(overrides: Partial<BoardCollab> = {}): BoardCollab {
  return {
    presence: [],
    followingId: null,
    publishPointer: jest.fn(),
    exitFollow: jest.fn(),
    toggleFollowUser: jest.fn(),
    isPresenting: false,
    isPresenterPaused: false,
    activePresenter: null,
    presenterLocksContentCreation: false,
    startPresenting: jest.fn(),
    stopPresenting: jest.fn(),
    pausePresenting: jest.fn(),
    resumePresenting: jest.fn(),
    ...overrides,
  };
}

function makeAi(overrides: Partial<BoardAI> = {}): BoardAI {
  return {
    ocrEnabled: false,
    explainEnabled: false,
    diagramEnabled: false,

    ocrBusy: false,
    ocrCandidate: null,
    recognizeText: jest.fn().mockResolvedValue(undefined),
    acceptOcr: jest.fn().mockResolvedValue(undefined),
    dismissOcr: jest.fn(),

    explainBusy: false,
    explain: jest.fn().mockResolvedValue(undefined),

    diagramOpen: false,
    openDiagram: jest.fn(),
    closeDiagram: jest.fn(),
    diagramPrompt: "",
    setDiagramPrompt: jest.fn(),
    diagramBusy: false,
    generateDiagram: jest.fn().mockResolvedValue(undefined),

    ...overrides,
  };
}

function makeComments(overrides: Partial<BoardComments> = {}): BoardComments {
  return {
    comments: [],
    activeCommentId: null,
    activeComment: null,
    pendingAnchor: null,
    busy: false,
    panelVisible: false,

    pinsFrom: jest.fn(() => []),
    openThread: jest.fn(),
    closePanel: jest.fn(),
    beginAnchor: jest.fn(),

    create: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue(undefined),
    toggleResolve: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),

    clearBoardComments: jest.fn().mockResolvedValue(undefined),
    resetLocal: jest.fn(),

    ...overrides,
  };
}

interface RenderOpts {
  elements?: Partial<BoardElements>;
  tools?: Partial<BoardTools> & { activeTool: Tool };
  collab?: Partial<BoardCollab>;
  ai?: Partial<BoardAI>;
  comments?: Partial<BoardComments>;
}

function renderCanvas(opts: RenderOpts) {
  const elements = makeElements(opts.elements);
  const tools = makeTools(opts.tools ?? { activeTool: "select" });
  const collab = makeCollab(opts.collab);
  const ai = makeAi(opts.ai);
  const comments = makeComments(opts.comments);

  render(
    <BoardCanvas
      boardId="board1"
      currentUserId="self"
      isAdmin={false}
      backgroundTemplate="blank"
      blockedIds={[]}
      enablePanZoom={true}
      viewport={{ x: 0, y: 0, scale: 1 }}
      canvasSize={{ width: 800, height: 600 }}
      onLayoutSize={jest.fn()}
      canvasRef={{ current: null }}
      elements={elements}
      tools={tools}
      collab={collab}
      ai={ai}
      comments={comments}
      commentPins={[]}
      editingTextId={null}
      onEditText={jest.fn()}
      isShiftHeld={() => false}
      onDeleteSelected={jest.fn()}
      onPanBy={jest.fn()}
      onZoomAtPoint={jest.fn()}
      onFling={jest.fn()}
      onGestureStart={jest.fn()}
      onZoomIn={jest.fn()}
      onZoomOut={jest.fn()}
      onResetViewport={jest.fn()}
      onFitToContent={jest.fn()}
      onError={jest.fn()}
    />
  );

  return { elements, tools, collab, ai, comments };
}

const POINT = { x: 5, y: 5 };

beforeEach(() => {
  mockDrawingCanvasProps = null;
  mockOverlayProps = null;
  mockAiSelectionProps = null;
  mockPerfectShapePromptProps = null;
});

describe("BoardCanvas — presenter lock on drawing gestures (Task 14 fix round)", () => {
  it("an unpaused presenter blocks the eraser's live deletion (eraseAtPoint)", () => {
    const { elements } = renderCanvas({
      tools: { activeTool: "eraser" },
      collab: { presenterLocksContentCreation: true },
    });

    act(() => {
      mockDrawingCanvasProps.onStrokeStart();
      mockDrawingCanvasProps.onStrokeMove(POINT);
    });

    expect(elements.eraseAtPoint).not.toHaveBeenCalled();
  });

  it("with no presenter, the eraser's live deletion goes through", () => {
    const { elements, tools } = renderCanvas({
      tools: { activeTool: "eraser" },
      collab: { presenterLocksContentCreation: false },
    });

    act(() => {
      mockDrawingCanvasProps.onStrokeStart();
      mockDrawingCanvasProps.onStrokeMove(POINT);
    });

    expect(elements.eraseAtPoint).toHaveBeenCalledWith(POINT, tools.activeStrokeWidth);
  });

  it("a paused presenter (lock released) also lets the eraser's deletion through", () => {
    const { elements, tools } = renderCanvas({
      tools: { activeTool: "eraser" },
      collab: {
        presenterLocksContentCreation: false,
        activePresenter: { userId: "p", displayName: "Presenter", paused: true },
      },
    });

    act(() => {
      mockDrawingCanvasProps.onStrokeStart();
      mockDrawingCanvasProps.onStrokeMove(POINT);
    });

    expect(elements.eraseAtPoint).toHaveBeenCalledWith(POINT, tools.activeStrokeWidth);
  });

  // Each gesture callback is fired in its own `act()` (rather than all three in
  // one) so React actually flushes `setCurrentPoints` and re-renders the mocked
  // `DrawingCanvas` between calls — `handleStrokeEnd`'s closure reads
  // `currentPoints` from whatever render is current when it runs, so batching
  // all three into a single act() would have it see the pre-move `null` and
  // never reach `commitStroke` regardless of the lock.

  it("an unpaused presenter blocks a pen stroke from being committed", async () => {
    const { elements } = renderCanvas({
      tools: { activeTool: "pen" },
      collab: { presenterLocksContentCreation: true },
    });

    act(() => {
      mockDrawingCanvasProps.onStrokeStart();
    });
    act(() => {
      mockDrawingCanvasProps.onStrokeMove(POINT);
    });
    await act(async () => {
      await mockDrawingCanvasProps.onStrokeEnd();
    });

    expect(elements.commitStroke).not.toHaveBeenCalled();
  });

  it("with no presenter, a pen stroke is committed", async () => {
    const { elements } = renderCanvas({
      tools: { activeTool: "pen" },
      collab: { presenterLocksContentCreation: false },
    });

    act(() => {
      mockDrawingCanvasProps.onStrokeStart();
    });
    act(() => {
      mockDrawingCanvasProps.onStrokeMove(POINT);
    });
    await act(async () => {
      await mockDrawingCanvasProps.onStrokeEnd();
    });

    expect(elements.commitStroke).toHaveBeenCalledWith([POINT], "#000000", 4);
  });

  it("a paused presenter also lets a pen stroke be committed", async () => {
    const { elements } = renderCanvas({
      tools: { activeTool: "pen" },
      collab: {
        presenterLocksContentCreation: false,
        activePresenter: { userId: "p", displayName: "Presenter", paused: true },
      },
    });

    act(() => {
      mockDrawingCanvasProps.onStrokeStart();
    });
    act(() => {
      mockDrawingCanvasProps.onStrokeMove(POINT);
    });
    await act(async () => {
      await mockDrawingCanvasProps.onStrokeEnd();
    });

    expect(elements.commitStroke).toHaveBeenCalledWith([POINT], "#000000", 4);
  });

  it("an unpaused presenter blocks the text tool's tap-to-create", () => {
    const { elements } = renderCanvas({
      tools: { activeTool: "text" },
      collab: { presenterLocksContentCreation: true },
    });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    expect(elements.createTextElement).not.toHaveBeenCalled();
  });

  it("with no presenter, the text tool's tap-to-create goes through", () => {
    const { elements } = renderCanvas({
      tools: { activeTool: "text" },
      collab: { presenterLocksContentCreation: false },
    });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    expect(elements.createTextElement).toHaveBeenCalledWith(POINT, "#000000");
  });

  it("a paused presenter also lets the text tool's tap-to-create through", () => {
    const { elements } = renderCanvas({
      tools: { activeTool: "text" },
      collab: {
        presenterLocksContentCreation: false,
        activePresenter: { userId: "p", displayName: "Presenter", paused: true },
      },
    });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    expect(elements.createTextElement).toHaveBeenCalledWith(POINT, "#000000");
  });
});

describe("BoardCanvas — the three content-creation call sites (Task 14 fix round)", () => {
  it("locked: onDuplicateSelected, onAcceptOcr and PerfectShapePrompt's onAccept are all suppressed (undefined)", () => {
    renderCanvas({
      tools: { activeTool: "select", perfectCandidate: { pathId: "p1", shape: { kind: "rect" } as any, color: "#000", strokeWidth: 2 } },
      collab: { presenterLocksContentCreation: true },
      ai: { ocrEnabled: true, ocrCandidate: { text: "hi", position: { x: 0, y: 0 }, confidence: 0.3 } },
    });

    expect(mockOverlayProps.onDuplicateSelected).toBeUndefined();
    expect(mockAiSelectionProps.onAcceptOcr).toBeUndefined();
    expect(mockPerfectShapePromptProps.onAccept).toBeUndefined();
  });

  it("unlocked (no presenter): all three are wired to the real handlers", async () => {
    const { elements, ai, tools } = renderCanvas({
      tools: {
        activeTool: "select",
        perfectCandidate: { pathId: "p1", shape: { kind: "rect" } as any, color: "#000", strokeWidth: 2 },
      },
      collab: { presenterLocksContentCreation: false },
      ai: { ocrEnabled: true, ocrCandidate: { text: "hi", position: { x: 0, y: 0 }, confidence: 0.3 } },
    });

    expect(mockOverlayProps.onDuplicateSelected).toBe(elements.duplicateSelected);

    expect(mockAiSelectionProps.onAcceptOcr).toBe(ai.acceptOcr);

    // `acceptPerfect` is a local BoardCanvas closure, not `elements.replaceStrokeWithShape`
    // itself — call it and confirm it forwards to the real write path and clears
    // the candidate, rather than asserting identity against a closure it can't be.
    expect(typeof mockPerfectShapePromptProps.onAccept).toBe("function");
    await act(async () => {
      await mockPerfectShapePromptProps.onAccept();
    });
    expect(tools.setPerfectCandidate).toHaveBeenCalledWith(null);
    expect(elements.replaceStrokeWithShape).toHaveBeenCalledWith(
      "p1",
      { kind: "rect" },
      "#000",
      2
    );
  });

  it("unlocked (paused presenter): all three stay wired to the real handlers", () => {
    const { elements, ai } = renderCanvas({
      tools: { activeTool: "select" },
      collab: {
        presenterLocksContentCreation: false,
        activePresenter: { userId: "p", displayName: "Presenter", paused: true },
      },
      ai: { ocrEnabled: true, ocrCandidate: { text: "hi", position: { x: 0, y: 0 }, confidence: 0.3 } },
    });

    expect(mockOverlayProps.onDuplicateSelected).toBe(elements.duplicateSelected);
    expect(mockAiSelectionProps.onAcceptOcr).toBe(ai.acceptOcr);
  });
});

describe("BoardCanvas — presenter banner vs. follow banner (Task 14 fix round)", () => {
  it("shows the presenter banner for the audience and suppresses the follow banner", () => {
    renderCanvas({
      collab: {
        followingId: "b",
        activePresenter: { userId: "p", displayName: "Alex", paused: false },
      },
    });

    expect(screen.getByText("Alex is presenting")).toBeTruthy();
    expect(screen.queryByText(/^Following/)).toBeNull();
  });

  it("shows the follow banner when nobody is presenting", () => {
    renderCanvas({
      collab: {
        followingId: "b",
        activePresenter: null,
        presence: [{ userId: "b", displayName: "Bob", email: "b@example.com", lastSeen: new Date() }],
      },
    });

    expect(screen.queryByText(/is presenting/)).toBeNull();
    expect(screen.getByText(/Following Bob/)).toBeTruthy();
  });

  it("keeps the (paused) presenter banner up and the follow banner suppressed through a pause", () => {
    renderCanvas({
      collab: {
        followingId: "b",
        activePresenter: { userId: "p", displayName: "Alex", paused: true },
      },
    });

    expect(screen.getByText("Alex paused presenting")).toBeTruthy();
    expect(screen.queryByText(/^Following/)).toBeNull();
  });
});
