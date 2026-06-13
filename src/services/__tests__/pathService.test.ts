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

  it("persists a board-space bbox inflated by half the stroke width", async () => {
    addDoc.mockResolvedValueOnce({ id: "path-2" });

    await pathService.savePath("board-1", {
      boardId: "board-1",
      userId: "u1",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ],
      color: "#000",
      strokeWidth: 4, // half-width = 2
      tool: "pen",
    });

    const payload = addDoc.mock.calls[0][1];
    expect(payload.bbox).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 22 });
  });

  it("inflates the eraser bbox by half the rendered (strokeWidth + 10) width", async () => {
    addDoc.mockResolvedValueOnce({ id: "path-3" });

    await pathService.savePath("board-1", {
      boardId: "board-1",
      userId: "u1",
      points: [{ x: 0, y: 0 }],
      color: "#000",
      strokeWidth: 0, // rendered = 10, half = 5
      tool: "eraser",
    });

    const payload = addDoc.mock.calls[0][1];
    expect(payload.bbox).toEqual({ minX: -5, minY: -5, maxX: 5, maxY: 5 });
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

  it("returns the stored bbox when present", async () => {
    const bbox = { minX: 1, minY: 2, maxX: 3, maxY: 4 };
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["p1", { points: [{ x: 1, y: 2 }], color: "#000", tool: "pen", bbox }],
      ])
    );
    const paths = await pathService.getBoardPaths("board-1");
    expect(paths[0].bbox).toEqual(bbox);
  });

  it("computes a fallback bbox for legacy docs missing one", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        [
          "p1",
          {
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 10 },
            ],
            color: "#000",
            strokeWidth: 4, // half-width = 2
            tool: "pen",
          },
        ],
      ])
    );
    const paths = await pathService.getBoardPaths("board-1");
    expect(paths[0].bbox).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 12 });
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

  it("opts into metadata changes and reports sync state when given a reporter", () => {
    (fs.onSnapshot as jest.Mock).mockImplementationOnce((_q, _opts, cb) => {
      const snap = makeQuerySnap([
        ["p1", { points: [{ x: 0, y: 0 }], color: "#000", tool: "pen" }],
      ]) as any;
      snap.metadata = { fromCache: true, hasPendingWrites: true };
      cb(snap);
      return jest.fn();
    });

    const onChange = jest.fn();
    const onSyncState = jest.fn();
    pathService.subscribeToBoardPaths("board-1", onChange, onSyncState);

    // includeMetadataChanges is requested (options object as 2nd arg).
    expect((fs.onSnapshot as jest.Mock).mock.calls[0][1]).toEqual({
      includeMetadataChanges: true,
    });
    expect(onSyncState).toHaveBeenCalledWith({
      fromCache: true,
      hasPendingWrites: true,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
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

describe("group batch operations (Phase 8)", () => {
  it("batchUpdatePaths updates each doc at the right path in one batch", async () => {
    const batch = { update: jest.fn(), delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);

    await pathService.batchUpdatePaths("board-1", [
      { id: "p1", data: { z: 3 } },
      { id: "p2", data: { color: "#f00" } },
    ]);

    expect(batch.update).toHaveBeenCalledTimes(2);
    expect(batch.update.mock.calls[0][0].path).toEqual(["boards", "board-1", "paths", "p1"]);
    expect(batch.update.mock.calls[0][1]).toEqual({ z: 3 });
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("batchUpdatePaths chunks past the 500-op batch ceiling", async () => {
    const batch = { update: jest.fn(), delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValue(batch);

    const updates = Array.from({ length: 501 }, (_, i) => ({ id: `p${i}`, data: { z: i } }));
    await pathService.batchUpdatePaths("board-1", updates);

    expect(fs.writeBatch).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(2);
  });

  it("batchDeletePaths deletes each id and commits", async () => {
    const batch = { update: jest.fn(), delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);

    await pathService.batchDeletePaths("board-1", ["p1", "p2", "p3"]);

    expect(batch.delete).toHaveBeenCalledTimes(3);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("batchUpdateTextElements writes to the textElements subcollection", async () => {
    const batch = { update: jest.fn(), delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);

    await pathService.batchUpdateTextElements("board-1", [
      { id: "t1", data: { position: { x: 5, y: 6 } } },
    ]);

    expect(batch.update.mock.calls[0][0].path).toEqual(["boards", "board-1", "textElements", "t1"]);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("batchDeleteTextElements deletes each id", async () => {
    const batch = { update: jest.fn(), delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await pathService.batchDeleteTextElements("board-1", ["t1", "t2"]);
    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("batch helpers are no-ops on empty input", async () => {
    await pathService.batchUpdatePaths("board-1", []);
    await pathService.batchDeletePaths("board-1", []);
    expect(fs.writeBatch).not.toHaveBeenCalled();
  });
});
