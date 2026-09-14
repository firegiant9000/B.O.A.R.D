jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
// The recipient lookup is a Cloud Function call now, not a `users` query:
// firestore.rules denies `list` on that collection (it carries email
// addresses). Mocking the service seam rather than `firebase/functions` keeps
// these tests about `sendFriendRequest`'s own branching; the callable binding
// itself is pinned in userService.test.ts.
jest.mock("../userService", () => ({ lookupUserByEmail: jest.fn() }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, makeDocSnap, ts } from "../../test-utils/firestoreMock";
import { lookupUserByEmail } from "../userService";
import * as friendService from "../friendService";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const lookup = lookupUserByEmail as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("sendFriendRequest", () => {
  it("returns not_found when the recipient email has no user", async () => {
    lookup.mockResolvedValueOnce(null);
    expect(
      await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "nobody@x.z")
    ).toBe("not_found");
  });

  it("returns self when targeting your own account", async () => {
    lookup.mockResolvedValueOnce({ uid: "u1", displayName: "Arlo", email: "a@x.z" });
    expect(await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "a@x.z")).toBe(
      "self"
    );
  });

  it("returns already_friends when a forward accepted request exists", async () => {
    lookup.mockResolvedValueOnce({ uid: "u2", displayName: "Bo", email: "b@x.z" });
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([["r1", { status: "accepted" }]])) // fwd
      .mockResolvedValueOnce(makeQuerySnap([])); // rev
    expect(await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "b@x.z")).toBe(
      "already_friends"
    );
  });

  it("returns pending when a reverse pending request exists", async () => {
    lookup.mockResolvedValueOnce({ uid: "u2", displayName: "Bo", email: "b@x.z" });
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([])) // fwd
      .mockResolvedValueOnce(makeQuerySnap([["r1", { status: "pending" }]])); // rev
    expect(await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "b@x.z")).toBe(
      "pending"
    );
  });

  it("creates the request and returns sent when none exists", async () => {
    lookup.mockResolvedValueOnce({ uid: "u2", displayName: "Bo", email: "b@x.z" });
    getDocs.mockResolvedValueOnce(makeQuerySnap([])).mockResolvedValueOnce(makeQuerySnap([]));

    const res = await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "b@x.z");

    expect(res).toBe("sent");
    expect(addDoc).toHaveBeenCalledTimes(1);
    expect(addDoc.mock.calls[0][1]).toMatchObject({
      fromId: "u1",
      toId: "u2",
      toDisplayName: "Bo",
      toEmail: "b@x.z",
      status: "pending",
    });
  });

  it("looks the recipient up through the callable, never through a users query", async () => {
    // The regression guard for the disclosure this replaced: a `users` query
    // here would be denied outright now that firestore.rules refuses `list` on
    // that collection, and would have dumped every registered email before it.
    lookup.mockResolvedValueOnce(null);

    await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "nobody@x.z");

    expect(lookup).toHaveBeenCalledWith("nobody@x.z");
    expect(getDocs).not.toHaveBeenCalled();
  });

  it("passes the address through unnormalized — friend search used to skip the lowercase/trim", async () => {
    // This call site was the odd one out: boardService and workspaceService
    // lowercased and trimmed, friendService did neither, so `Bob@X.Z` found
    // nobody here and found Bob through a board invite. Normalization now
    // happens once, server-side, which is why the raw string goes over.
    lookup.mockResolvedValueOnce(null);

    await friendService.sendFriendRequest("u1", "Arlo", "a@x.z", "  BoB@X.Z ");

    expect(lookup).toHaveBeenCalledWith("  BoB@X.Z ");
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
