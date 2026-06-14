jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { makeQuerySnap } from "../../test-utils/firestoreMock";
import * as activityService from "../activityService";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const onSnapshot = fs.onSnapshot as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("append", () => {
  it("writes the event shape under workspaces/{wsId}/activity with a server timestamp", async () => {
    addDoc.mockResolvedValueOnce({ id: "ev-1" });

    const id = await activityService.append({
      actorId: "u1",
      actorName: "Alice",
      verb: "board.created",
      targetType: "board",
      targetId: "b1",
      workspaceId: "ws1",
      boardId: "b1",
      meta: { title: "My Board" },
    });

    expect(id).toBe("ev-1");
    // path: workspaces/ws1/activity
    expect((fs.collection as jest.Mock).mock.calls.at(-1)).toEqual([
      {},
      "workspaces",
      "ws1",
      "activity",
    ]);
    const payload = addDoc.mock.calls[0][1];
    expect(payload).toMatchObject({
      actorId: "u1",
      actorName: "Alice",
      verb: "board.created",
      targetType: "board",
      targetId: "b1",
      workspaceId: "ws1",
      boardId: "b1",
      meta: { title: "My Board" },
    });
    expect(payload.createdAt).toBe("__serverTimestamp__");
  });

  it("is a no-op for an empty workspaceId (legacy/unscoped) and writes nothing", async () => {
    const id = await activityService.append({
      actorId: "u1",
      actorName: "Alice",
      verb: "board.created",
      targetType: "board",
      targetId: "b1",
      workspaceId: "",
    });

    expect(id).toBeNull();
    expect(addDoc).not.toHaveBeenCalled();
  });

  it("defaults meta to {} and omits boardId when absent", async () => {
    addDoc.mockResolvedValueOnce({ id: "ev-2" });

    await activityService.append({
      actorId: "u1",
      actorName: "Alice",
      verb: "session.ended",
      targetType: "session",
      targetId: "s1",
      workspaceId: "ws1",
    });

    const payload = addDoc.mock.calls[0][1];
    expect(payload.meta).toEqual({});
    expect("boardId" in payload).toBe(false);
  });
});

describe("safeAppend", () => {
  it("swallows a write failure so the triggering mutation is never affected", async () => {
    addDoc.mockRejectedValueOnce(new Error("permission-denied"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      activityService.safeAppend({
        actorId: "u1",
        actorName: "Alice",
        verb: "board.created",
        targetType: "board",
        targetId: "b1",
        workspaceId: "ws1",
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("convenience builders", () => {
  it("logBoardCreated carries the board title in meta", async () => {
    addDoc.mockResolvedValueOnce({ id: "ev-3" });
    await activityService.logBoardCreated({
      workspaceId: "ws1",
      boardId: "b1",
      actorId: "u1",
      actorName: "Alice",
      title: "Calc HW",
    });
    const payload = addDoc.mock.calls[0][1];
    expect(payload.verb).toBe("board.created");
    expect(payload.meta).toEqual({ title: "Calc HW" });
  });

  it("logSessionEnded carries the participant count in meta", async () => {
    addDoc.mockResolvedValueOnce({ id: "ev-4" });
    await activityService.logSessionEnded({
      workspaceId: "ws1",
      boardId: "b1",
      sessionId: "s1",
      actorId: "u1",
      actorName: "Alice",
      participantCount: 3,
      title: "Standup",
    });
    const payload = addDoc.mock.calls[0][1];
    expect(payload.verb).toBe("session.ended");
    expect(payload.meta).toMatchObject({ participantCount: 3, title: "Standup" });
  });
});

describe("reads", () => {
  it("getWorkspaceActivity orders newest-first and maps docs", async () => {
    const created = new Date("2026-01-02T00:00:00Z");
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        [
          "ev-1",
          {
            actorId: "u1",
            actorName: "Alice",
            verb: "board.created",
            targetType: "board",
            targetId: "b1",
            workspaceId: "ws1",
            boardId: "b1",
            meta: { title: "B" },
            createdAt: { toDate: () => created },
          },
        ],
      ])
    );

    const events = await activityService.getWorkspaceActivity("ws1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "ev-1", actorName: "Alice", verb: "board.created" });
    expect(events[0].createdAt).toEqual(created);
    // ordered by createdAt desc
    const orderByCalls = (fs.orderBy as jest.Mock).mock.calls;
    expect(orderByCalls.at(-1)).toEqual(["createdAt", "desc"]);
  });

  it("getBoardActivity filters by boardId and orders newest-first", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));

    await activityService.getBoardActivity("ws1", "b1");

    expect((fs.where as jest.Mock).mock.calls.at(-1)).toEqual(["boardId", "==", "b1"]);
    expect((fs.orderBy as jest.Mock).mock.calls.at(-1)).toEqual(["createdAt", "desc"]);
  });

  it("subscribeToBoardActivity wires an onSnapshot listener and returns its unsubscribe", () => {
    const unsub = jest.fn();
    onSnapshot.mockReturnValueOnce(unsub);
    const cb = jest.fn();

    const result = activityService.subscribeToBoardActivity("ws1", "b1", cb);

    expect(onSnapshot).toHaveBeenCalled();
    expect(result).toBe(unsub);
  });
});
