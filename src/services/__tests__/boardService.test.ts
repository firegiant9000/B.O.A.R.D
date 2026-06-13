jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { auth } from "../../config/firebase";
import { makeQuerySnap, makeDocSnap, ts } from "../../test-utils/firestoreMock";
import * as boardService from "../boardService";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (auth as { currentUser: unknown }).currentUser = null;
});

describe("createBoard", () => {
  it("creates the board with owner as sole member and a BORD- invite code", async () => {
    addDoc.mockResolvedValueOnce({ id: "board-1" });

    const id = await boardService.createBoard("My Board", "owner-1");

    expect(id).toBe("board-1");
    const payload = addDoc.mock.calls[0][1];
    expect(payload).toMatchObject({
      title: "My Board",
      ownerId: "owner-1",
      adminId: "owner-1",
      members: ["owner-1"],
    });
    expect(payload.inviteCode).toMatch(/^BORD-[A-Z0-9]{6}$/);
  });
});

describe("getMemberBoards", () => {
  it("maps boards and sorts by updatedAt descending", async () => {
    const older = new Date("2026-01-01");
    const newer = new Date("2026-02-01");
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["a", { title: "A", updatedAt: ts(older) }],
        ["b", { title: "B", updatedAt: ts(newer) }],
      ])
    );

    const boards = await boardService.getMemberBoards("u1");

    expect(boards.map((b) => b.id)).toEqual(["b", "a"]);
  });
});

describe("getBoard", () => {
  it("returns null when the board does not exist", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("board-1", null));
    expect(await boardService.getBoard("board-1")).toBeNull();
  });

  it("applies sensible defaults to a sparse doc", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("board-1", { ownerId: "o1" }));
    const board = await boardService.getBoard("board-1");
    expect(board).toMatchObject({ id: "board-1", title: "Untitled", adminId: "o1" });
  });

  it("defaults backgroundTemplate to blank when absent or invalid", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("board-1", { ownerId: "o1" }));
    expect((await boardService.getBoard("board-1"))?.backgroundTemplate).toBe("blank");

    getDoc.mockResolvedValueOnce(
      makeDocSnap("board-1", { ownerId: "o1", backgroundTemplate: "squares" })
    );
    expect((await boardService.getBoard("board-1"))?.backgroundTemplate).toBe("blank");
  });

  it("maps a valid backgroundTemplate through", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("board-1", { ownerId: "o1", backgroundTemplate: "coordinate" })
    );
    expect((await boardService.getBoard("board-1"))?.backgroundTemplate).toBe("coordinate");
  });
});

describe("updateBoard", () => {
  it("persists the backgroundTemplate alongside an updatedAt bump", async () => {
    await boardService.updateBoard("board-1", { backgroundTemplate: "dots" });
    const update = updateDoc.mock.calls[0][1];
    expect(update.backgroundTemplate).toBe("dots");
    expect(update.updatedAt).toBeDefined();
  });
});

describe("leaveBoard", () => {
  it("throws when not signed in", async () => {
    await expect(boardService.leaveBoard("board-1")).rejects.toThrow(/signed in/i);
  });

  it("removes the current user from members", async () => {
    (auth as { currentUser: unknown }).currentUser = { uid: "u1" };
    await boardService.leaveBoard("board-1");
    const update = updateDoc.mock.calls[0][1];
    expect(update.members).toEqual({ __type: "arrayRemove", values: ["u1"] });
  });
});

describe("addMemberByEmail", () => {
  it("returns not_found when no user has that email", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    expect(await boardService.addMemberByEmail("board-1", "x@y.z")).toEqual({
      result: "not_found",
    });
  });

  it("returns already_member when the user is already on the board", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["u2", { email: "x@y.z" }]]));
    getDoc.mockResolvedValueOnce(makeDocSnap("board-1", { members: ["u2"] }));

    expect(await boardService.addMemberByEmail("board-1", "x@y.z")).toEqual({
      result: "already_member",
      uid: "u2",
    });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("adds the user and returns added otherwise", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["u2", { email: "x@y.z" }]]));
    getDoc.mockResolvedValueOnce(makeDocSnap("board-1", { members: ["u1"] }));

    const res = await boardService.addMemberByEmail("board-1", "X@Y.Z");

    expect(res).toEqual({ result: "added", uid: "u2" });
    expect(updateDoc).toHaveBeenCalledTimes(1);
  });
});

describe("joinBoardByCode", () => {
  it("throws when not signed in", async () => {
    await expect(boardService.joinBoardByCode("bord-aaaaaa")).rejects.toThrow(/signed in/i);
  });

  it("normalizes the code to upper-case and throws when no match", async () => {
    (auth as { currentUser: unknown }).currentUser = { uid: "u1" };
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));

    await expect(boardService.joinBoardByCode("  bord-zzzzzz ")).rejects.toThrow(
      /no board found/i
    );
    expect((fs.where as jest.Mock).mock.calls.at(-1)).toEqual([
      "inviteCode",
      "==",
      "BORD-ZZZZZZ",
    ]);
  });

  it("returns alreadyMember without writing when the user is already a member", async () => {
    (auth as { currentUser: unknown }).currentUser = { uid: "u1" };
    getDocs.mockResolvedValueOnce(makeQuerySnap([["board-1", { members: ["u1"] }]]));

    const res = await boardService.joinBoardByCode("BORD-AAAAAA");

    expect(res).toEqual({ boardId: "board-1", alreadyMember: true });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("adds the user when not yet a member", async () => {
    (auth as { currentUser: unknown }).currentUser = { uid: "u9" };
    getDocs.mockResolvedValueOnce(makeQuerySnap([["board-1", { members: ["u1"] }]]));

    const res = await boardService.joinBoardByCode("BORD-AAAAAA");

    expect(res).toEqual({ boardId: "board-1", alreadyMember: false });
    expect(updateDoc).toHaveBeenCalledTimes(1);
  });
});

describe("getBoardByInviteCode", () => {
  it("normalizes the code and returns null when no board matches", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));

    expect(await boardService.getBoardByInviteCode("  bord-zzzzzz ")).toBeNull();
    expect((fs.where as jest.Mock).mock.calls.at(-1)).toEqual([
      "inviteCode",
      "==",
      "BORD-ZZZZZZ",
    ]);
  });

  it("maps and returns the board when found", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["board-7", { title: "Shared", inviteCode: "BORD-AAAAAA" }]]));

    const board = await boardService.getBoardByInviteCode("BORD-AAAAAA");

    expect(board).toMatchObject({ id: "board-7", title: "Shared", inviteCode: "BORD-AAAAAA" });
  });
});

describe("deleteBoard", () => {
  it("clears every subcollection then deletes the board doc", async () => {
    // getDocs is called once per subcollection (paths, notes, presence, textElements)
    getDocs.mockResolvedValue(makeQuerySnap([]));
    await boardService.deleteBoard("board-1");
    expect(getDocs).toHaveBeenCalledTimes(4);
    expect(fs.deleteDoc).toHaveBeenCalledTimes(1);
  });
});
