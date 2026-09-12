// Every child dialog is mocked to a no-op stub, except DiagramPromptModal
// (captured) — this test is about what BoardModals decides to pass down, not
// about any of the eight other dialogs' own rendering.
jest.mock("../../JoinBoardModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../../ShareBoardModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../../BoardHistoryPanel", () => ({ __esModule: true, default: () => null }));
jest.mock("../../ShortcutsCheatSheet", () => ({ __esModule: true, default: () => null }));
jest.mock("../../BackgroundPicker", () => ({ __esModule: true, default: () => null }));
jest.mock("../../CommentThreadPanel", () => ({ __esModule: true, default: () => null }));
jest.mock("../../StartSessionModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../../UpsellModal", () => ({ __esModule: true, default: () => null }));
let mockColorPickerProps: any = null;
jest.mock("../../ColorPickerModal", () => ({
  __esModule: true,
  default: (props: any) => {
    mockColorPickerProps = props;
    return null;
  },
}));

let mockStrokeWidthProps: any = null;
jest.mock("../../StrokeWidthModal", () => ({
  __esModule: true,
  default: (props: any) => {
    mockStrokeWidthProps = props;
    return null;
  },
}));

let mockDiagramPromptProps: any = null;
jest.mock("../../DiagramPromptModal", () => ({
  __esModule: true,
  default: (props: any) => {
    mockDiagramPromptProps = props;
    return null;
  },
}));

let mockPollComposerProps: any = null;
jest.mock("../PollComposer", () => ({
  __esModule: true,
  default: (props: any) => {
    mockPollComposerProps = props;
    return null;
  },
}));

let mockBoardQaProps: any = null;
let mockBoardQaRenders = 0;
jest.mock("../../BoardQaPanel", () => ({
  __esModule: true,
  default: (props: any) => {
    mockBoardQaProps = props;
    mockBoardQaRenders += 1;
    return null;
  },
}));

import React from "react";
import { Animated } from "react-native";
import { render } from "@testing-library/react-native";
import BoardModals from "../BoardModals";
import type { BoardDocument } from "../../../hooks/useBoardDocument";
import type { BoardComments } from "../../../hooks/useBoardComments";
import type { BoardAI } from "../../../hooks/useBoardAI";

/**
 * BoardModals.test.tsx — the Month 5 diagram-generate presenter lock.
 *
 * The one content-creation surface this layer itself owns is
 * `DiagramPromptModal`'s "Draw" button: `generateDiagram` writes a whole
 * batch of elements and spends AI quota, and the prompt can already be open
 * when a presentation starts (it isn't tied to canvas gesture state, unlike
 * `PerfectShapePrompt`). `BoardHeader`'s diagram-open button (tested by
 * inspection only — see the fix-round report) stops a locked viewer from
 * opening the prompt in the first place; this pins the second half — an
 * already-open prompt can't submit either.
 */

function makeDoc(overrides: Partial<BoardDocument> = {}): BoardDocument {
  return {
    board: null,
    boardWorkspace: null,
    mentionMembers: [],
    loading: false,
    reload: jest.fn(),
    isAdmin: false,
    effectiveRole: undefined,
    canEdit: true,
    canComment: true,
    scheduleSave: jest.fn(),
    saveNow: jest.fn().mockResolvedValue(undefined),
    saveOpacity: new Animated.Value(0),
    showSaveToast: jest.fn(),
    addMember: jest.fn(),
    setAdmin: jest.fn(),
    setAccess: jest.fn(),
    setBackground: jest.fn(),
    activeSession: null,
    endingSession: false,
    refreshActiveSession: jest.fn().mockResolvedValue(undefined),
    endSession: jest.fn().mockResolvedValue(undefined),
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

function renderModals(opts: {
  presenterLocksContentCreation: boolean;
  ai?: Partial<BoardAI>;
  plan?: "free" | "pro" | "edu";
  canManageWorkspace?: boolean;
  workspaceSwatches?: string[];
  onAddSwatch?: jest.Mock;
  onRequestPaletteUpgrade?: jest.Mock;
  pollComposerVisible?: boolean;
  boardQaEnabled?: boolean;
  boardQaVisible?: boolean;
  isCitationLive?: jest.Mock;
  onSelectCitation?: jest.Mock;
  onBoardQaQuotaExceeded?: jest.Mock;
}) {
  const doc = makeDoc();
  const comments = makeComments();
  // The diagram prompt is already open — the exact scenario under test.
  const ai = makeAi({ diagramEnabled: true, diagramOpen: true, ...opts.ai });
  const onAddSwatch = opts.onAddSwatch ?? jest.fn();
  const onRequestPaletteUpgrade = opts.onRequestPaletteUpgrade ?? jest.fn();
  const onClosePollComposer = jest.fn();
  const onCreatePoll = jest.fn();
  const onCloseBoardQa = jest.fn();
  const isCitationLive = opts.isCitationLive ?? jest.fn(() => true);
  const onSelectCitation = opts.onSelectCitation ?? jest.fn();
  const onBoardQaQuotaExceeded = opts.onBoardQaQuotaExceeded ?? jest.fn();

  render(
    <BoardModals
      boardId="board1"
      currentUserId="self"
      adminName="Self"
      doc={doc}
      comments={comments}
      ai={ai}
      boxOfElement={() => null}
      presence={[]}
      cheatSheetVisible={false}
      onCloseCheatSheet={jest.fn()}
      joinVisible={false}
      onJoined={jest.fn()}
      onJoinCancel={jest.fn()}
      shareVisible={false}
      onCloseShare={jest.fn()}
      canvasRef={{ current: null }}
      boardElements={{ paths: [], shapes: [], texts: [], notes: [], images: [], audioNotes: [] }}
      getContentBounds={() => null}
      historyVisible={false}
      onCloseHistory={jest.fn()}
      bgPickerVisible={false}
      onCloseBgPicker={jest.fn()}
      sessionVisible={false}
      onCloseSession={jest.fn()}
      upsellResource={null}
      onDismissUpsell={jest.fn()}
      onSessionQuotaExceeded={jest.fn()}
      colorPickerVisible={false}
      onCloseColorPicker={jest.fn()}
      activeColor="#000000"
      activeAlpha={1}
      onChangeColor={jest.fn()}
      recentColors={[]}
      plan={opts.plan ?? "free"}
      canManageWorkspace={opts.canManageWorkspace ?? true}
      workspaceSwatches={opts.workspaceSwatches ?? []}
      onAddSwatch={onAddSwatch}
      onRequestPaletteUpgrade={onRequestPaletteUpgrade}
      widthPickerVisible={false}
      onCloseWidthPicker={jest.fn()}
      activeStrokeWidth={5}
      onChangeStrokeWidth={jest.fn()}
      presenterLocksContentCreation={opts.presenterLocksContentCreation}
      pollComposerVisible={opts.pollComposerVisible ?? false}
      onClosePollComposer={onClosePollComposer}
      onCreatePoll={onCreatePoll}
      boardQaEnabled={opts.boardQaEnabled ?? true}
      boardQaVisible={opts.boardQaVisible ?? false}
      onCloseBoardQa={onCloseBoardQa}
      isCitationLive={isCitationLive}
      onSelectCitation={onSelectCitation}
      onBoardQaQuotaExceeded={onBoardQaQuotaExceeded}
    />
  );

  return {
    doc,
    comments,
    ai,
    onAddSwatch,
    onRequestPaletteUpgrade,
    onClosePollComposer,
    onCreatePoll,
    onCloseBoardQa,
    isCitationLive,
    onSelectCitation,
    onBoardQaQuotaExceeded,
  };
}

beforeEach(() => {
  mockDiagramPromptProps = null;
  mockColorPickerProps = null;
  mockStrokeWidthProps = null;
  mockPollComposerProps = null;
  mockBoardQaProps = null;
  mockBoardQaRenders = 0;
});

describe("BoardModals — diagram-generate gate while presenting", () => {
  it("locked: an open diagram prompt does not reach ai.generateDiagram, but stays closeable", () => {
    const { ai } = renderModals({ presenterLocksContentCreation: true });

    expect(mockDiagramPromptProps.onGenerate).toBeUndefined();
    // Dismiss/close is never gated — only the write-and-spend-quota action is.
    expect(mockDiagramPromptProps.onClose).toBe(ai.closeDiagram);
    expect(mockDiagramPromptProps.visible).toBe(true);
  });

  it("unlocked: the open diagram prompt is wired to the real ai.generateDiagram", () => {
    // `presenterLocksContentCreation` is the already-derived boolean
    // (`useBoardCollab`'s `!!activePresenter && !activePresenter.paused`) —
    // BoardModals only ever sees `false` for both "no presenter" and "a
    // paused one", so there is exactly one meaningful unlocked case to pin at
    // this layer. The presenter/paused distinction itself is covered by
    // `useBoardCollab.test.ts`'s case-1/case-2 `presenterLocksContentCreation`
    // assertions.
    const { ai } = renderModals({ presenterLocksContentCreation: false });

    expect(mockDiagramPromptProps.onGenerate).toBe(ai.generateDiagram);
  });
});

describe("BoardModals — colour + stroke polish wiring (Month 5, ROADMAP items 12 + 14)", () => {
  it("passes the workspace plan and swatches straight through to ColorPickerModal", () => {
    renderModals({
      presenterLocksContentCreation: false,
      plan: "pro",
      workspaceSwatches: ["#3366ff"],
    });

    expect(mockColorPickerProps.plan).toBe("pro");
    expect(mockColorPickerProps.workspaceSwatches).toEqual(["#3366ff"]);
  });

  it("ColorPickerModal's onAddSwatch is the caller-supplied handler, not re-derived here", () => {
    const onAddSwatch = jest.fn();
    renderModals({ presenterLocksContentCreation: false, onAddSwatch });

    mockColorPickerProps.onAddSwatch("#abcdef");
    expect(onAddSwatch).toHaveBeenCalledWith("#abcdef");
  });

  it("ColorPickerModal's onUpgradeRequested is wired to onRequestPaletteUpgrade — the same upsell path as session/AI quota denials", () => {
    const onRequestPaletteUpgrade = jest.fn();
    renderModals({ presenterLocksContentCreation: false, onRequestPaletteUpgrade });

    mockColorPickerProps.onUpgradeRequested();
    expect(onRequestPaletteUpgrade).toHaveBeenCalledTimes(1);
  });

  it("passes the active stroke width straight through to StrokeWidthModal", () => {
    renderModals({ presenterLocksContentCreation: false });
    expect(mockStrokeWidthProps.strokeWidth).toBe(5);
  });
});

describe("BoardModals — poll composer wiring (Month 6)", () => {
  it("passes pollComposerVisible straight through to PollComposer", () => {
    renderModals({ presenterLocksContentCreation: false, pollComposerVisible: true });
    expect(mockPollComposerProps.visible).toBe(true);

    renderModals({ presenterLocksContentCreation: false, pollComposerVisible: false });
    expect(mockPollComposerProps.visible).toBe(false);
  });

  it("PollComposer's onCancel/onSubmit are the caller-supplied handlers, not re-derived here", () => {
    const { onClosePollComposer, onCreatePoll } = renderModals({ presenterLocksContentCreation: false });

    mockPollComposerProps.onCancel();
    expect(onClosePollComposer).toHaveBeenCalledTimes(1);

    const input = { question: "Q?", options: ["A", "B"], anonymous: false, mode: "single" as const };
    mockPollComposerProps.onSubmit(input);
    expect(onCreatePoll).toHaveBeenCalledWith(input);
  });
});

// Month 6 — the board Q&A chat panel. This layer is where it is actually
// reachable from: the header's button flips the screen state, and this renders
// the panel with it. Four tasks on this branch shipped a component nothing
// mounted, so the mounting is what these pin, not the panel's own behaviour
// (BoardQaPanel.test.tsx covers that).
describe("BoardModals — board Q&A wiring (Month 6)", () => {
  it("mounts the panel and passes its visibility through", () => {
    renderModals({ presenterLocksContentCreation: false, boardQaVisible: true });
    expect(mockBoardQaProps.visible).toBe(true);

    renderModals({ presenterLocksContentCreation: false, boardQaVisible: false });
    expect(mockBoardQaProps.visible).toBe(false);
  });

  it("does not mount the panel at all when the feature is off", () => {
    // A build with the flag off should not be carrying the panel's callable
    // wiring around at runtime, the same shape as the diagram prompt's gate.
    renderModals({ presenterLocksContentCreation: false, boardQaEnabled: false });
    expect(mockBoardQaRenders).toBe(0);
    expect(mockBoardQaProps).toBeNull();
  });

  it("gives the panel THIS board's id — an answer must be about the board you're on", () => {
    renderModals({ presenterLocksContentCreation: false, boardQaVisible: true });
    expect(mockBoardQaProps.boardId).toBe("board1");
  });

  it("wires the citation-liveness resolver straight through, not a stub", () => {
    // The panel cannot tell a deleted element from a live one by itself; the
    // screen's element sets are the only source. A `() => true` default
    // silently substituted here would make every citation claim to be live.
    const isCitationLive = jest.fn(() => false);
    renderModals({ presenterLocksContentCreation: false, boardQaVisible: true, isCitationLive });

    expect(mockBoardQaProps.isCitationLive("el1", "note")).toBe(false);
    expect(isCitationLive).toHaveBeenCalledWith("el1", "note");
  });

  it("wires citation taps and the quota denial to the caller's handlers", () => {
    const onSelectCitation = jest.fn();
    const onBoardQaQuotaExceeded = jest.fn();
    const { onCloseBoardQa } = renderModals({
      presenterLocksContentCreation: false,
      boardQaVisible: true,
      onSelectCitation,
      onBoardQaQuotaExceeded,
    });

    mockBoardQaProps.onSelectCitation("el1", "text");
    expect(onSelectCitation).toHaveBeenCalledWith("el1", "text");

    mockBoardQaProps.onQuotaExceeded();
    expect(onBoardQaQuotaExceeded).toHaveBeenCalledTimes(1);

    mockBoardQaProps.onClose();
    expect(onCloseBoardQa).toHaveBeenCalledTimes(1);
  });

  it("is not gated by the presenter lock — asking a question creates no content", () => {
    renderModals({ presenterLocksContentCreation: true, boardQaVisible: true });
    expect(mockBoardQaProps.visible).toBe(true);
    expect(typeof mockBoardQaProps.onQuotaExceeded).toBe("function");
  });
});
