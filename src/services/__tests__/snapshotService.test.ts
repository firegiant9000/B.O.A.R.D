jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, ts } from "../../test-utils/firestoreMock";
import * as snapshotService from "../snapshotService";
import { DrawPath } from "../../types";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

function path(id: string, createdAt: Date, extra: Partial<DrawPath> = {}): DrawPath {
  return {
    id,
    boardId: "board-1",
    userId: "u1",
    points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    color: "#000",
    strokeWidth: 5,
    tool: "pen",
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    createdAt,
    ...extra,
  };
}

describe("shouldSnapshot", () => {
  it("is false below a full interval of new strokes", () => {
    expect(snapshotService.shouldSnapshot(499, 0)).toBe(false);
    expect(snapshotService.shouldSnapshot(999, 500)).toBe(false);
  });

  it("fires exactly at the interval boundary and beyond", () => {
    expect(snapshotService.shouldSnapshot(500, 0)).toBe(true);
    expect(snapshotService.shouldSnapshot(1001, 500)).toBe(true);
  });
});

describe("createSnapshot", () => {
  it("serializes paths, counts them, and records the max createdAt watermark", async () => {
    addDoc.mockResolvedValueOnce({ id: "snap-1" });

    const id = await snapshotService.createSnapshot("board-1", [
      path("a", new Date(1000)),
      path("b", new Date(5000)),
      path("c", new Date(3000)),
    ]);

    expect(id).toBe("snap-1");
    const payload = addDoc.mock.calls[0][1];
    expect(payload.pathCount).toBe(3);
    expect(payload.watermarkMs).toBe(5000);
    expect(payload.createdAt).toBe("__serverTimestamp__");
    expect(payload.paths).toHaveLength(3);
    expect(payload.paths[0]).toMatchObject({ id: "a", createdAtMs: 1000, tool: "pen" });
    // boardId is implicit in the snapshot; Timestamps become plain ms.
    expect(payload.paths[0]).not.toHaveProperty("boardId");
    expect(payload.paths[0]).not.toHaveProperty("createdAt");
  });

  it("omits bbox for a path that has none", async () => {
    addDoc.mockResolvedValueOnce({ id: "snap-2" });
    await snapshotService.createSnapshot("board-1", [
      path("a", new Date(1000), { bbox: undefined }),
    ]);
    expect(addDoc.mock.calls[0][1].paths[0]).not.toHaveProperty("bbox");
  });

  it("writes a zero watermark for an empty board", async () => {
    addDoc.mockResolvedValueOnce({ id: "snap-3" });
    await snapshotService.createSnapshot("board-1", []);
    const payload = addDoc.mock.calls[0][1];
    expect(payload.pathCount).toBe(0);
    expect(payload.watermarkMs).toBe(0);
  });
});

describe("getLatestSnapshot", () => {
  it("returns null when no snapshot exists", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    expect(await snapshotService.getLatestSnapshot("board-1")).toBeNull();
  });

  it("maps the newest snapshot doc", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        [
          "snap-1",
          {
            paths: [{ id: "a", createdAtMs: 1000 }],
            pathCount: 1,
            watermarkMs: 1000,
            createdAt: ts(now),
          },
        ],
      ])
    );
    const snap = await snapshotService.getLatestSnapshot("board-1");
    expect(snap).toMatchObject({ id: "snap-1", pathCount: 1, watermarkMs: 1000 });
    expect(snap!.createdAt).toEqual(now);
  });
});

describe("loadBoardState", () => {
  it("falls back to a full path replay when no snapshot exists", async () => {
    // 1st getDocs → snapshot query (empty); 2nd → getBoardPaths replay.
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([]))
      .mockResolvedValueOnce(
        makeQuerySnap([
          ["p1", { points: [{ x: 0, y: 0 }], color: "#000", tool: "pen" }],
        ])
      );
    const paths = await snapshotService.loadBoardState("board-1");
    expect(paths).toHaveLength(1);
    expect(paths[0].id).toBe("p1");
  });

  it("merges snapshot paths with the delta, delta winning on id, sorted by time", async () => {
    // 1st getDocs → latest snapshot; 2nd → delta strokes since watermark.
    getDocs
      .mockResolvedValueOnce(
        makeQuerySnap([
          [
            "snap-1",
            {
              paths: [
                { id: "a", userId: "u1", points: [{ x: 0, y: 0 }], color: "#000", strokeWidth: 5, tool: "pen", createdAtMs: 1000 },
                { id: "b", userId: "u1", points: [{ x: 1, y: 1 }], color: "#000", strokeWidth: 5, tool: "pen", createdAtMs: 2000 },
              ],
              pathCount: 2,
              watermarkMs: 2000,
              createdAt: ts(new Date(2000)),
            },
          ],
        ])
      )
      .mockResolvedValueOnce(
        makeQuerySnap([
          // a newer stroke...
          ["c", { points: [{ x: 2, y: 2 }], color: "#f00", tool: "pen", strokeWidth: 5, createdAt: ts(new Date(3000)) }],
          // ...and a re-emitted boundary stroke that should overwrite the snapshot copy
          ["b", { points: [{ x: 9, y: 9 }], color: "#0f0", tool: "pen", strokeWidth: 5, createdAt: ts(new Date(2000)) }],
        ])
      );

    const paths = await snapshotService.loadBoardState("board-1");

    expect(paths.map((p) => p.id)).toEqual(["a", "b", "c"]);
    // delta copy of "b" wins
    expect(paths.find((p) => p.id === "b")!.color).toBe("#0f0");
  });

  it("uses a preloaded snapshot without re-fetching it", async () => {
    // Only the delta query should hit getDocs; the snapshot is supplied directly.
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["c", { points: [{ x: 2, y: 2 }], color: "#f00", tool: "pen", strokeWidth: 5, createdAt: ts(new Date(3000)) }],
      ])
    );
    const preloaded = {
      id: "snap-1",
      boardId: "board-1",
      paths: [
        { id: "a", userId: "u1", points: [{ x: 0, y: 0 }], color: "#000", strokeWidth: 5, tool: "pen" as const, createdAtMs: 1000 },
      ],
      pathCount: 1,
      watermarkMs: 1000,
      createdAt: new Date(1000),
    };
    const paths = await snapshotService.loadBoardState("board-1", preloaded);
    expect(getDocs).toHaveBeenCalledTimes(1);
    expect(paths.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("falls back to a full replay when preloaded snapshot is null", async () => {
    // preloaded === null means "known to have no snapshot" → straight to replay.
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["p1", { points: [{ x: 0, y: 0 }], color: "#000", tool: "pen" }]])
    );
    const paths = await snapshotService.loadBoardState("board-1", null);
    expect(getDocs).toHaveBeenCalledTimes(1);
    expect(paths[0].id).toBe("p1");
  });

  it("skips delta docs missing required fields", async () => {
    getDocs
      .mockResolvedValueOnce(
        makeQuerySnap([
          ["snap-1", { paths: [], pathCount: 0, watermarkMs: 0, createdAt: ts(new Date(0)) }],
        ])
      )
      .mockResolvedValueOnce(
        makeQuerySnap([
          ["good", { points: [{ x: 0, y: 0 }], color: "#000", tool: "pen", createdAt: ts(new Date(10)) }],
          ["bad", { userId: "u2" }],
        ])
      );
    const paths = await snapshotService.loadBoardState("board-1");
    expect(paths.map((p) => p.id)).toEqual(["good"]);
  });
});

describe("pruneSnapshottedPaths", () => {
  it("batch-deletes every supplied path id", async () => {
    const batch = { delete: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);

    await snapshotService.pruneSnapshottedPaths("board-1", ["p1", "p2", "p3"]);

    expect(batch.delete).toHaveBeenCalledTimes(3);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty id list", async () => {
    await snapshotService.pruneSnapshottedPaths("board-1", []);
    expect(fs.writeBatch).not.toHaveBeenCalled();
  });
});
