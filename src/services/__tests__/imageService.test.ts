jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, storage: {}, auth: { currentUser: null } }));
jest.mock("firebase/storage", () => ({
  ref: jest.fn((_s: unknown, path: string) => ({ __type: "storageRef", path })),
  uploadBytes: jest.fn(async () => ({})),
  getDownloadURL: jest.fn(async (r: { path: string }) => `https://dl/${r.path}`),
  deleteObject: jest.fn(async () => undefined),
}));

import * as fs from "firebase/firestore";
import * as storage from "firebase/storage";
import { makeQuerySnap, ts } from "../../test-utils/firestoreMock";
import * as imageService from "../imageService";
import { ImageElement } from "../../types";
import { PreparedImage } from "../../lib/images";

const setDoc = fs.setDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const uploadBytes = storage.uploadBytes as jest.Mock;

const fakeBlob = { size: 1 } as unknown as Blob;
const prepared: PreparedImage = {
  full: { blob: fakeBlob, width: 1024, height: 768 },
  thumbnail: { blob: fakeBlob, width: 256, height: 192 },
  naturalWidth: 4000,
  naturalHeight: 3000,
  alt: "photo.jpg",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("uploadImage", () => {
  it("uploads full + thumb, resolves URLs, and writes the doc with a bbox", async () => {
    const newId = await imageService.uploadImage("board-1", "u1", prepared, {
      x: 0,
      y: 0,
      width: 360,
      height: 270,
    });
    expect(newId).toMatch(/^[A-Za-z0-9]{20}$/);
    // both objects uploaded as jpeg
    expect(uploadBytes).toHaveBeenCalledTimes(2);
    expect(uploadBytes.mock.calls[0][2]).toEqual({ contentType: "image/jpeg" });

    const path = setDoc.mock.calls[0][0].path;
    expect(path).toEqual(["boards", "board-1", "images", newId]);
    const payload = setDoc.mock.calls[0][1];
    expect(payload).toMatchObject({
      userId: "u1",
      storagePath: `boards/board-1/images/${newId}/full.jpg`,
      thumbnailPath: `boards/board-1/images/${newId}/thumb.jpg`,
      naturalWidth: 4000,
      naturalHeight: 3000,
      alt: "photo.jpg",
    });
    expect(payload.url).toContain("https://dl/");
    expect(payload.bbox).toEqual({ minX: 0, minY: 0, maxX: 360, maxY: 270 });
    expect(payload.createdAt).toBe("__serverTimestamp__");
  });
});

describe("saveImage (duplicate / reuse)", () => {
  it("writes a doc for an already-uploaded asset without re-uploading", async () => {
    const { id: _i, createdAt: _c, bbox: _b, ...rest } = {
      id: "x",
      createdAt: new Date(),
      bbox: undefined,
      boardId: "board-1",
      userId: "u1",
      storagePath: "boards/board-1/images/src/full.jpg",
      thumbnailPath: "boards/board-1/images/src/thumb.jpg",
      url: "https://dl/full",
      thumbnailUrl: "https://dl/thumb",
      x: 5,
      y: 5,
      width: 100,
      height: 50,
      rotation: 0,
      naturalWidth: 100,
      naturalHeight: 50,
      alt: "",
    } as ImageElement;
    const id = await imageService.saveImage("board-1", rest);
    expect(uploadBytes).not.toHaveBeenCalled();
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(setDoc.mock.calls[0][1].bbox).toEqual({ minX: 5, minY: 5, maxX: 105, maxY: 55 });
  });
});

describe("updateImage / deleteImage", () => {
  it("updateImage targets the right doc", async () => {
    await imageService.updateImage("board-1", "i1", { x: 9 });
    expect(updateDoc.mock.calls[0][0].path).toEqual(["boards", "board-1", "images", "i1"]);
    expect(updateDoc.mock.calls[0][1]).toEqual({ x: 9 });
  });

  it("deleteImage removes the doc then best-effort deletes both objects", async () => {
    await imageService.deleteImage("board-1", "i1");
    expect(deleteDoc.mock.calls[0][0].path).toEqual(["boards", "board-1", "images", "i1"]);
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
  });
});

describe("subscribeToBoardImages", () => {
  it("maps docs, recomputes a missing bbox, and drops docs with no url", () => {
    const unsub = jest.fn();
    (fs.onSnapshot as jest.Mock).mockImplementationOnce((_q, cb) => {
      cb(
        makeQuerySnap([
          [
            "i1",
            { url: "https://dl/full", x: 0, y: 0, width: 100, height: 50, createdAt: ts(new Date()) },
          ],
          ["bad", { x: 1, y: 1 }], // missing url
        ])
      );
      return unsub;
    });
    const onChange = jest.fn();
    const returned = imageService.subscribeToBoardImages("board-1", onChange);
    const emitted = onChange.mock.calls[0][0];
    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe("i1");
    expect(emitted[0].bbox).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
    expect(returned).toBe(unsub);
  });
});

describe("group batch operations", () => {
  it("batchUpdateImages updates each doc and commits once", async () => {
    const batch = { update: jest.fn(), delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await imageService.batchUpdateImages("board-1", [
      { id: "i1", data: { x: 5 } },
      { id: "i2", data: { z: 2 } },
    ]);
    expect(batch.update).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("batchDeleteImages deletes each id", async () => {
    const batch = { update: jest.fn(), delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await imageService.batchDeleteImages("board-1", ["i1", "i2"]);
    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on empty input", async () => {
    await imageService.batchUpdateImages("board-1", []);
    await imageService.batchDeleteImages("board-1", []);
    expect(fs.writeBatch).not.toHaveBeenCalled();
  });

  it("clearBoardImages commits a delete batch for all docs", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["i1", {}], ["i2", {}]]));
    const batch = { delete: jest.fn(), update: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await imageService.clearBoardImages("board-1");
    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });
});
