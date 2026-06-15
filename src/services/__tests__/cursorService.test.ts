jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {} }));

import * as fs from "firebase/firestore";
import { makeQuerySnap } from "../../test-utils/firestoreMock";
import {
  publishCursor,
  subscribeToCursors,
  removeCursor,
  visibleCursors,
  CURSOR_STALE_MS,
} from "../cursorService";

const setDoc = fs.setDoc as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const onSnapshot = fs.onSnapshot as jest.Mock;

jest.useFakeTimers();

beforeEach(() => {
  jest.clearAllMocks();
  jest.clearAllTimers();
});

describe("publishCursor", () => {
  it("throttles writes: one immediate write, the rest coalesced to a single trailing write", async () => {
    // Unique ids per test so the module-level throttle registry doesn't leak.
    publishCursor("b1", "u1", { displayName: "U1", x: 1, y: 1, tool: "pen" });
    publishCursor("b1", "u1", { displayName: "U1", x: 2, y: 2, tool: "pen" });
    publishCursor("b1", "u1", { displayName: "U1", x: 3, y: 3, tool: "pen" });
    expect(setDoc).toHaveBeenCalledTimes(1); // leading edge only

    jest.advanceTimersByTime(50);
    expect(setDoc).toHaveBeenCalledTimes(2); // trailing flush
    // Trailing write carries the latest position.
    expect(setDoc.mock.calls[1][1]).toMatchObject({ x: 3, y: 3 });
    await Promise.resolve();
  });
});

describe("subscribeToCursors", () => {
  it("maps snapshot docs to CursorPresence, tolerating missing fields", () => {
    let received: any[] = [];
    onSnapshot.mockImplementation((_ref: unknown, cb: (snap: unknown) => void) => {
      cb(
        makeQuerySnap([
          ["u2", { userId: "u2", displayName: "Two", x: 5, y: 6, tool: "pen", updatedAt: 100 }],
          ["u3", {}], // legacy / partial doc
        ])
      );
      return jest.fn();
    });

    const unsub = subscribeToCursors("b2", (cursors) => {
      received = cursors;
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ userId: "u2", x: 5, y: 6, tool: "pen" });
    expect(received[1]).toMatchObject({ userId: "u3", x: 0, y: 0, tool: "pen", updatedAt: 0 });
    expect(typeof unsub).toBe("function");
  });
});

describe("removeCursor", () => {
  it("deletes the cursor doc", async () => {
    await removeCursor("b3", "u4");
    expect(deleteDoc).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending throttled write so no cursor is re-created after leave", async () => {
    publishCursor("b4", "u5", { displayName: "U5", x: 1, y: 1, tool: "pen" }); // leading
    publishCursor("b4", "u5", { displayName: "U5", x: 2, y: 2, tool: "pen" }); // pending
    expect(setDoc).toHaveBeenCalledTimes(1);
    await removeCursor("b4", "u5");
    jest.advanceTimersByTime(50);
    expect(setDoc).toHaveBeenCalledTimes(1); // trailing write was cancelled
  });
});

describe("visibleCursors", () => {
  const now = 1_000_000;
  const fresh = (id: string) => ({
    userId: id,
    displayName: id,
    x: 0,
    y: 0,
    tool: "pen",
    updatedAt: now,
  });

  it("drops the viewer's own cursor", () => {
    const out = visibleCursors([fresh("me"), fresh("them")], "me", [], now);
    expect(out.map((c) => c.userId)).toEqual(["them"]);
  });

  it("drops blocked users", () => {
    const out = visibleCursors([fresh("a"), fresh("b")], "me", ["a"], now);
    expect(out.map((c) => c.userId)).toEqual(["b"]);
  });

  it("drops stale cursors", () => {
    const stale = { ...fresh("old"), updatedAt: now - CURSOR_STALE_MS - 1 };
    const out = visibleCursors([stale, fresh("live")], "me", [], now);
    expect(out.map((c) => c.userId)).toEqual(["live"]);
  });
});
