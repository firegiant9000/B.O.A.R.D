jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, makeDocSnap } from "../../test-utils/firestoreMock";
import * as reactionService from "../reactionService";

const setDoc = fs.setDoc as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const onSnapshot = fs.onSnapshot as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

const baseInput = {
  anchorElementId: "el-1",
  anchorKind: "shape" as const,
  emoji: "👍" as const,
  userId: "u1",
};

describe("reactionDocId", () => {
  it("joins elementId, emoji and userId with underscores — the uniqueness constraint", () => {
    expect(reactionService.reactionDocId("el-1", "👍", "u1")).toBe("el-1_👍_u1");
  });
});

describe("addReaction", () => {
  it("writes schemaVersion, anchor, emoji, userId and a server timestamp at the deterministic doc id", async () => {
    await reactionService.addReaction("b1", baseInput);

    expect((fs.doc as jest.Mock).mock.calls.at(-1)).toEqual([
      {},
      "boards",
      "b1",
      "reactions",
      "el-1_👍_u1",
    ]);
    const payload = setDoc.mock.calls[0][1];
    expect(payload).toMatchObject({
      schemaVersion: 1,
      boardId: "b1",
      anchorElementId: "el-1",
      anchorKind: "shape",
      emoji: "👍",
      userId: "u1",
    });
    expect(payload.createdAt).toBe("__serverTimestamp__");
  });

  it("writes anchorKind as null when the caller doesn't know it (selection-based react)", async () => {
    await reactionService.addReaction("b1", { ...baseInput, anchorKind: undefined });
    expect(setDoc.mock.calls[0][1].anchorKind).toBeNull();
  });
});

describe("removeReaction", () => {
  it("deletes the doc at the deterministic id", async () => {
    await reactionService.removeReaction("b1", "el-1", "👍", "u1");
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect((fs.doc as jest.Mock).mock.calls.at(-1)).toEqual([
      {},
      "boards",
      "b1",
      "reactions",
      "el-1_👍_u1",
    ]);
  });
});

describe("toggleReaction", () => {
  it("creates the doc and returns 'added' when none exists yet", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("el-1_👍_u1", null));

    const result = await reactionService.toggleReaction("b1", baseInput);

    expect(result).toBe("added");
    expect(setDoc).toHaveBeenCalledTimes(1);
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(setDoc.mock.calls[0][1]).toMatchObject({ emoji: "👍", userId: "u1" });
  });

  it("deletes the doc and returns 'removed' when the caller already reacted", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("el-1_👍_u1", { emoji: "👍", userId: "u1" }));

    const result = await reactionService.toggleReaction("b1", baseInput);

    expect(result).toBe("removed");
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(setDoc).not.toHaveBeenCalled();
  });
});

describe("subscribeToBoardReactions", () => {
  it("subscribes and maps incoming docs, dropping ones with no anchorElementId or an unrecognized emoji", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_q, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    const unsub = reactionService.subscribeToBoardReactions("b1", onChange);
    captured(
      makeQuerySnap([
        ["el-1_👍_u1", { anchorElementId: "el-1", anchorKind: "shape", emoji: "👍", userId: "u1" }],
        ["no-anchor", { emoji: "👍", userId: "u2" }], // dropped: no anchorElementId
        ["bad-emoji", { anchorElementId: "el-2", emoji: "🚀", userId: "u3" }], // dropped: not in REACTION_EMOJIS
      ])
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg).toHaveLength(1);
    expect(arg[0]).toMatchObject({ id: "el-1_👍_u1", anchorElementId: "el-1", anchorKind: "shape", emoji: "👍", userId: "u1" });
    expect(typeof unsub).toBe("function");
  });

  it("defaults a missing boardId/userId to an empty string rather than throwing", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_q, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    reactionService.subscribeToBoardReactions("b1", onChange);
    captured(makeQuerySnap([["r1", { anchorElementId: "el-1", emoji: "👍" }]]));

    expect(onChange.mock.calls[0][0][0]).toMatchObject({ boardId: "", userId: "" });
  });

  it("maps a missing/invalid anchorKind to undefined rather than guessing a default kind", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_q, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    reactionService.subscribeToBoardReactions("b1", onChange);
    captured(
      makeQuerySnap([
        ["r1", { anchorElementId: "el-1", anchorKind: "bogus", emoji: "👍", userId: "u1" }],
        ["r2", { anchorElementId: "el-2", emoji: "❤️", userId: "u2" }], // no anchorKind field at all
      ])
    );

    const arg = onChange.mock.calls[0][0];
    expect(arg.find((r: any) => r.id === "r1").anchorKind).toBeUndefined();
    expect(arg.find((r: any) => r.id === "r2").anchorKind).toBeUndefined();
  });
});

describe("clearBoardReactions", () => {
  it("batch-deletes every reaction doc on the board", async () => {
    const batch = { delete: jest.fn(), set: jest.fn(), update: jest.fn(), commit: jest.fn() };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    getDocs.mockResolvedValueOnce(makeQuerySnap([["r1", {}], ["r2", {}]]));

    await reactionService.clearBoardReactions("b1");

    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });
});
