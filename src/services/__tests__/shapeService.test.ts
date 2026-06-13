jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, ts } from "../../test-utils/firestoreMock";
import * as shapeService from "../shapeService";
import { ShapeElement } from "../../types";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;

const baseShape: Omit<ShapeElement, "id" | "createdAt" | "bbox"> = {
  boardId: "board-1",
  userId: "u1",
  shape: "rect",
  x: 0,
  y: 0,
  width: 10,
  height: 20,
  rotation: 0,
  fill: "none",
  stroke: "#000000",
  strokeWidth: 2,
  dashed: false,
  arrowheadStart: "none",
  arrowheadEnd: "none",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("saveShape", () => {
  it("writes the shape with a computed bbox and server timestamp", async () => {
    addDoc.mockResolvedValueOnce({ id: "s1" });
    const id = await shapeService.saveShape("board-1", baseShape);
    expect(id).toBe("s1");
    const payload = addDoc.mock.calls[0][1];
    expect(payload).toMatchObject({ shape: "rect", userId: "u1" });
    expect(payload.bbox).toBeDefined();
    expect(payload.createdAt).toBe("__serverTimestamp__");
  });
});

describe("updateShape / deleteShape", () => {
  it("updateShape targets the right doc", async () => {
    await shapeService.updateShape("board-1", "s1", { stroke: "#f00" });
    expect(updateDoc.mock.calls[0][0].path).toEqual(["boards", "board-1", "shapes", "s1"]);
    expect(updateDoc.mock.calls[0][1]).toEqual({ stroke: "#f00" });
  });

  it("deleteShape targets the right doc", async () => {
    await shapeService.deleteShape("board-1", "s1");
    expect(deleteDoc.mock.calls[0][0].path).toEqual(["boards", "board-1", "shapes", "s1"]);
  });
});

describe("subscribeToBoardShapes", () => {
  it("maps docs, recomputes a missing bbox, and drops invalid docs", () => {
    const unsub = jest.fn();
    (fs.onSnapshot as jest.Mock).mockImplementationOnce((_q, cb) => {
      cb(
        makeQuerySnap([
          ["s1", { shape: "rect", x: 0, y: 0, width: 10, height: 10, createdAt: ts(new Date()) }],
          ["bad", { x: 1 }], // missing shape
        ])
      );
      return unsub;
    });
    const onChange = jest.fn();
    const returned = shapeService.subscribeToBoardShapes("board-1", onChange);
    const emitted = onChange.mock.calls[0][0];
    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe("s1");
    expect(emitted[0].bbox).toBeDefined();
    expect(returned).toBe(unsub);
  });

  it("reads back a persisted z-order value", () => {
    (fs.onSnapshot as jest.Mock).mockImplementationOnce((_q, cb) => {
      cb(makeQuerySnap([["s1", { shape: "rect", x: 0, y: 0, width: 5, height: 5, z: 7 }]]));
      return jest.fn();
    });
    const onChange = jest.fn();
    shapeService.subscribeToBoardShapes("board-1", onChange);
    expect(onChange.mock.calls[0][0][0].z).toBe(7);
  });
});

describe("clearBoardShapes", () => {
  it("commits a delete batch for all docs", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["s1", {}], ["s2", {}]]));
    const batch = { delete: jest.fn(), update: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await shapeService.clearBoardShapes("board-1");
    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });
});

describe("group batch operations (Phase 8)", () => {
  it("batchUpdateShapes updates each doc and commits once", async () => {
    const batch = { update: jest.fn(), delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await shapeService.batchUpdateShapes("board-1", [
      { id: "s1", data: { x: 5, y: 5 } },
      { id: "s2", data: { z: 2 } },
    ]);
    expect(batch.update).toHaveBeenCalledTimes(2);
    expect(batch.update.mock.calls[0][0].path).toEqual(["boards", "board-1", "shapes", "s1"]);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("batchDeleteShapes deletes each id", async () => {
    const batch = { update: jest.fn(), delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await shapeService.batchDeleteShapes("board-1", ["s1", "s2"]);
    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("chunks updates past the 500-op ceiling", async () => {
    const batch = { update: jest.fn(), delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValue(batch);
    const updates = Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, data: { z: i } }));
    await shapeService.batchUpdateShapes("board-1", updates);
    expect(fs.writeBatch).toHaveBeenCalledTimes(2);
  });

  it("is a no-op on empty input", async () => {
    await shapeService.batchUpdateShapes("board-1", []);
    await shapeService.batchDeleteShapes("board-1", []);
    expect(fs.writeBatch).not.toHaveBeenCalled();
  });
});
