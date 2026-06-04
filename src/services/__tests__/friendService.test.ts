jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, makeDocSnap, ts } from "../../test-utils/firestoreMock";
import * as friendService from "../friendService";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("sendFriendRequest", () => {
  it("returns not_found when the recipient email has no user", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([])); // getUserByEmail
    expect(
      await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "nobody@x.z")
    ).toBe("not_found");
  });

  it("returns self when targeting your own account", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["u1", { email: "a@x.z" }]]));
    expect(await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "a@x.z")).toBe(
      "self"
    );
  });

  it("returns already_friends when a forward accepted request exists", async () => {
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([["u2", { email: "b@x.z" }]])) // lookup
      .mockResolvedValueOnce(makeQuerySnap([["r1", { status: "accepted" }]])) // fwd
      .mockResolvedValueOnce(makeQuerySnap([])); // rev
    expect(await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "b@x.z")).toBe(
      "already_friends"
    );
  });

  it("returns pending when a reverse pending request exists", async () => {
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([["u2", { email: "b@x.z" }]]))
      .mockResolvedValueOnce(makeQuerySnap([])) // fwd
      .mockResolvedValueOnce(makeQuerySnap([["r1", { status: "pending" }]])); // rev
    expect(await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "b@x.z")).toBe(
      "pending"
    );
  });

  it("creates the request and returns sent when none exists", async () => {
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([["u2", { email: "b@x.z", displayName: "Bo" }]]))
      .mockResolvedValueOnce(makeQuerySnap([]))
      .mockResolvedValueOnce(makeQuerySnap([]));

    const res = await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "b@x.z");

    expect(res).toBe("sent");
    expect(addDoc).toHaveBeenCalledTimes(1);
    expect(addDoc.mock.calls[0][1]).toMatchObject({
      fromId: "u1",
      toId: "u2",
      status: "pending",
    });
  });
});

describe("getFriends", () => {
  it("merges accepted requests from both directions", async () => {
    const now = new Date("2026-01-01");
    getDocs
      .mockResolvedValueOnce(
        makeQuerySnap([["r1", { fromId: "u1", toId: "u2", status: "accepted", createdAt: ts(now) }]])
      )
      .mockResolvedValueOnce(
        makeQuerySnap([["r2", { fromId: "u3", toId: "u1", status: "accepted", createdAt: ts(now) }]])
      );
    const friends = await friendService.getFriends("u1");
    expect(friends.map((f) => f.id)).toEqual(["r1", "r2"]);
  });
});

describe("areFriends", () => {
  it("is true when an accepted request exists in either direction", async () => {
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([])) // dir 1
      .mockResolvedValueOnce(makeQuerySnap([["r1", { status: "accepted" }]])); // dir 2
    expect(await friendService.areFriends("u1", "u2")).toBe(true);
  });

  it("is false when neither direction has an accepted request", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([])).mockResolvedValueOnce(makeQuerySnap([]));
    expect(await friendService.areFriends("u1", "u2")).toBe(false);
  });
});

describe("getBlockedIds", () => {
  it("returns an empty array when the user doc is missing", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));
    expect(await friendService.getBlockedIds("u1")).toEqual([]);
  });

  it("returns the stored blockedIds", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", { blockedIds: ["x", "y"] }));
    expect(await friendService.getBlockedIds("u1")).toEqual(["x", "y"]);
  });
});

describe("getUsersByIds", () => {
  it("short-circuits on an empty list", async () => {
    expect(await friendService.getUsersByIds([])).toEqual([]);
    expect(getDoc).not.toHaveBeenCalled();
  });

  it("skips missing users and defaults missing fields", async () => {
    getDoc
      .mockResolvedValueOnce(makeDocSnap("u1", { displayName: "A", email: "a@x.z" }))
      .mockResolvedValueOnce(makeDocSnap("u2", null))
      .mockResolvedValueOnce(makeDocSnap("u3", {}));
    const users = await friendService.getUsersByIds(["u1", "u2", "u3"]);
    expect(users).toEqual([
      { uid: "u1", displayName: "A", email: "a@x.z" },
      { uid: "u3", displayName: "Unknown", email: "" },
    ]);
  });
});
