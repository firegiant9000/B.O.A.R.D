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
}) {
  const doc = makeDoc();
  const comments = makeComments();
  // The diagram prompt is already open — the exact scenario under test.
  const ai = makeAi({ diagramEnabled: true, diagramOpen: true, ...opts.ai });
  const onAddSwatch = opts.onAddSwatch ?? jest.fn();
  const onRequestPaletteUpgrade = opts.onRequestPaletteUpgrade ?? jest.fn();

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
    />
  );

  return { doc, comments, ai, onAddSwatch, onRequestPaletteUpgrade };
}

beforeEach(() => {
  mockDiagramPromptProps = null;
  mockColorPickerProps = null;
  mockStrokeWidthProps = null;
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
