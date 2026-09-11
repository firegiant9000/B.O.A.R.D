jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../../config/firebase", () => ({ db: {} }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
// Hand-written, not `jest.requireActual` — the real module transitively
// imports `firebase/functions` → `@firebase/util`, which ships ESM this
// repo's Jest transform can't parse (the same constraint that keeps screens
// under app/ untestable). `effectiveBoardRole` is reproduced verbatim
// (boardService.ts) since ShareBoardModal calls it synchronously at render
// time for the "Who Has Access" list — everything else here is
// network-bound and just needs to exist as a jest.fn().
jest.mock("../../services/boardService", () => ({
  addMemberById: jest.fn(),
  addMemberByEmail: jest.fn(),
  removeBoardRole: jest.fn(),
  setBoardRole: jest.fn(),
  removeMemberById: jest.fn(),
  effectiveBoardRole: (
    board: { workspaceId: string; ownerId: string; members: string[]; roles: Record<string, string> },
    _workspace: unknown,
    uid: string
  ) => {
    if (!board.members.includes(uid)) return undefined;
    if (uid === board.ownerId) return "editor";
    return board.roles?.[uid] ?? "editor";
  },
}));
jest.mock("../../services/friendService", () => ({ getFriends: jest.fn().mockResolvedValue([]) }));
jest.mock("../../services/embedService", () => ({ createEmbedLink: jest.fn() }));
jest.mock("../../services/workspaceService", () => ({ getWorkspace: jest.fn().mockResolvedValue(null) }));
jest.mock("../../lib/errorReporting", () => ({ captureException: jest.fn() }));
// Month 6 — the two functions under test here are ShareBoardModal's actual
// export wiring: mocking the module they come from lets these tests assert
// exactly what the component decided to call them with, the same altitude
// BoardCanvas.test.tsx asserts its own content-creation call sites at.
jest.mock("../../utils/recapExport", () => ({
  exportBoardPdf: jest.fn(),
  exportBoardPng: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import ShareBoardModal from "../ShareBoardModal";
import { getDoc } from "firebase/firestore";
import { makeDocSnap } from "../../test-utils/firestoreMock";
import { exportBoardPdf, exportBoardPng } from "../../utils/recapExport";
import type { DrawPath } from "../../types";

const mockExportBoardPdf = exportBoardPdf as jest.Mock;
const mockExportBoardPng = exportBoardPng as jest.Mock;

const pathData: DrawPath = {
  id: "p1",
  boardId: "b1",
  userId: "u1",
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
  ],
  color: "#000000",
  strokeWidth: 2,
  tool: "pen",
  createdAt: new Date(),
};

function renderModal(overrides: Partial<React.ComponentProps<typeof ShareBoardModal>> = {}) {
  const defaultProps: React.ComponentProps<typeof ShareBoardModal> = {
    visible: true,
    boardId: "b1",
    inviteCode: "ABC123",
    members: ["u1"],
    currentUserId: "u1",
    // Falsy so the workspace-role-floor effect skips its network call —
    // irrelevant to the export wiring under test here.
    workspaceId: "",
    ownerId: "u1",
    roles: {},
    isAdmin: true,
    onClose: jest.fn(),
    onMemberAdded: jest.fn(),
    onAccessChanged: jest.fn(),
    boardTitle: "My Board",
    canvasRef: { current: "fake-svg-ref" },
    boardElements: { paths: [pathData], shapes: [], texts: [], notes: [], images: [], audioNotes: [] },
    getContentBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }),
    ...overrides,
  };
  return render(<ShareBoardModal {...defaultProps} />);
}

/**
 * ShareBoardModal.test.tsx — Month 6 board export wiring (ROADMAP A3, "Print
 * + export polish"). PNG/PDF export were implemented (pdfTiling.ts,
 * recapExport.ts) with no UI entry point; this proves the entry point that
 * closes that gap actually renders and actually invokes the real functions,
 * following BoardCanvas.test.tsx's own pattern: drive the real component,
 * mock only its service/module boundary, assert on what it decided to call.
 */
describe("ShareBoardModal — board export (Month 6, ROADMAP A3)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getDoc as jest.Mock).mockResolvedValue(
      makeDocSnap("u1", { displayName: "Self", email: "self@example.com" })
    );
  });

  it("renders PNG and PDF export actions", () => {
    renderModal();
    expect(screen.getByText("PNG")).toBeTruthy();
    expect(screen.getByText("PDF")).toBeTruthy();
  });

  it("exports PNG via the live canvas ref, converted from raw board elements to nothing extra — just the ref and a title", async () => {
    renderModal();
    fireEvent.press(screen.getByText("PNG"));

    await waitFor(() => expect(mockExportBoardPng).toHaveBeenCalledTimes(1));
    expect(mockExportBoardPng).toHaveBeenCalledWith("fake-svg-ref", { title: "My Board" });
  });

  it("exports PDF with the board's elements converted to SvgExportElement[] and bounds converted from contentBounds()", async () => {
    renderModal();
    fireEvent.press(screen.getByText("PDF"));

    await waitFor(() => expect(mockExportBoardPdf).toHaveBeenCalledTimes(1));
    const [elements, bounds, opts] = mockExportBoardPdf.mock.calls[0];
    // The one path element passed in via boardElements survived the
    // raw-array → SvgExportElement[] conversion, tagged correctly.
    expect(elements).toEqual(
      expect.arrayContaining([{ kind: "path", data: pathData }])
    );
    // {minX:0,minY:0,maxX:100,maxY:100} → {x,y,width,height}, exactly the
    // conversion svgExport.ts's own SvgExportBounds doc comment specifies.
    expect(bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(opts).toEqual({ title: "My Board" });
  });

  it("shows an error and never calls exportBoardPdf for an empty board (contentBounds is null)", async () => {
    renderModal({ getContentBounds: () => null });
    fireEvent.press(screen.getByText("PDF"));

    await waitFor(() =>
      expect(screen.getByText(/nothing to export/i)).toBeTruthy()
    );
    expect(mockExportBoardPdf).not.toHaveBeenCalled();
  });

  it("surfaces the export function's own error message when the export throws", async () => {
    mockExportBoardPdf.mockRejectedValueOnce(new Error("This board would need 87 PDF pages"));
    renderModal();
    fireEvent.press(screen.getByText("PDF"));

    await waitFor(() =>
      expect(screen.getByText("This board would need 87 PDF pages")).toBeTruthy()
    );
  });

  it("disables both export buttons while one export is in flight", async () => {
    let resolveExport: (() => void) | undefined;
    mockExportBoardPng.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveExport = resolve; })
    );
    renderModal();

    fireEvent.press(screen.getByText("PNG"));
    await waitFor(() => expect(mockExportBoardPng).toHaveBeenCalledTimes(1));

    fireEvent.press(screen.getByText("PDF"));
    // Still in flight for PNG, so the PDF press must not have gone through.
    expect(mockExportBoardPdf).not.toHaveBeenCalled();

    await act(async () => {
      resolveExport?.();
      await Promise.resolve();
    });
  });
});
