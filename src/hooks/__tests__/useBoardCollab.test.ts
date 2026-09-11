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
const joinBoard = presenceService.joinBoard as jest.Mock;

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

function renderCollab(
  onLeaderViewport: (v: unknown) => void = jest.fn(),
  activeTool: BoardCollabOptions["activeTool"] = "pen"
) {
  return renderHook(
    (opts: { onLeaderViewport: BoardCollabOptions["onLeaderViewport"] }) =>
      useBoardCollab("board1", SELF, {
        displayName: "Self",
        email: "self@example.com",
        activeTool,
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

describe("useBoardCollab — presenter viewport precedence", () => {
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
    // The single source of truth every content-creation gate reads.
    expect(result.current.presenterLocksContentCreation).toBe(true);
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
    // A pause releases the viewport (above) *and* the content-creation lock —
    // both derive from the same "unpaused and active" condition.
    expect(result.current.presenterLocksContentCreation).toBe(false);
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

describe("useBoardCollab — onLeaderViewport subscription stability", () => {
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

    // Deliver a presenter's viewport now that the ref has swapped — the
    // *second* closure (current at call time) must be the one invoked, not
    // the first.
    act(() => {
      latestCursorsCallback()([cursor("self"), cursor("p", { presenting: true, viewport: { x: 1, y: 2, scale: 1 } })]);
    });

    expect(second).toHaveBeenCalledWith({ x: 1, y: 2, scale: 1 });
    expect(first).not.toHaveBeenCalled();
  });
});

describe("useBoardCollab — viewport dedupe", () => {
  it("calls onLeaderViewport once for a repeated leader viewport, again only on a real change", () => {
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
    expect(onLeaderViewport).toHaveBeenCalledTimes(1);

    // "b"'s throttled cursor writes repeat the same viewport frame after frame
    // while they're stationary — without the dedupe this would call through
    // again and restart animateTo's ease every delivery.
    act(() => {
      latestCursorsCallback()([
        cursor("self"),
        cursor("b", { viewport: { x: 10, y: 10, scale: 2 } }),
      ]);
    });
    expect(onLeaderViewport).toHaveBeenCalledTimes(1);

    // A genuine change still calls through.
    act(() => {
      latestCursorsCallback()([
        cursor("self"),
        cursor("b", { viewport: { x: 20, y: 20, scale: 2 } }),
      ]);
    });
    expect(onLeaderViewport).toHaveBeenCalledTimes(2);
    expect(onLeaderViewport).toHaveBeenLastCalledWith({ x: 20, y: 20, scale: 2 });
  });
});

describe("useBoardCollab — presenter actions", () => {
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

describe("useBoardCollab — laser ping (Month 5)", () => {
  it("publishPointer attaches a ping when pressed and the laser tool is active", () => {
    const { result } = renderCollab(jest.fn(), "laser");
    act(() => {
      result.current.publishPointer({ x: 3, y: 4 }, true);
    });
    const lastCall = publishCursor.mock.calls[publishCursor.mock.calls.length - 1];
    expect(lastCall[2]).toMatchObject({ ping: { x: 3, y: 4 } });
    expect(typeof lastCall[2].ping.t).toBe("number");
  });

  // Fix round 1: a plain web hover (nothing pressed) reached `publishPointer`
  // the same as a real drag, so the laser painted a continuous trail with no
  // press at all and an isolated tap was unreachable (hover before/after it
  // had already seeded one). `pressed: false` is exactly that hover case —
  // it must never seed a ping regardless of the active tool.
  it("publishPointer sends no ping for a hover (pressed: false), even with the laser tool active", () => {
    const { result } = renderCollab(jest.fn(), "laser");
    act(() => {
      result.current.publishPointer({ x: 3, y: 4 }, false);
    });
    const lastCall = publishCursor.mock.calls[publishCursor.mock.calls.length - 1];
    expect(lastCall[2].ping).toBeUndefined();
  });

  it("publishPointer sends no ping for every other tool, even when pressed", () => {
    const { result } = renderCollab(jest.fn(), "pen");
    act(() => {
      result.current.publishPointer({ x: 1, y: 1 }, true);
    });
    const lastCall = publishCursor.mock.calls[publishCursor.mock.calls.length - 1];
    // `undefined`, not omitted — same convention this payload already uses for
    // `viewport`/`following` above; `cursorService.ts`'s `writerFor` is the one
    // place that turns "undefined" into "omitted from the doc" (see its tests).
    expect(lastCall[2].ping).toBeUndefined();
  });
});

describe("useBoardCollab — embed mode (Month 4 read-only / Month 5 editable)", () => {
  function renderEmbed(embedEditable: boolean) {
    return renderHook(() =>
      useBoardCollab("board1", SELF, {
        displayName: "Self",
        email: "self@example.com",
        activeTool: "pen",
        viewport: VIEWPORT,
        embedMode: true,
        embedEditable,
        onLeaderViewport: jest.fn(),
      })
    );
  }

  it("suppresses publishPointer for a view-scope embed session (embedEditable: false)", () => {
    const { result } = renderEmbed(false);
    act(() => {
      result.current.publishPointer({ x: 1, y: 1 }, true);
    });
    expect(publishCursor).not.toHaveBeenCalled();
  });

  it("lets an edit-scope embed session (embedEditable: true) publish its own cursor", () => {
    const { result } = renderEmbed(true);
    act(() => {
      result.current.publishPointer({ x: 1, y: 1 }, true);
    });
    expect(publishCursor).toHaveBeenCalledWith(
      "board1",
      "self",
      expect.objectContaining({ x: 1, y: 1 })
    );
  });

  it("never joins presence for an embed session, edit-scope or not", () => {
    renderEmbed(true);
    expect(joinBoard).not.toHaveBeenCalled();
  });

  it("still suppresses presence when embedEditable is omitted (defaults closed, matches a view embed)", () => {
    renderHook(() =>
      useBoardCollab("board1", SELF, {
        displayName: "Self",
        email: "self@example.com",
        activeTool: "pen",
        viewport: VIEWPORT,
        embedMode: true,
        onLeaderViewport: jest.fn(),
      })
    );
    expect(joinBoard).not.toHaveBeenCalled();
  });

  it("broadcasts the viewport for an edit-scope embed when the camera moves (not just on pointer publish)", () => {
    const { result, rerender } = renderHook(
      (props: { viewport: BoardCollabOptions["viewport"] }) =>
        useBoardCollab("board1", SELF, {
          displayName: "Self",
          email: "self@example.com",
          activeTool: "pen",
          viewport: props.viewport,
          embedMode: true,
          embedEditable: true,
          onLeaderViewport: jest.fn(),
        }),
      { initialProps: { viewport: VIEWPORT } }
    );

    // The viewport-broadcast effect only fires once a pointer has been seen
    // (`hasPointerRef`) — same precondition as the non-embed path.
    act(() => {
      result.current.publishPointer({ x: 2, y: 2 }, true);
    });
    publishCursor.mockClear();

    rerender({ viewport: { x: 10, y: 10, scale: 2 } });

    expect(publishCursor).toHaveBeenCalledWith(
      "board1",
      "self",
      expect.objectContaining({ x: 2, y: 2, viewport: { x: 10, y: 10, scale: 2 } })
    );
  });

  it("does NOT broadcast the viewport for a view-scope embed even after a pointer is seen", () => {
    // publishPointer itself is a no-op for a view-scope embed (asserted
    // above), so there is no pointer to seed here — this pins that the
    // viewport-broadcast effect's own guard is independently closed too,
    // not merely unreachable because publishPointer never ran.
    const { rerender } = renderHook(
      (props: { viewport: BoardCollabOptions["viewport"] }) =>
        useBoardCollab("board1", SELF, {
          displayName: "Self",
          email: "self@example.com",
          activeTool: "pen",
          viewport: props.viewport,
          embedMode: true,
          embedEditable: false,
          onLeaderViewport: jest.fn(),
        }),
      { initialProps: { viewport: VIEWPORT } }
    );

    rerender({ viewport: { x: 10, y: 10, scale: 2 } });

    expect(publishCursor).not.toHaveBeenCalled();
  });
});
