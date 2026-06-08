jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, ts } from "../../test-utils/firestoreMock";
import * as presenceService from "../presenceService";

const setDoc = fs.setDoc as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const onSnapshot = fs.onSnapshot as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("joinBoard", () => {
  it("writes a full presence doc with timestamps", async () => {
    await presenceService.joinBoard("board-1", "u1", "Arlo", "a@x.z");
    const [ref, data] = setDoc.mock.calls[0];
    expect(ref.path).toEqual(["boards", "board-1", "presence", "u1"]);
    expect(data).toMatchObject({ userId: "u1", displayName: "Arlo", email: "a@x.z" });
    expect(data.lastActive).toBe("__serverTimestamp__");
  });
});

describe("leaveBoard", () => {
  it("deletes the presence doc", async () => {
    await presenceService.leaveBoard("board-1", "u1");
    expect(deleteDoc.mock.calls[0][0].path).toEqual([
      "boards",
      "board-1",
      "presence",
      "u1",
    ]);
  });
});

describe("updatePresence", () => {
  it("merges only lastActive", async () => {
    await presenceService.updatePresence("board-1", "u1");
    const [, data, options] = setDoc.mock.calls[0];
    expect(data).toEqual({ lastActive: "__serverTimestamp__" });
    expect(options).toEqual({ merge: true });
  });
});

describe("subscribeToPresence", () => {
  it("builds a uid → lastActive map and returns the unsubscribe", () => {
    const now = new Date("2026-05-01");
    const unsub = jest.fn();
    onSnapshot.mockImplementationOnce((_ref, cb) => {
      cb(makeQuerySnap([["u1", { lastActive: ts(now) }], ["u2", {}]]));
      return unsub;
    });

    const cb = jest.fn();
    const returned = presenceService.subscribeToPresence("board-1", cb);

    expect(cb).toHaveBeenCalledWith({ u1: now });
    expect(returned).toBe(unsub);
  });
});
