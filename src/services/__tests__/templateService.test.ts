// boardService/pathService/shapeService all transitively import
// firebase/firestore, which ships ESM this repo's Jest transform can't
// parse (see CLAUDE.md / BoardCanvas.test.tsx's own note on this) —
// `jest.mock(...)` with no factory still loads the real module to derive
// its shape, so a bare automock hits the same parse error. Mirrors
// boardService.test.ts's own convention: mock the two Firebase seams
// (`firebase/firestore`, `../../config/firebase`) and `firebase/functions`
// (createBoard's callable), then spy on the real service functions.
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
const mockCallable = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: (..._args: unknown[]) => mockCallable,
}));

// analyticsService has no Firebase import in its own graph, so a plain
// automock is safe here (unlike the three services above).
jest.mock("../analyticsService");

import * as boardService from "../boardService";
import * as pathService from "../pathService";
import * as shapeService from "../shapeService";
import { track } from "../analyticsService";
import {
  listTemplates,
  listTemplatesByCategory,
  getTemplate,
  applyTemplateToBoard,
  createBoardFromTemplate,
  TEMPLATE_CATEGORY_ORDER,
  Template,
} from "../templateService";

const mockCreateBoard = jest.spyOn(boardService, "createBoard");
const mockSaveShape = jest.spyOn(shapeService, "saveShape").mockResolvedValue("shape-id");
const mockSaveTextElement = jest.spyOn(pathService, "saveTextElement").mockResolvedValue("text-id");
const mockSaveTextNote = jest.spyOn(pathService, "saveTextNote").mockResolvedValue("note-id");
const mockTrack = track as jest.Mock;

const EXPECTED_CATEGORY_COUNTS: Record<string, number> = {
  study: 6,
  cs: 6,
  classroom: 5,
  meeting: 4,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("listTemplates / listTemplatesByCategory / getTemplate", () => {
  it("lists exactly the 21 shipped templates, each schemaVersion 1", () => {
    const all = listTemplates();
    expect(all.length).toBe(21);
    for (const t of all) {
      expect(t.schemaVersion).toBe(1);
    }
  });

  it("has no duplicate template ids", () => {
    const ids = listTemplates().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("groups templates into the four categories with the exact established counts", () => {
    const grouped = listTemplatesByCategory();
    expect(grouped.map((g) => g.category)).toEqual(TEMPLATE_CATEGORY_ORDER);
    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.category] = g.templates.length;
    expect(counts).toEqual(EXPECTED_CATEGORY_COUNTS);
  });

  it("every template returned by listTemplatesByCategory is reachable by id via getTemplate", () => {
    for (const group of listTemplatesByCategory()) {
      for (const t of group.templates) {
        expect(getTemplate(t.id)).toBe(t);
      }
    }
  });

  it("returns undefined for an id that isn't a real template", () => {
    expect(getTemplate("not-a-real-template")).toBeUndefined();
  });
});

describe("applyTemplateToBoard", () => {
  function fixture(overrides: Partial<Template> = {}): Template {
    return {
      schemaVersion: 1,
      id: "fixture-template",
      title: "Fixture Template",
      category: "study",
      description: "A hand-built fixture, independent of the real 21 files.",
      elements: [
        { type: "shape", shape: "rect", x: 1, y: 2, width: 3, height: 4 },
        { type: "text", text: "hello", x: 5, y: 6, width: 7, height: 8 },
        { type: "note", content: "a sticky note", x: 9, y: 10 },
      ],
      ...overrides,
    } as Template;
  }

  it("writes a shape element via shapeService.saveShape, filling in every default the schema requires", async () => {
    await applyTemplateToBoard("board-1", "user-1", fixture({
      elements: [{ type: "shape", shape: "ellipse", x: 1, y: 2, width: 3, height: 4 }],
    }));
    expect(mockSaveShape).toHaveBeenCalledTimes(1);
    expect(mockSaveShape).toHaveBeenCalledWith("board-1", {
      boardId: "board-1",
      userId: "user-1",
      shape: "ellipse",
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      rotation: 0,
      fill: "none",
      stroke: "#334155",
      strokeWidth: 2,
      dashed: false,
      arrowheadStart: "none",
      arrowheadEnd: "none",
    });
  });

  it("honors an explicit shape style over its default", async () => {
    await applyTemplateToBoard("board-1", "user-1", fixture({
      elements: [
        {
          type: "shape",
          shape: "arrow",
          x: 0,
          y: 0,
          width: 10,
          height: 0,
          stroke: "#2563eb",
          arrowheadEnd: "open",
          dashed: true,
        },
      ],
    }));
    expect(mockSaveShape).toHaveBeenCalledWith(
      "board-1",
      expect.objectContaining({ stroke: "#2563eb", arrowheadEnd: "open", dashed: true })
    );
  });

  it("writes a text element via pathService.saveTextElement, nesting x/y into `position`", async () => {
    await applyTemplateToBoard("board-1", "user-1", fixture({
      elements: [{ type: "text", text: "hello", x: 5, y: 6, width: 7, height: 8 }],
    }));
    expect(mockSaveTextElement).toHaveBeenCalledWith("board-1", {
      boardId: "board-1",
      userId: "user-1",
      text: "hello",
      position: { x: 5, y: 6 },
      width: 7,
      height: 8,
      fontSize: 16,
      color: "#111827",
    });
  });

  it("writes a note element via pathService.saveTextNote, nesting x/y into `position`", async () => {
    await applyTemplateToBoard("board-1", "user-1", fixture({
      elements: [{ type: "note", content: "a sticky note", x: 9, y: 10 }],
    }));
    expect(mockSaveTextNote).toHaveBeenCalledWith("board-1", {
      boardId: "board-1",
      userId: "user-1",
      content: "a sticky note",
      position: { x: 9, y: 10 },
    });
  });

  it("writes every element of a multi-element template", async () => {
    await applyTemplateToBoard("board-1", "user-1", fixture());
    expect(mockSaveShape).toHaveBeenCalledTimes(1);
    expect(mockSaveTextElement).toHaveBeenCalledTimes(1);
    expect(mockSaveTextNote).toHaveBeenCalledTimes(1);
  });

  it("writes elements in the template's own array order, not concurrently", async () => {
    const order: string[] = [];
    mockSaveShape.mockImplementation(async () => {
      order.push("shape");
      return "shape-id";
    });
    mockSaveTextNote.mockImplementation(async () => {
      order.push("note");
      return "note-id";
    });
    await applyTemplateToBoard("board-1", "user-1", fixture({
      elements: [
        { type: "shape", shape: "rect", x: 0, y: 0, width: 1, height: 1 },
        { type: "note", content: "second", x: 0, y: 0 },
      ],
    }));
    expect(order).toEqual(["shape", "note"]);
  });

  it("throws a message naming the template id and the bad type for an unsupported element kind", async () => {
    const bad = fixture({
      id: "bad-template",
      elements: [{ type: "image", x: 0, y: 0 } as never],
    });
    await expect(applyTemplateToBoard("board-1", "user-1", bad)).rejects.toThrow(/bad-template/);
    await expect(applyTemplateToBoard("board-1", "user-1", bad)).rejects.toThrow(/image/);
  });
});

describe("createBoardFromTemplate", () => {
  it("creates the board with the template's title, seeds its elements, and tracks board_created with the template id", async () => {
    mockCreateBoard.mockResolvedValue("new-board-id");
    const boardId = await createBoardFromTemplate("standup", "user-1", "ws-1", "pro", 3);

    expect(mockCreateBoard).toHaveBeenCalledWith("Daily Standup", "user-1", "ws-1", "pro", 3);
    expect(boardId).toBe("new-board-id");
    // The standup template's real elements got written to the real board id
    // createBoard resolved to, not a placeholder.
    expect(mockSaveShape.mock.calls.every(([bId]) => bId === "new-board-id")).toBe(true);
    expect(mockSaveShape.mock.calls.length).toBeGreaterThan(0);
    expect(mockTrack).toHaveBeenCalledWith("board_created", { templateId: "standup" });
  });

  it("throws for an unknown template id without ever calling createBoard", async () => {
    await expect(
      createBoardFromTemplate("not-a-real-template", "user-1", "ws-1")
    ).rejects.toThrow(/not-a-real-template/);
    expect(mockCreateBoard).not.toHaveBeenCalled();
  });

  it("propagates a createBoard rejection (e.g. a quota denial) without seeding elements or tracking", async () => {
    const quotaError = new Error("quota exceeded");
    mockCreateBoard.mockRejectedValue(quotaError);
    await expect(createBoardFromTemplate("standup", "user-1", "ws-1")).rejects.toBe(quotaError);
    expect(mockSaveShape).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
