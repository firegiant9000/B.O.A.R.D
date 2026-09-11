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
  CURSOR_WRITE_INTERVAL_MS,
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

  it("maps presenting/presenterPaused, defaulting a pre-presenter-mode doc to false (Month 5)", () => {
    let received: any[] = [];
    onSnapshot.mockImplementation((_ref: unknown, cb: (snap: unknown) => void) => {
      cb(
        makeQuerySnap([
          [
            "u8",
            {
              userId: "u8",
              displayName: "Presenter",
              x: 0,
              y: 0,
              tool: "pen",
              updatedAt: 1,
              presenting: true,
              presenterPaused: true,
            },
          ],
          // Older-shape doc from a client that predates presenter mode.
          ["u9", { userId: "u9", displayName: "Old", x: 0, y: 0, tool: "pen", updatedAt: 1 }],
        ])
      );
      return jest.fn();
    });

    subscribeToCursors("b7", (cursors) => {
      received = cursors;
    });

    expect(received[0]).toMatchObject({ presenting: true, presenterPaused: true });
    expect(received[1]).toMatchObject({ presenting: false, presenterPaused: false });
  });
});

describe("subscribeToCursors — A.6 listener multiplexing (Month 5)", () => {
  it("multiplexes two subscribers on one board into a single onSnapshot call, fanning out to both", () => {
    onSnapshot.mockImplementation((_ref: unknown, cb: (snap: unknown) => void) => {
      cb(makeQuerySnap([["u10", { userId: "u10", displayName: "Ten", x: 1, y: 1, tool: "pen", updatedAt: 1 }]]));
      return jest.fn();
    });

    let receivedA: any[] = [];
    let receivedB: any[] = [];
    const unsubA = subscribeToCursors("mux1", (cursors) => { receivedA = cursors; });
    const unsubB = subscribeToCursors("mux1", (cursors) => { receivedB = cursors; });

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(receivedA).toHaveLength(1);
    expect(receivedA[0]).toMatchObject({ userId: "u10" });
    expect(receivedB).toEqual(receivedA);

    unsubA();
    unsubB();
  });

  it("keeps the surviving subscriber live after one unsubscribes, without opening a second onSnapshot", () => {
    let deliver: (snap: unknown) => void = () => {};
    onSnapshot.mockImplementation((_ref: unknown, cb: (snap: unknown) => void) => {
      deliver = cb;
      cb(makeQuerySnap([]));
      return jest.fn();
    });

    let receivedA: any[] | null = null;
    let receivedB: any[] | null = null;
    const unsubA = subscribeToCursors("mux2", (cursors) => { receivedA = cursors; });
    const unsubB = subscribeToCursors("mux2", (cursors) => { receivedB = cursors; });

    unsubA();
    receivedA = null;
    receivedB = null;
    deliver(
      makeQuerySnap([["u11", { userId: "u11", displayName: "Eleven", x: 0, y: 0, tool: "pen", updatedAt: 1 }]])
    );

    expect(onSnapshot).toHaveBeenCalledTimes(1); // still the one underlying listener
    expect(receivedA).toBeNull(); // the detached subscriber gets nothing more
    expect(receivedB).not.toBeNull();
    expect(receivedB![0]).toMatchObject({ userId: "u11" });

    unsubB();
  });

  it("calls the underlying unsubscribe only once the last local subscriber detaches", () => {
    const underlyingUnsub = jest.fn();
    onSnapshot.mockImplementation((_ref: unknown, cb: (snap: unknown) => void) => {
      cb(makeQuerySnap([]));
      return underlyingUnsub;
    });

    const unsubA = subscribeToCursors("mux3", () => {});
    const unsubB = subscribeToCursors("mux3", () => {});

    unsubA();
    expect(underlyingUnsub).not.toHaveBeenCalled();

    unsubB();
    expect(underlyingUnsub).toHaveBeenCalledTimes(1);

    // Idempotent: detaching an already-detached subscriber is a no-op, not a
    // second teardown call.
    unsubB();
    expect(underlyingUnsub).toHaveBeenCalledTimes(1);
  });

  it("gives a second board its own onSnapshot listener rather than sharing the first board's", () => {
    onSnapshot.mockImplementation((_ref: unknown, cb: (snap: unknown) => void) => {
      cb(makeQuerySnap([]));
      return jest.fn();
    });

    const unsubA = subscribeToCursors("mux4", () => {});
    const unsubB = subscribeToCursors("mux5", () => {});

    expect(onSnapshot).toHaveBeenCalledTimes(2);

    unsubA();
    unsubB();
  });
});

describe("publishCursor — presenter fields (Month 5)", () => {
  it("omits presenting/presenterPaused from the written doc when false", () => {
    publishCursor("b5", "u6", {
      displayName: "U6",
      x: 0,
      y: 0,
      tool: "pen",
      presenting: false,
      presenterPaused: false,
    });
    const written = setDoc.mock.calls[0][1];
    expect(written).not.toHaveProperty("presenting");
    expect(written).not.toHaveProperty("presenterPaused");
  });

  it("writes presenting/presenterPaused when true", () => {
    publishCursor("b6", "u7", {
      displayName: "U7",
      x: 0,
      y: 0,
      tool: "pen",
      presenting: true,
      presenterPaused: true,
    });
    const written = setDoc.mock.calls[0][1];
    expect(written).toMatchObject({ presenting: true, presenterPaused: true });
  });

  it("does not change the write ceiling — CURSOR_WRITE_INTERVAL_MS is untouched", () => {
    expect(CURSOR_WRITE_INTERVAL_MS).toBe(50);
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
