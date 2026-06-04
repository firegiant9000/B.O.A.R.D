jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, ts } from "../../test-utils/firestoreMock";
import * as pathService from "../pathService";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("savePath", () => {
  it("writes the path with a server timestamp and returns the new id", async () => {
    addDoc.mockResolvedValueOnce({ id: "path-1" });

    const id = await pathService.savePath("board-1", {
      boardId: "board-1",
      userId: "u1",
      points: [{ x: 0, y: 0 }],
      color: "#000",
      strokeWidth: 5,
      tool: "pen",
    });

    expect(id).toBe("path-1");
    const payload = addDoc.mock.calls[0][1];
    expect(payload).toMatchObject({ userId: "u1", tool: "pen" });
    expect(payload.createdAt).toBe("__serverTimestamp__");
  });
});

describe("getBoardPaths", () => {
  it("maps valid docs and drops docs missing required fields", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        [
          "p1",
          {
            boardId: "board-1",
            userId: "u1",
            points: [{ x: 1, y: 2 }],
            color: "#000",
            tool: "pen",
            createdAt: ts(now),
          },
        ],
        // invalid: missing points/color/tool
        ["bad", { userId: "u2" }],
      ])
    );

    const paths = await pathService.getBoardPaths("board-1");

    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ id: "p1", strokeWidth: 5, tool: "pen" });
    expect(paths[0].createdAt).toEqual(now);
  });

  it("defaults strokeWidth to 5 when absent", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["p1", { points: [{ x: 0, y: 0 }], color: "#f00", tool: "pen" }],
      ])
    );
    const paths = await pathService.getBoardPaths("board-1");
    expect(paths[0].strokeWidth).toBe(5);
  });
});

describe("deletePath", () => {
  it("deletes the doc at the correct path", async () => {
    await pathService.deletePath("board-1", "path-9");
    const ref = deleteDoc.mock.calls[0][0];
    expect(ref.path).toEqual(["boards", "board-1", "paths", "path-9"]);
  });
});

describe("clearBoardPaths", () => {
  it("commits a batch of deletes for all docs", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["p1", {}],
        ["p2", {}],
      ])
    );
    const batch = { delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);

    await pathService.clearBoardPaths("board-1");

    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("does nothing destructive when the board is empty", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    await pathService.clearBoardPaths("board-1");
    expect(fs.writeBatch).not.toHaveBeenCalled();
  });
});

describe("getBoardNotes", () => {
  it("drops notes missing content or position", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["n1", { content: "hi", position: { x: 1, y: 1 } }],
        ["n2", { content: "no position" }],
      ])
    );
    const notes = await pathService.getBoardNotes("board-1");
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe("n1");
  });
});

describe("subscribeToBoardPaths", () => {
  it("wires onSnapshot, transforms the snapshot, and returns the unsubscribe", () => {
    const unsub = jest.fn();
    (fs.onSnapshot as jest.Mock).mockImplementationOnce((_q, cb) => {
      cb(makeQuerySnap([["p1", { points: [{ x: 0, y: 0 }], color: "#000", tool: "pen" }]]));
      return unsub;
    });

    const onChange = jest.fn();
    const returned = pathService.subscribeToBoardPaths("board-1", onChange);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toHaveLength(1);
    expect(returned).toBe(unsub);
  });
});

describe("text notes", () => {
  it("saveTextNote writes with a server timestamp and returns the id", async () => {
    addDoc.mockResolvedValueOnce({ id: "n1" });
    const id = await pathService.saveTextNote("board-1", {
      boardId: "board-1",
      userId: "u1",
      content: "hi",
      position: { x: 1, y: 2 },
    });
    expect(id).toBe("n1");
    expect(addDoc.mock.calls[0][1].createdAt).toBe("__serverTimestamp__");
  });

  it("deleteTextNote targets the right doc path", async () => {
    await pathService.deleteTextNote("board-1", "n1");
    expect(deleteDoc.mock.calls[0][0].path).toEqual(["boards", "board-1", "notes", "n1"]);
  });

  it("clearBoardNotes commits a delete batch", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["n1", {}]]));
    const batch = { delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await pathService.clearBoardNotes("board-1");
    expect(batch.delete).toHaveBeenCalledTimes(1);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("subscribeToBoardNotes drops invalid docs and returns the unsubscribe", () => {
    const unsub = jest.fn();
    (fs.onSnapshot as jest.Mock).mockImplementationOnce((_q, cb) => {
      cb(
        makeQuerySnap([
          ["n1", { content: "ok", position: { x: 0, y: 0 } }],
          ["bad", { content: "no position" }],
        ])
      );
      return unsub;
    });
    const onChange = jest.fn();
    const returned = pathService.subscribeToBoardNotes("board-1", onChange);
    expect(onChange.mock.calls[0][0]).toHaveLength(1);
    expect(returned).toBe(unsub);
  });
});

describe("text elements", () => {
  it("saveTextElement writes and returns the id", async () => {
    addDoc.mockResolvedValueOnce({ id: "t1" });
    const id = await pathService.saveTextElement("board-1", {
      boardId: "board-1",
      userId: "u1",
      text: "hello",
      position: { x: 0, y: 0 },
      width: 100,
      height: 40,
      fontSize: 16,
      color: "#000",
    });
    expect(id).toBe("t1");
  });

  it("getBoardTextElements maps docs", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["t1", { text: "hi", position: { x: 1, y: 1 }, fontSize: 16 }]])
    );
    const els = await pathService.getBoardTextElements("board-1");
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ id: "t1", text: "hi", fontSize: 16 });
  });

  it("updateTextElement updates the targeted doc", async () => {
    await pathService.updateTextElement("board-1", "t1", { text: "new" });
    expect((fs.updateDoc as jest.Mock).mock.calls[0][0].path).toEqual([
      "boards",
      "board-1",
      "textElements",
      "t1",
    ]);
    expect((fs.updateDoc as jest.Mock).mock.calls[0][1]).toEqual({ text: "new" });
  });

  it("deleteTextElement targets the right doc path", async () => {
    await pathService.deleteTextElement("board-1", "t1");
    expect(deleteDoc.mock.calls[0][0].path).toEqual([
      "boards",
      "board-1",
      "textElements",
      "t1",
    ]);
  });

  it("clearBoardTextElements commits a delete batch", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["t1", {}]]));
    const batch = { delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await pathService.clearBoardTextElements("board-1");
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("subscribeToBoardTextElements maps docs and returns the unsubscribe", () => {
    const unsub = jest.fn();
    (fs.onSnapshot as jest.Mock).mockImplementationOnce((_q, cb) => {
      cb(makeQuerySnap([["t1", { text: "hi", position: { x: 0, y: 0 } }]]));
      return unsub;
    });
    const onChange = jest.fn();
    const returned = pathService.subscribeToBoardTextElements("board-1", onChange);
    expect(onChange.mock.calls[0][0]).toHaveLength(1);
    expect(returned).toBe(unsub);
  });
});
