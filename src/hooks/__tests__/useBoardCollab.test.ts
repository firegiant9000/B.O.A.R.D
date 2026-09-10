jest.mock("../../services/cursorService", () => ({
  publishCursor: jest.fn(),
  subscribeToCursors: jest.fn(),
  removeCursor: jest.fn().mockResolvedValue(undefined),
  // Real value (see src/services/cursorService.ts) — the hook's own staleness
  // filter divides against this before any presenter/viewport-source decision.
  CURSOR_STALE_MS: 10000,
}));

jest.mock("../../services/presenceService", () => ({
  joinBoard: jest.fn().mockResolvedValue(undefined),
  leaveBoard: jest.fn().mockResolvedValue(undefined),
  subscribeToBoardPresence: jest.fn(),
}));

import { renderHook, act } from "@testing-library/react-native";
import { useBoardCollab, type BoardCollabOptions } from "../useBoardCollab";
import * as cursorService from "../../services/cursorService";
import * as presenceService from "../../services/presenceService";

const publishCursor = cursorService.publishCursor as jest.Mock;
const subscribeToCursors = cursorService.subscribeToCursors as jest.Mock;
const subscribeToBoardPresence = presenceService.subscribeToBoardPresence as jest.Mock;

// Stable across renders — mirrors production, where `user` comes from
// `useAuth()`'s `useState` (set once per real auth change) and `viewport`'s
// *methods* are stable even though `useViewport()`'s returned object isn't.
// If these were fresh literals per render instead, the churn-fix test below
// would conflate their instability with `onLeaderViewport`'s.
const SELF = { uid: "self" };
const VIEWPORT = { x: 0, y: 0, scale: 1 };

const cursor = (userId: string, extra: object = {}) => ({
  userId,
  displayName: userId,
  x: 0,
  y: 0,
  tool: "pen",
  updatedAt: Date.now(),
  ...extra,
});

function renderCollab(onLeaderViewport: (v: unknown) => void = jest.fn()) {
  return renderHook(
    (opts: { onLeaderViewport: BoardCollabOptions["onLeaderViewport"] }) =>
      useBoardCollab("board1", SELF, {
        displayName: "Self",
        email: "self@example.com",
        activeTool: "pen",
        viewport: VIEWPORT,
        embedMode: false,
        onLeaderViewport: opts.onLeaderViewport,
      }),
    { initialProps: { onLeaderViewport } }
  );
}

/** The `(cursors) => void` callback the hook most recently registered. */
function latestCursorsCallback(): (cursors: unknown[]) => void {
  const calls = subscribeToCursors.mock.calls;
  return calls[calls.length - 1][1];
}

// Every uid used across these tests must appear here, or the (unrelated)
// "stop following if the leader drops presence" effect will immediately
// unfollow them — presence, not the cursor channel, is that effect's source
// of truth for "is this user still around".
const PRESENCE = ["self", "b", "p", "someone"].map((userId) => ({
  userId,
  displayName: userId,
  email: `${userId}@example.com`,
  lastSeen: new Date(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  subscribeToBoardPresence.mockImplementation((_boardId: string, cb: (p: unknown[]) => void) => {
    cb(PRESENCE);
    return jest.fn();
  });
  subscribeToCursors.mockReturnValue(jest.fn());
});

describe("useBoardCollab — presenter precedence (Task 14)", () => {
  it("case 3: with no presenter, individual follow applies", () => {
    const onLeaderViewport = jest.fn();
    const { result } = renderCollab(onLeaderViewport);
    act(() => {
      result.current.toggleFollowUser("b");
    });

    act(() => {
      latestCursorsCallback()([
        cursor("self"),
        cursor("b", { viewport: { x: 10, y: 10, scale: 2 } }),
      ]);
    });

    expect(onLeaderViewport).toHaveBeenCalledWith({ x: 10, y: 10, scale: 2 });
    expect(result.current.activePresenter).toBeNull();
  });

  it("case 1: an active presenter overrides an individual follow choice", () => {
    const onLeaderViewport = jest.fn();
    const { result } = renderCollab(onLeaderViewport);
    act(() => {
      result.current.toggleFollowUser("b");
    });

    act(() => {
      latestCursorsCallback()([
        cursor("self"),
        cursor("b", { viewport: { x: 10, y: 10, scale: 2 } }),
        cursor("p", { presenting: true, viewport: { x: 99, y: 99, scale: 3 } }),
      ]);
    });

    expect(onLeaderViewport).toHaveBeenCalledWith({ x: 99, y: 99, scale: 3 });
    expect(result.current.activePresenter).toEqual({
      userId: "p",
      displayName: "p",
      paused: false,
    });
  });

  it("case 2: a paused presenter releases the viewport but keeps the banner", () => {
    const onLeaderViewport = jest.fn();
    const { result } = renderCollab(onLeaderViewport);
    act(() => {
      result.current.toggleFollowUser("b");
    });

    act(() => {
      latestCursorsCallback()([
        cursor("self"),
        cursor("b", { viewport: { x: 10, y: 10, scale: 2 } }),
        cursor("p", {
          presenting: true,
          presenterPaused: true,
          viewport: { x: 99, y: 99, scale: 3 },
        }),
      ]);
    });

    // Viewport released back to the individual follow choice ("b")...
    expect(onLeaderViewport).toHaveBeenCalledWith({ x: 10, y: 10, scale: 2 });
    expect(onLeaderViewport).not.toHaveBeenCalledWith({ x: 99, y: 99, scale: 3 });
    // ...but the banner stays up, still pointing at the paused presenter.
    expect(result.current.activePresenter).toEqual({
      userId: "p",
      displayName: "p",
      paused: true,
    });
  });

  it("case 4: wouldCreateCycle still guards manual follow", () => {
    const { result } = renderCollab();
    act(() => {
      result.current.toggleFollowUser("b");
    });
    expect(result.current.followingId).toBe("b");

    act(() => {
      // "b" follows "self" — an A<->B cycle.
      latestCursorsCallback()([cursor("self"), cursor("b", { following: "self" })]);
    });

    expect(result.current.followingId).toBeNull();
  });

  it("tolerates an older-shape cursor payload (no presenting/presenterPaused fields)", () => {
    const onLeaderViewport = jest.fn();
    const { result } = renderCollab(onLeaderViewport);
    act(() => {
      result.current.toggleFollowUser("b");
    });

    expect(() => {
      act(() => {
        latestCursorsCallback()([
          // Pre-Task-14 shape: no `presenting`/`presenterPaused` at all.
          { userId: "self", displayName: "Self", x: 0, y: 0, tool: "pen", updatedAt: Date.now() },
          {
            userId: "b",
            displayName: "B",
            x: 0,
            y: 0,
            tool: "pen",
            updatedAt: Date.now(),
            viewport: { x: 5, y: 5, scale: 1 },
          },
        ]);
      });
    }).not.toThrow();

    expect(result.current.activePresenter).toBeNull();
    expect(onLeaderViewport).toHaveBeenCalledWith({ x: 5, y: 5, scale: 1 });
  });
});

describe("useBoardCollab — onLeaderViewport churn decision (Task 14)", () => {
  it("does not resubscribe when the caller passes a fresh onLeaderViewport closure every render", () => {
    const { rerender } = renderCollab(() => {});
    expect(subscribeToCursors).toHaveBeenCalledTimes(1);

    // Mirrors the real screen: a brand-new inline arrow every render.
    rerender({ onLeaderViewport: () => {} });
    rerender({ onLeaderViewport: () => {} });
    rerender({ onLeaderViewport: () => {} });

    expect(subscribeToCursors).toHaveBeenCalledTimes(1);
  });

  it("still calls the latest onLeaderViewport after a closure swap (the ref stays live)", () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = renderCollab(first);
    rerender({ onLeaderViewport: second });

    act(() => {
      latestCursorsCallback()([cursor("self")]);
      // No follow/presenter active yet, so seed one now that the ref has swapped.
    });

    // Establish a follow, then deliver a leader viewport — the *second*
    // closure (current at call time) must be the one invoked, not the first.
    // (renderCollab's initial hook has no follow target here, so trigger via
    // a presenter instead, which needs no extra follow state.)
    act(() => {
      latestCursorsCallback()([cursor("self"), cursor("p", { presenting: true, viewport: { x: 1, y: 2, scale: 1 } })]);
    });

    expect(second).toHaveBeenCalledWith({ x: 1, y: 2, scale: 1 });
    expect(first).not.toHaveBeenCalled();
  });
});

describe("useBoardCollab — presenter actions (Task 14)", () => {
  it("startPresenting publishes presenting:true and clears any existing follow", () => {
    const { result } = renderCollab();
    act(() => {
      result.current.toggleFollowUser("b");
    });
    expect(result.current.followingId).toBe("b");

    act(() => {
      result.current.startPresenting();
    });

    expect(result.current.isPresenting).toBe(true);
    expect(result.current.followingId).toBeNull();
    const lastCall = publishCursor.mock.calls[publishCursor.mock.calls.length - 1];
    expect(lastCall[2]).toMatchObject({ presenting: true, presenterPaused: false });
  });

  it("pausePresenting / resumePresenting toggle isPresenterPaused and publish accordingly", () => {
    const { result } = renderCollab();
    act(() => {
      result.current.startPresenting();
    });

    act(() => {
      result.current.pausePresenting();
    });
    expect(result.current.isPresenterPaused).toBe(true);
    let lastCall = publishCursor.mock.calls[publishCursor.mock.calls.length - 1];
    expect(lastCall[2]).toMatchObject({ presenting: true, presenterPaused: true });

    act(() => {
      result.current.resumePresenting();
    });
    expect(result.current.isPresenterPaused).toBe(false);
    lastCall = publishCursor.mock.calls[publishCursor.mock.calls.length - 1];
    expect(lastCall[2]).toMatchObject({ presenting: true, presenterPaused: false });
  });

  it("stopPresenting publishes presenting:false", () => {
    const { result } = renderCollab();
    act(() => {
      result.current.startPresenting();
    });
    act(() => {
      result.current.stopPresenting();
    });
    expect(result.current.isPresenting).toBe(false);
    const lastCall = publishCursor.mock.calls[publishCursor.mock.calls.length - 1];
    expect(lastCall[2]).toMatchObject({ presenting: false, presenterPaused: false });
  });

  it("toggleFollowUser is a no-op while presenting", () => {
    const { result } = renderCollab();
    act(() => {
      result.current.startPresenting();
    });
    act(() => {
      result.current.toggleFollowUser("someone");
    });
    expect(result.current.followingId).toBeNull();
  });
});
