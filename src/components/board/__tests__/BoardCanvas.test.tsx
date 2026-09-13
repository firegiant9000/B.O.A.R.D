jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

// The cursor side channel is CursorLayer's own subscription (not a BoardCanvas
// prop) — stub it so mounting BoardCanvas never reaches real Firestore.
jest.mock("../../../services/cursorService", () => ({
  subscribeToCursors: jest.fn(() => jest.fn()),
  visibleCursors: jest.fn(() => []),
  trailEligibleCursors: jest.fn(() => []),
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
import type { BoardReactions } from "../../../hooks/useBoardReactions";
import type { BoardPolls } from "../../../hooks/useBoardPolls";
import type { Plan } from "../../../types";

/**
 * BoardCanvas.test.tsx — the Month 5 presenter content-creation lock.
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
    audioNotes: [],
    visible: { paths: [], shapes: [], texts: [], notes: [], images: [], audioNotes: [] },
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
    colorOfElement: jest.fn(() => null),
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
    applyOpacity: jest.fn(),

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
    scanDocument: jest.fn().mockResolvedValue(undefined),

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

    activeAlpha: 1,
    setActiveAlpha: jest.fn(),
    activePenStyle: "pen",
    setActivePenStyle: jest.fn(),
    chooseColor: jest.fn(),
    recentColors: [],
    eyedropperArmed: false,
    armEyedropper: jest.fn(),
    disarmEyedropper: jest.fn(),
    toggleEyedropper: jest.fn(),

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

    flashcardsEnabled: false,
    flashcardsBusy: false,
    makeFlashcards: jest.fn().mockResolvedValue(undefined),

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

function makeReactions(overrides: Partial<BoardReactions> = {}): BoardReactions {
  return {
    reactions: [],
    elementIdsWithReactions: [],
    countsFor: jest.fn(() => []),
    anchorKindOf: jest.fn(() => undefined),
    toggle: jest.fn().mockResolvedValue(undefined),
    clearBoardReactions: jest.fn().mockResolvedValue(undefined),
    resetLocal: jest.fn(),

    ...overrides,
  };
}

function makePolls(overrides: Partial<BoardPolls> = {}): BoardPolls {
  return {
    polls: [],
    resultsFor: jest.fn(() => null),
    myVoteFor: jest.fn(() => []),
    create: jest.fn().mockResolvedValue("newPollId"),
    vote: jest.fn().mockResolvedValue(undefined),
    toggleDot: jest.fn().mockResolvedValue(undefined),
    deletePoll: jest.fn().mockResolvedValue(undefined),
    advanceQuiz: jest.fn().mockResolvedValue(undefined),
    clearBoardPolls: jest.fn().mockResolvedValue(undefined),
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
  reactions?: Partial<BoardReactions>;
  polls?: Partial<BoardPolls>;
  plan?: Plan;
  canEdit?: boolean;
  canComment?: boolean;
}

function renderCanvas(opts: RenderOpts) {
  const elements = makeElements(opts.elements);
  const tools = makeTools(opts.tools ?? { activeTool: "select" });
  const collab = makeCollab(opts.collab);
  const ai = makeAi(opts.ai);
  const comments = makeComments(opts.comments);
  const reactions = makeReactions(opts.reactions);
  const polls = makePolls(opts.polls);

  const withCollab = (c: BoardCollab) => (
    <BoardCanvas
      boardId="board1"
      currentUserId="self"
      isAdmin={false}
      backgroundTemplate="blank"
      blockedIds={[]}
      plan={opts.plan ?? "free"}
      canEdit={opts.canEdit ?? true}
      canComment={opts.canComment ?? true}
      enablePanZoom={true}
      viewport={{ x: 0, y: 0, scale: 1 }}
      canvasSize={{ width: 800, height: 600 }}
      onLayoutSize={jest.fn()}
      canvasRef={{ current: null }}
      elements={elements}
      tools={tools}
      collab={c}
      ai={ai}
      comments={comments}
      commentPins={[]}
      reactions={reactions}
      polls={polls}
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

  const view = render(withCollab(collab));

  return {
    elements,
    tools,
    collab,
    ai,
    comments,
    reactions,
    polls,
    /** Re-render with the same elements/tools/ai/comments doubles but a new
     *  `collab` — used to simulate a presentation starting/pausing mid-gesture. */
    rerenderWithCollab: (overrides: Partial<BoardCollab>) => {
      view.rerender(withCollab(makeCollab(overrides)));
    },
  };
}

const POINT = { x: 5, y: 5 };

beforeEach(() => {
  mockDrawingCanvasProps = null;
  mockOverlayProps = null;
  mockAiSelectionProps = null;
  mockPerfectShapePromptProps = null;
});

describe("BoardCanvas — presenter lock on drawing gestures", () => {
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

  it("closes an in-flight erase batch when the lock engages mid-gesture, without leaking it", () => {
    const { elements, rerenderWithCollab } = renderCanvas({
      tools: { activeTool: "eraser" },
      collab: { presenterLocksContentCreation: false },
    });

    // Unlocked: the gesture starts normally — opens the erase batch and takes
    // one real deletion.
    act(() => {
      mockDrawingCanvasProps.onStrokeStart();
    });
    act(() => {
      mockDrawingCanvasProps.onStrokeMove(POINT);
    });
    expect(elements.beginEraseStroke).toHaveBeenCalledTimes(1);
    expect(elements.eraseAtPoint).toHaveBeenCalledTimes(1);

    // A presentation starts mid-gesture: re-render with the lock now engaged
    // (mirrors `activePresenter` flipping via the cursor subscription while
    // this same stroke is still in progress).
    act(() => {
      rerenderWithCollab({ presenterLocksContentCreation: true });
    });

    // Further move frames are blocked (already covered above) — the point of
    // this test is stroke end: the batch `beginEraseStroke()` opened before
    // the lock engaged must still be closed, or `erasedIdsRef`
    // (`useBoardElements`) stays populated until the next eraser stroke's own
    // `beginEraseStroke()` — the leaked-erase-batch fix this pins.
    act(() => {
      mockDrawingCanvasProps.onStrokeEnd();
    });

    expect(elements.endEraseStroke).toHaveBeenCalledTimes(1);
    // No additional deletion snuck through once the lock engaged.
    expect(elements.eraseAtPoint).toHaveBeenCalledTimes(1);
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

    expect(elements.commitStroke).toHaveBeenCalledWith([POINT], "#000000", 4, { penStyle: "pen", opacity: 1 });
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

    expect(elements.commitStroke).toHaveBeenCalledWith([POINT], "#000000", 4, { penStyle: "pen", opacity: 1 });
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

describe("BoardCanvas — laser pointer never creates persisted content (Month 5)", () => {
  it("a stationary tap with the laser tool draws no dot", () => {
    const { elements } = renderCanvas({ tools: { activeTool: "laser" } });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    expect(elements.drawDot).not.toHaveBeenCalled();
  });

  it("a stationary tap with the laser tool publishes exactly one pressed pointer ping", () => {
    const { collab } = renderCanvas({ tools: { activeTool: "laser" } });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    // Call count matters here, not just the args: a double-publish on a
    // single tap would still match `toHaveBeenCalledWith` alone.
    expect(collab.publishPointer).toHaveBeenCalledTimes(1);
    expect(collab.publishPointer).toHaveBeenCalledWith(POINT, true);
  });

  it("keeps working while an unpaused presenter locks out content creation — the laser isn't content", () => {
    const { elements, collab } = renderCanvas({
      tools: { activeTool: "laser" },
      collab: { presenterLocksContentCreation: true },
    });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    expect(elements.drawDot).not.toHaveBeenCalled();
    expect(collab.publishPointer).toHaveBeenCalledWith(POINT, true);
  });

  // Fix round 1: this used to invoke only onStrokeStart/onStrokeMove and
  // assert on the eraser's call sites — it never reached onStrokeEnd, the
  // actual persistence call (`elements.commitStroke`, BoardCanvas.tsx:265),
  // so it gave `isDrawingTool` excluding "laser" zero protection: widening
  // that union to include laser would have started persisting real paths on
  // a laser drag with this suite still green.
  it("a laser stroke gesture (drag through end) never commits, erases, or begins an erase batch", async () => {
    const { elements } = renderCanvas({ tools: { activeTool: "laser" } });

    act(() => {
      mockDrawingCanvasProps.onStrokeStart();
    });
    act(() => {
      mockDrawingCanvasProps.onStrokeMove(POINT);
    });
    await act(async () => {
      await mockDrawingCanvasProps.onStrokeEnd();
    });

    expect(elements.eraseAtPoint).not.toHaveBeenCalled();
    expect(elements.beginEraseStroke).not.toHaveBeenCalled();
    expect(elements.commitStroke).not.toHaveBeenCalled();
  });
});

describe("BoardCanvas — eyedropper (Month 5, ROADMAP item 12)", () => {
  it("samples the topmost hit element's colour via the shared hitTestAny/colorOfElement path and disarms", () => {
    const { elements, tools } = renderCanvas({
      tools: { activeTool: "pen", eyedropperArmed: true },
      elements: {
        hitTestAny: jest.fn(() => ({ id: "shape-1", kind: "shape" })),
        colorOfElement: jest.fn(() => "#ff00aa"),
      },
    });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    expect(elements.hitTestAny).toHaveBeenCalledWith(POINT);
    expect(elements.colorOfElement).toHaveBeenCalledWith("shape-1", "shape");
    expect(tools.chooseColor).toHaveBeenCalledWith("#ff00aa");
    expect(tools.disarmEyedropper).toHaveBeenCalledTimes(1);
  });

  it("a miss (empty canvas) disarms without changing the active colour", () => {
    const { elements, tools } = renderCanvas({
      tools: { activeTool: "pen", eyedropperArmed: true },
      elements: { hitTestAny: jest.fn(() => null) },
    });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    expect(elements.colorOfElement).not.toHaveBeenCalled();
    expect(tools.chooseColor).not.toHaveBeenCalled();
    expect(tools.disarmEyedropper).toHaveBeenCalledTimes(1);
  });

  it("hitting an image (no sampleable colour) disarms without changing the active colour", () => {
    const { tools } = renderCanvas({
      tools: { activeTool: "pen", eyedropperArmed: true },
      elements: {
        hitTestAny: jest.fn(() => ({ id: "img-1", kind: "image" })),
        colorOfElement: jest.fn(() => null),
      },
    });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    expect(tools.chooseColor).not.toHaveBeenCalled();
    expect(tools.disarmEyedropper).toHaveBeenCalledTimes(1);
  });

  it("armed picking pre-empts the active tool's own tap behavior (pen would otherwise drop a dot)", () => {
    const { elements } = renderCanvas({
      tools: { activeTool: "pen", eyedropperArmed: true },
      elements: { hitTestAny: jest.fn(() => null) },
    });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    expect(elements.drawDot).not.toHaveBeenCalled();
  });

  it("a drag while armed draws nothing (start/move/end all no-op)", async () => {
    const { elements } = renderCanvas({ tools: { activeTool: "pen", eyedropperArmed: true } });

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

  it("not armed: a plain pen tap still drops a dot as usual", () => {
    const { elements } = renderCanvas({ tools: { activeTool: "pen", eyedropperArmed: false } });

    act(() => {
      mockDrawingCanvasProps.onTap(POINT);
    });

    expect(elements.drawDot).toHaveBeenCalledWith(POINT, "#000000", 4, { penStyle: "pen", opacity: 1 });
  });
});

describe("BoardCanvas — gated content-creation call sites", () => {
  // Covers all six props this component itself gates: `onDuplicateSelected`
  // (BoardOverlayLayer), `onAcceptOcr`, `onRecognizeText`, `onExplain` and
  // `onMakeFlashcards` (AiSelectionActions), and PerfectShapePrompt's
  // `onAccept`. The remaining two content-creation paths the fix round
  // closed — `BoardHeader`'s diagram-open button and the duplicate/paste
  // keyboard shortcuts — live outside this component and are covered where
  // they're wired (`app/board/[id].tsx`), not here.
  it("locked: all six are suppressed (undefined)", () => {
    renderCanvas({
      tools: { activeTool: "select", perfectCandidate: { pathId: "p1", shape: { kind: "rect" } as any, color: "#000", strokeWidth: 2 } },
      collab: { presenterLocksContentCreation: true },
      ai: {
        ocrEnabled: true,
        explainEnabled: true,
        flashcardsEnabled: true,
        ocrCandidate: { text: "hi", position: { x: 0, y: 0 }, confidence: 0.3 },
      },
    });

    expect(mockOverlayProps.onDuplicateSelected).toBeUndefined();
    expect(mockAiSelectionProps.onAcceptOcr).toBeUndefined();
    expect(mockAiSelectionProps.onRecognizeText).toBeUndefined();
    expect(mockAiSelectionProps.onExplain).toBeUndefined();
    expect(mockAiSelectionProps.onMakeFlashcards).toBeUndefined();
    expect(mockPerfectShapePromptProps.onAccept).toBeUndefined();
  });

  it("unlocked (no presenter): all six are wired to the real handlers", async () => {
    const { elements, ai, tools } = renderCanvas({
      tools: {
        activeTool: "select",
        perfectCandidate: { pathId: "p1", shape: { kind: "rect" } as any, color: "#000", strokeWidth: 2 },
      },
      collab: { presenterLocksContentCreation: false },
      ai: {
        ocrEnabled: true,
        explainEnabled: true,
        flashcardsEnabled: true,
        ocrCandidate: { text: "hi", position: { x: 0, y: 0 }, confidence: 0.3 },
      },
    });

    expect(mockOverlayProps.onDuplicateSelected).toBe(elements.duplicateSelected);
    expect(mockAiSelectionProps.onAcceptOcr).toBe(ai.acceptOcr);
    expect(mockAiSelectionProps.onRecognizeText).toBe(ai.recognizeText);
    expect(mockAiSelectionProps.onExplain).toBe(ai.explain);
    expect(mockAiSelectionProps.onMakeFlashcards).toBe(ai.makeFlashcards);

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

  it("unlocked (paused presenter): all six stay wired to the real handlers", () => {
    const { elements, ai } = renderCanvas({
      tools: { activeTool: "select" },
      collab: {
        presenterLocksContentCreation: false,
        activePresenter: { userId: "p", displayName: "Presenter", paused: true },
      },
      ai: {
        ocrEnabled: true,
        explainEnabled: true,
        flashcardsEnabled: true,
        ocrCandidate: { text: "hi", position: { x: 0, y: 0 }, confidence: 0.3 },
      },
    });

    expect(mockOverlayProps.onDuplicateSelected).toBe(elements.duplicateSelected);
    expect(mockAiSelectionProps.onAcceptOcr).toBe(ai.acceptOcr);
    expect(mockAiSelectionProps.onRecognizeText).toBe(ai.recognizeText);
    expect(mockAiSelectionProps.onExplain).toBe(ai.explain);
    expect(mockAiSelectionProps.onMakeFlashcards).toBe(ai.makeFlashcards);
  });
});

describe("BoardCanvas — presenter banner vs. follow banner", () => {
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

// Month 5 — voice notes (ROADMAP.md:583-587). BoardOverlayLayer is mocked
// out (see the top of this file), so these assert what BoardCanvas computes
// and hands it, not the deep render — same recipe as every describe block
// above.
function selectionOf(id: string | null, count: number) {
  return {
    selectedIds: id ? new Set([id]) : new Set<string>(),
    selectedId: id,
    count,
    anchor: "elements" as const,
    isSelected: jest.fn(() => false),
    select: jest.fn(),
    setMany: jest.fn(),
    addMany: jest.fn(),
    toggle: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn(),
  };
}

const OVERLAY_BOUNDS = { minX: 10, minY: 20, maxX: 50, maxY: 60 };

describe("BoardCanvas — voice notes: plan and existing notes pass through", () => {
  const audioNotes = [
    {
      id: "a1",
      schemaVersion: 1 as const,
      boardId: "board1",
      userId: "self",
      anchorElementId: "el1",
      storagePath: "boards/board1/audio/a1/note.m4a",
      downloadUrl: "https://dl/a1",
      durationMs: 3000,
      // Deliberately far from ANCHOR_BOX below — item 7 (fix round 1) means
      // these persisted values must NOT be what ends up on screen.
      x: 999,
      y: 999,
      createdAt: new Date(),
    },
  ];
  const ANCHOR_BOX = { minX: 10, minY: 20, maxX: 50, maxY: 60 };

  it("passes the plan and boardId straight through", () => {
    renderCanvas({
      plan: "pro",
      elements: { visible: { paths: [], shapes: [], texts: [], notes: [], images: [], audioNotes } as any },
    });
    expect(mockOverlayProps.plan).toBe("pro");
    expect(mockOverlayProps.boardId).toBe("board1");
  });

  it("resolves each note's render position from its anchor's LIVE bounds via boxOfElement, not from the note's own persisted x/y", () => {
    renderCanvas({
      plan: "pro",
      elements: {
        visible: { paths: [], shapes: [], texts: [], notes: [], images: [], audioNotes } as any,
        boxOfElement: jest.fn((id: string) => (id === "el1" ? ANCHOR_BOX : null)),
      },
    });
    expect(mockOverlayProps.audioNotes).toEqual([
      { note: audioNotes[0], x: ANCHOR_BOX.maxX + 8, y: ANCHOR_BOX.minY },
    ]);
  });

  it("omits a note whose anchor can't be found (boxOfElement returns null) instead of rendering it at a stale position", () => {
    renderCanvas({
      plan: "pro",
      elements: {
        visible: { paths: [], shapes: [], texts: [], notes: [], images: [], audioNotes } as any,
        boxOfElement: jest.fn(() => null),
      },
    });
    expect(mockOverlayProps.audioNotes).toEqual([]);
  });
});

describe("BoardCanvas — voice notes: the record-entry-point (newVoiceNoteAnchor)", () => {
  it("appears next to a lone selection with no voice note, at the box's top-right + margin", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      elements: {
        selection: selectionOf("el1", 1) as any,
        overlayBounds: OVERLAY_BOUNDS,
        visible: { paths: [], shapes: [], texts: [], notes: [], images: [], audioNotes: [] } as any,
      },
    });
    expect(mockOverlayProps.newVoiceNoteAnchor).toEqual({ elementId: "el1", x: 58, y: 20 });
  });

  it("is null when the selected element already has a voice note", () => {
    const audioNotes = [
      {
        id: "a1",
        schemaVersion: 1 as const,
        boardId: "board1",
        userId: "self",
        anchorElementId: "el1",
        storagePath: "boards/board1/audio/a1/note.m4a",
        downloadUrl: "https://dl/a1",
        durationMs: 3000,
        x: 5,
        y: 5,
        createdAt: new Date(),
      },
    ];
    renderCanvas({
      tools: { activeTool: "select" },
      elements: {
        selection: selectionOf("el1", 1) as any,
        overlayBounds: OVERLAY_BOUNDS,
        visible: { paths: [], shapes: [], texts: [], notes: [], images: [], audioNotes } as any,
      },
    });
    expect(mockOverlayProps.newVoiceNoteAnchor).toBeNull();
  });

  it("is null when nothing is selected", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      elements: { selection: selectionOf(null, 0) as any, overlayBounds: null },
    });
    expect(mockOverlayProps.newVoiceNoteAnchor).toBeNull();
  });

  it("is null when more than one element is selected", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      elements: { selection: selectionOf(null, 2) as any, overlayBounds: OVERLAY_BOUNDS },
    });
    expect(mockOverlayProps.newVoiceNoteAnchor).toBeNull();
  });

  it("is null when the select tool isn't active", () => {
    renderCanvas({
      tools: { activeTool: "pen" },
      elements: { selection: selectionOf("el1", 1) as any, overlayBounds: OVERLAY_BOUNDS },
    });
    expect(mockOverlayProps.newVoiceNoteAnchor).toBeNull();
  });

  it("is null mid-transform (dragOffset set), matching showSelectionActions' own guard", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      elements: {
        selection: selectionOf("el1", 1) as any,
        overlayBounds: OVERLAY_BOUNDS,
        dragOffset: { dx: 3, dy: 3 },
      },
    });
    expect(mockOverlayProps.newVoiceNoteAnchor).toBeNull();
  });

  it("is suppressed while a presentation locks content creation, like onDuplicateSelected", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      collab: { presenterLocksContentCreation: true },
      elements: { selection: selectionOf("el1", 1) as any, overlayBounds: OVERLAY_BOUNDS },
    });
    expect(mockOverlayProps.newVoiceNoteAnchor).toBeNull();
  });

  // Fix round 1, item 3 — a viewer/commenter must never see the mic: the
  // upload would succeed (storage.rules allows any board member) before
  // firestore.rules' editor-only `audio` write denies the doc.
  it("is null when the viewer cannot edit the board (canEdit: false)", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      canEdit: false,
      elements: { selection: selectionOf("el1", 1) as any, overlayBounds: OVERLAY_BOUNDS },
    });
    expect(mockOverlayProps.newVoiceNoteAnchor).toBeNull();
  });
});

// Month 6 — reactions. BoardOverlayLayer is mocked out (see the top of this
// file), so these assert what BoardCanvas computes and hands it — same
// recipe as the voice-note describes above, whose ANCHOR_BOX/OVERLAY_BOUNDS
// shape this section reuses (`OVERLAY_BOUNDS` is the module-scoped one
// defined above the voice-note describes).
describe("BoardCanvas — reactions: existing badges (any member, not gated by selection)", () => {
  it("resolves a badge's position from its anchor's LIVE bounds via boxOfElement, at the bottom-left corner + margin", () => {
    const counts = [{ emoji: "👍" as const, count: 2, reactedByMe: false }];
    const { elements } = renderCanvas({
      elements: {
        boxOfElement: jest.fn((id: string) => (id === "el1" ? OVERLAY_BOUNDS : null)),
      },
      reactions: {
        elementIdsWithReactions: ["el1"],
        countsFor: jest.fn(() => counts),
        anchorKindOf: jest.fn(() => "shape"),
      },
    });
    expect(mockOverlayProps.reactionBadges).toEqual([
      { elementId: "el1", x: OVERLAY_BOUNDS.minX, y: OVERLAY_BOUNDS.maxY + 4, counts },
    ]);
    // The stored anchor kind ("shape", from `anchorKindOf`) is passed to
    // boxOfElement as the resolution hint (never a guess — see Reaction's
    // type comment) — asserted directly, not inferred from the result above.
    expect(elements.boxOfElement).toHaveBeenCalledWith("el1", "shape");
  });

  it("omits a badge whose anchor can't be found (boxOfElement returns null) instead of a stale position", () => {
    renderCanvas({
      elements: { boxOfElement: jest.fn(() => null) },
      reactions: { elementIdsWithReactions: ["el1"] },
    });
    expect(mockOverlayProps.reactionBadges).toEqual([]);
  });

  it("shows an existing-reaction badge with no selection at all, unlike the voice-note record affordance", () => {
    renderCanvas({
      tools: { activeTool: "pen" },
      elements: {
        selection: selectionOf(null, 0) as any,
        boxOfElement: jest.fn(() => OVERLAY_BOUNDS),
      },
      reactions: { elementIdsWithReactions: ["el1"] },
    });
    expect(mockOverlayProps.reactionBadges.map((b: any) => b.elementId)).toEqual(["el1"]);
  });

  it("shows an existing-reaction badge even while a presentation locks content creation", () => {
    renderCanvas({
      collab: { presenterLocksContentCreation: true },
      elements: {
        selection: selectionOf(null, 0) as any,
        boxOfElement: jest.fn(() => OVERLAY_BOUNDS),
      },
      reactions: { elementIdsWithReactions: ["el1"] },
    });
    expect(mockOverlayProps.reactionBadges.map((b: any) => b.elementId)).toEqual(["el1"]);
  });

  it("renders one badge per element with reactions, no duplicates", () => {
    renderCanvas({
      elements: { boxOfElement: jest.fn(() => OVERLAY_BOUNDS) },
      reactions: { elementIdsWithReactions: ["el1", "el2"] },
    });
    expect(mockOverlayProps.reactionBadges.map((b: any) => b.elementId).sort()).toEqual(["el1", "el2"]);
  });
});

describe("BoardCanvas — reactions: the start-reacting entry-point (singleSelectedIdForReaction)", () => {
  it("appears next to a lone selection with no reaction yet, at the box's bottom-left + margin", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      elements: {
        selection: selectionOf("el1", 1) as any,
        boxOfElement: jest.fn(() => OVERLAY_BOUNDS),
      },
      reactions: { elementIdsWithReactions: [] },
    });
    expect(mockOverlayProps.reactionBadges).toEqual([
      { elementId: "el1", x: OVERLAY_BOUNDS.minX, y: OVERLAY_BOUNDS.maxY + 4, counts: [] },
    ]);
  });

  it("doesn't duplicate the badge when the selected element already has a reaction", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      elements: {
        selection: selectionOf("el1", 1) as any,
        boxOfElement: jest.fn(() => OVERLAY_BOUNDS),
      },
      reactions: { elementIdsWithReactions: ["el1"] },
    });
    expect(mockOverlayProps.reactionBadges).toHaveLength(1);
  });

  it("is absent when nothing is selected and nothing has a reaction", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      elements: { selection: selectionOf(null, 0) as any },
      reactions: { elementIdsWithReactions: [] },
    });
    expect(mockOverlayProps.reactionBadges).toEqual([]);
  });

  it("is absent when more than one element is selected", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      elements: { selection: selectionOf(null, 2) as any },
      reactions: { elementIdsWithReactions: [] },
    });
    expect(mockOverlayProps.reactionBadges).toEqual([]);
  });

  it("is absent when the select tool isn't active", () => {
    renderCanvas({
      tools: { activeTool: "pen" },
      elements: { selection: selectionOf("el1", 1) as any, boxOfElement: jest.fn(() => OVERLAY_BOUNDS) },
      reactions: { elementIdsWithReactions: [] },
    });
    expect(mockOverlayProps.reactionBadges).toEqual([]);
  });

  it("is absent mid-transform (dragOffset set)", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      elements: {
        selection: selectionOf("el1", 1) as any,
        boxOfElement: jest.fn(() => OVERLAY_BOUNDS),
        dragOffset: { dx: 3, dy: 3 },
      },
      reactions: { elementIdsWithReactions: [] },
    });
    expect(mockOverlayProps.reactionBadges).toEqual([]);
  });

  it("is absent while a presentation locks content creation", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      collab: { presenterLocksContentCreation: true },
      elements: { selection: selectionOf("el1", 1) as any, boxOfElement: jest.fn(() => OVERLAY_BOUNDS) },
      reactions: { elementIdsWithReactions: [] },
    });
    expect(mockOverlayProps.reactionBadges).toEqual([]);
  });

  it("is absent when the viewer cannot comment (canComment: false) — reacting needs comment-level access", () => {
    renderCanvas({
      tools: { activeTool: "select" },
      canComment: false,
      elements: { selection: selectionOf("el1", 1) as any, boxOfElement: jest.fn(() => OVERLAY_BOUNDS) },
      reactions: { elementIdsWithReactions: [] },
    });
    expect(mockOverlayProps.reactionBadges).toEqual([]);
  });
});

describe("BoardCanvas — reactions: canReact and onToggleReaction composition", () => {
  it("passes canComment straight through as canReact", () => {
    renderCanvas({ canComment: false });
    expect(mockOverlayProps.canReact).toBe(false);

    renderCanvas({ canComment: true });
    expect(mockOverlayProps.canReact).toBe(true);
  });

  it("composes onToggleReaction to call reactions.toggle with (elementId, emoji, the stored anchor kind)", () => {
    const { reactions } = renderCanvas({
      elements: { boxOfElement: jest.fn(() => OVERLAY_BOUNDS) },
      reactions: { elementIdsWithReactions: ["el1"], anchorKindOf: jest.fn(() => "text") },
    });

    mockOverlayProps.onToggleReaction("el1", "❤️");

    expect(reactions.toggle).toHaveBeenCalledWith("el1", "❤️", "text");
  });
});

// Month 6 — polls. UNLIKE reactions there is no geometry join to test here
// (a poll renders at its own persisted x/y); this component's own logic is
// choosing WHICH polls show — every standalone poll, plus each quiz's
// CURRENT question only — so that's what these tests pin.
function makePoll(overrides: Partial<import("../../../types").PollElement> = {}): import("../../../types").PollElement {
  return {
    id: "p1",
    schemaVersion: 1,
    boardId: "board1",
    question: "Q?",
    options: ["A", "B"],
    anonymous: false,
    mode: "single",
    x: 5,
    y: 6,
    createdById: "author",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("BoardCanvas — polls: which polls show this render", () => {
  it("shows every standalone (non-quiz) poll", () => {
    const standalone = makePoll({ id: "p1" });
    renderCanvas({ polls: { polls: [standalone] } });
    expect(mockOverlayProps.positionedPolls).toEqual([
      { poll: standalone, results: null, myVote: [], hasNextQuestion: false },
    ]);
  });

  it("shows only the CURRENT (active) question of a quiz, not the others", () => {
    const q0 = makePoll({ id: "q0", quizId: "quiz1", quizIndex: 0, active: true });
    const q1 = makePoll({ id: "q1", quizId: "quiz1", quizIndex: 1, active: false });
    renderCanvas({ polls: { polls: [q0, q1] } });
    const shownIds = mockOverlayProps.positionedPolls.map((p: any) => p.poll.id);
    expect(shownIds).toEqual(["q0"]);
  });

  it("shows nothing for a quiz with no active question yet", () => {
    const q0 = makePoll({ id: "q0", quizId: "quiz1", quizIndex: 0, active: false });
    renderCanvas({ polls: { polls: [q0] } });
    expect(mockOverlayProps.positionedPolls).toEqual([]);
  });

  it("resolves results and myVote per poll from the polls hook", () => {
    const p1 = makePoll({ id: "p1" });
    const results = { counts: [1, 2], totalVotes: 3, fromTally: false };
    renderCanvas({
      polls: {
        polls: [p1],
        resultsFor: jest.fn(() => results),
        myVoteFor: jest.fn(() => [1]),
      },
    });
    expect(mockOverlayProps.positionedPolls).toEqual([
      { poll: p1, results, myVote: [1], hasNextQuestion: false },
    ]);
  });

  // Fix round 1, item 8 — `hasNextQuestion` is what BoardOverlayLayer uses
  // to decide whether PollCard gets a live "Next question" callback at all;
  // it must be TRUE for a quiz's current question when a later one exists,
  // and FALSE once there is nothing left to advance to, even though
  // `quizId` is truthy in both cases.
  it("sets hasNextQuestion true for a quiz's current question when a later question exists", () => {
    const q0 = makePoll({ id: "q0", quizId: "quiz1", quizIndex: 0, active: true });
    const q1 = makePoll({ id: "q1", quizId: "quiz1", quizIndex: 1, active: false });
    renderCanvas({ polls: { polls: [q0, q1] } });
    expect(mockOverlayProps.positionedPolls[0].hasNextQuestion).toBe(true);
  });

  it("sets hasNextQuestion FALSE for a quiz's LAST question, even though quizId is still set", () => {
    const q0 = makePoll({ id: "q0", quizId: "quiz1", quizIndex: 0, active: false });
    const q1 = makePoll({ id: "q1", quizId: "quiz1", quizIndex: 1, active: true });
    renderCanvas({ polls: { polls: [q0, q1] } });
    expect(mockOverlayProps.positionedPolls[0].poll.id).toBe("q1");
    expect(mockOverlayProps.positionedPolls[0].hasNextQuestion).toBe(false);
  });
});

describe("BoardCanvas — polls: role composition (canManagePolls/canVotePolls)", () => {
  it("passes canEdit straight through as canManagePolls", () => {
    renderCanvas({ canEdit: false });
    expect(mockOverlayProps.canManagePolls).toBe(false);
    renderCanvas({ canEdit: true });
    expect(mockOverlayProps.canManagePolls).toBe(true);
  });

  it("passes canComment straight through as canVotePolls", () => {
    renderCanvas({ canComment: false });
    expect(mockOverlayProps.canVotePolls).toBe(false);
    renderCanvas({ canComment: true });
    expect(mockOverlayProps.canVotePolls).toBe(true);
  });
});

describe("BoardCanvas — polls: write-path composition", () => {
  it("composes onVotePoll/onToggleDotPoll/onDeletePoll/onAdvanceQuiz onto the polls hook", () => {
    const { polls } = renderCanvas({});

    mockOverlayProps.onVotePoll("p1", 2);
    expect(polls.vote).toHaveBeenCalledWith("p1", 2);

    mockOverlayProps.onToggleDotPoll("p1", 1);
    expect(polls.toggleDot).toHaveBeenCalledWith("p1", 1);

    mockOverlayProps.onDeletePoll("p1");
    expect(polls.deletePoll).toHaveBeenCalledWith("p1");

    mockOverlayProps.onAdvanceQuiz("quiz1");
    expect(polls.advanceQuiz).toHaveBeenCalledWith("quiz1");
  });
});
