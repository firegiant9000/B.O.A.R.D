jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));
// Deterministic reply ids without pulling in the native crypto module.
jest.mock("../../lib/secureRandom", () => ({ randomCode: () => "reply-id" }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, makeDocSnap, ts } from "../../test-utils/firestoreMock";
import * as commentService from "../commentService";

const addDoc = fs.addDoc as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const onSnapshot = fs.onSnapshot as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

const baseInput = {
  anchorElementId: "el-1",
  anchorKind: "shape" as const,
  offsetX: 12,
  offsetY: -4,
  authorId: "u1",
  authorName: "Alice",
  body: "look here",
};

describe("addComment", () => {
  it("writes the anchor + author with empty replies, unresolved, and server timestamps", async () => {
    addDoc.mockResolvedValueOnce({ id: "c-1" });

    const id = await commentService.addComment("b1", baseInput);

    expect(id).toBe("c-1");
    // path: boards/b1/comments
    expect((fs.collection as jest.Mock).mock.calls.at(-1)).toEqual([
      {},
      "boards",
      "b1",
      "comments",
    ]);
    const payload = addDoc.mock.calls[0][1];
    expect(payload).toMatchObject({
      boardId: "b1",
      anchorElementId: "el-1",
      anchorKind: "shape",
      offsetX: 12,
      offsetY: -4,
      authorId: "u1",
      authorName: "Alice",
      body: "look here",
      replies: [],
      resolved: false,
    });
    expect(payload.createdAt).toBe("__serverTimestamp__");
    expect(payload.updatedAt).toBe("__serverTimestamp__");
  });

  it("denormalizes @-mention uids parsed from the body (Phase 10)", async () => {
    addDoc.mockResolvedValueOnce({ id: "c-2" });
    await commentService.addComment("b1", {
      ...baseInput,
      body: "ping @[Bob](u-bob) and @[Cara](u-cara)",
    });
    expect(addDoc.mock.calls[0][1].mentions).toEqual(["u-bob", "u-cara"]);
  });
});

describe("addReply", () => {
  it("arrayUnions a reply with a generated id + client timestamp and bumps updatedAt", async () => {
    const reply = await commentService.addReply("b1", "c-1", {
      authorId: "u2",
      authorName: "Bob",
      body: "agreed",
      createdAtMs: 1700000000000,
    });

    expect(reply).toEqual({
      id: "reply-id",
      authorId: "u2",
      authorName: "Bob",
      body: "agreed",
      mentions: [],
      createdAtMs: 1700000000000,
    });
    const update = updateDoc.mock.calls[0][1];
    expect(update.replies).toEqual({ __type: "arrayUnion", values: [reply] });
    expect(update.updatedAt).toBe("__serverTimestamp__");
  });
});

describe("setResolved", () => {
  it("writes the resolved flag and bumps updatedAt", async () => {
    await commentService.setResolved("b1", "c-1", true);
    const update = updateDoc.mock.calls[0][1];
    expect(update.resolved).toBe(true);
    expect(update.updatedAt).toBe("__serverTimestamp__");
  });
});

describe("deleteComment", () => {
  it("deletes the comment doc", async () => {
    await commentService.deleteComment("b1", "c-1");
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect((fs.doc as jest.Mock).mock.calls.at(-1)).toEqual([
      {},
      "boards",
      "b1",
      "comments",
      "c-1",
    ]);
  });
});

describe("getComment", () => {
  it("returns null when the comment does not exist", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("c-1", null));
    expect(await commentService.getComment("b1", "c-1")).toBeNull();
  });

  it("maps a doc, sorting replies oldest-first and defaulting fields", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("c-1", {
        anchorElementId: "el-1",
        anchorKind: "bogus", // invalid → defaults to "shape"
        body: "hi",
        replies: [
          { id: "r2", authorId: "u2", authorName: "B", body: "second", createdAtMs: 200 },
          { id: "r1", authorId: "u1", authorName: "A", body: "first", createdAtMs: 100 },
        ],
        createdAt: ts(new Date("2026-06-01")),
      })
    );

    const c = await commentService.getComment("b1", "c-1");

    expect(c).not.toBeNull();
    expect(c!.anchorKind).toBe("shape");
    expect(c!.resolved).toBe(false);
    expect(c!.replies.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});

describe("clearBoardComments", () => {
  it("batch-deletes every comment doc on the board", async () => {
    const batch = { delete: jest.fn(), set: jest.fn(), update: jest.fn(), commit: jest.fn() };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    getDocs.mockResolvedValueOnce(makeQuerySnap([["c1", {}], ["c2", {}]]));

    await commentService.clearBoardComments("b1");

    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeToBoardComments", () => {
  it("subscribes and maps incoming docs, dropping anchorless ones", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_q, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    const unsub = commentService.subscribeToBoardComments("b1", onChange);
    captured(
      makeQuerySnap([
        ["c1", { anchorElementId: "el-1", body: "ok", createdAt: ts(new Date()) }],
        ["c2", { body: "no anchor" }], // dropped (no anchorElementId)
      ])
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg).toHaveLength(1);
    expect(arg[0].id).toBe("c1");
    expect(typeof unsub).toBe("function");
  });
});

describe("lastActivityMs", () => {
  it("returns the newest of createdAt/updatedAt and the latest reply", () => {
    const created = new Date("2026-06-01T00:00:00Z");
    const updated = new Date("2026-06-02T00:00:00Z");
    const c = {
      id: "c1",
      boardId: "b1",
      anchorElementId: "el-1",
      anchorKind: "shape" as const,
      offsetX: 0,
      offsetY: 0,
      authorId: "u1",
      authorName: "A",
      body: "x",
      replies: [
        { id: "r1", authorId: "u2", authorName: "B", body: "y", createdAtMs: updated.getTime() + 5000 },
      ],
      resolved: false,
      createdAt: created,
      updatedAt: updated,
    };
    expect(commentService.lastActivityMs(c)).toBe(updated.getTime() + 5000);
  });
});
