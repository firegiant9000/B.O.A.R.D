// The cursor side channel is CursorLayer's own subscription — stub it so
// mounting never reaches real Firestore. `visibleCursors` reimplements just
// the self-exclusion its real counterpart does (blocked/stale filtering is
// already covered in cursorService.test.ts and every fixture below is fresh
// and unblocked) — real enough to exercise fix round 1's self-vs-others
// distinction below. `trailEligibleCursors` passes everything through,
// mirroring the real one's "keeps self" contract.
jest.mock("../../services/cursorService", () => ({
  subscribeToCursors: jest.fn(),
  visibleCursors: jest.fn((cursors: any[], selfId: string | undefined) =>
    cursors.filter((c: any) => c.userId !== selfId)
  ),
  trailEligibleCursors: jest.fn((cursors: any[]) => cursors),
  CURSOR_STALE_MS: 10000,
}));

import React from "react";
import { render, screen, act } from "@testing-library/react-native";
import { Circle } from "react-native-svg";
import CursorLayer from "../CursorLayer";
import * as cursorService from "../../services/cursorService";
import { LASER_FADE_MS } from "../../lib/laser";

/**
 * CursorLayer.test.tsx — Month 5 laser-trail reader-side accumulation and
 * rendering. `activeTrail`/`appendPing` themselves are pure and covered in
 * `src/lib/__tests__/laser.test.ts`; this file pins the integration: does
 * CursorLayer actually fold a stream of single-ping snapshot deliveries into
 * a growing, then fading, trail on screen.
 */

const subscribeToCursors = cursorService.subscribeToCursors as jest.Mock;

jest.useFakeTimers();

const VIEWPORT = { x: 0, y: 0, scale: 1 };
const RENDER_INTERVAL_MS = 80; // mirrors CursorLayer's own coalescing timer

function renderLayer() {
  let deliver: (cursors: any[]) => void = () => {};
  subscribeToCursors.mockImplementation((_boardId: string, cb: (c: any[]) => void) => {
    deliver = cb;
    return jest.fn();
  });
  render(
    <CursorLayer boardId="b1" viewport={VIEWPORT} selfId="self" blockedIds={[]} />
  );
  return { deliver: (cursors: any[]) => deliver(cursors) };
}

/** Flush CursorLayer's own ~12Hz coalescing timer so a delivery reaches state. */
function flushRenderThrottle() {
  act(() => {
    jest.advanceTimersByTime(RENDER_INTERVAL_MS);
  });
}

const laserCursor = (userId: string, x: number, y: number, t: number) => ({
  userId,
  displayName: userId,
  x,
  y,
  tool: "laser",
  updatedAt: t,
  ping: { x, y, t },
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.clearAllTimers();
});

describe("CursorLayer — laser trail accumulation and rendering (Month 5)", () => {
  it("renders a fading trail point for a remote laser ping", () => {
    const { deliver } = renderLayer();
    const t0 = Date.now();

    act(() => {
      deliver([laserCursor("u1", 1, 1, t0)]);
    });
    flushRenderThrottle();

    expect(screen.UNSAFE_getAllByType(Circle)).toHaveLength(1);
  });

  it("accumulates a second, later ping into a two-point trail rather than replacing the first", () => {
    const { deliver } = renderLayer();
    const t0 = Date.now();

    act(() => {
      deliver([laserCursor("u1", 1, 1, t0)]);
    });
    flushRenderThrottle();
    expect(screen.UNSAFE_getAllByType(Circle)).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(200);
    });
    const t1 = Date.now();
    act(() => {
      deliver([laserCursor("u1", 2, 2, t1)]);
    });
    flushRenderThrottle();

    expect(screen.UNSAFE_getAllByType(Circle)).toHaveLength(2);
  });

  it("does not duplicate a redelivery of the same unchanged ping", () => {
    // Mirrors the real trigger: the multiplexed listener fans the whole
    // collection out on *any* doc's change, so a still laser author's
    // *unchanged* latest ping is commonly redelivered by someone else moving.
    const { deliver } = renderLayer();
    const t0 = Date.now();
    const cursor = laserCursor("u1", 1, 1, t0);

    act(() => {
      deliver([cursor]);
    });
    flushRenderThrottle();
    act(() => {
      deliver([{ ...cursor }]);
    });
    flushRenderThrottle();

    expect(screen.UNSAFE_getAllByType(Circle)).toHaveLength(1);
  });

  it("fades a trail to nothing after LASER_FADE_MS with no further pings", () => {
    const { deliver } = renderLayer();
    const t0 = Date.now();

    act(() => {
      deliver([laserCursor("u1", 1, 1, t0)]);
    });
    flushRenderThrottle();
    expect(screen.UNSAFE_getAllByType(Circle)).toHaveLength(1);

    // No further delivery — the trail must still fade on its own via the
    // self-terminating tick loop, not only ever re-checked on the next
    // snapshot.
    act(() => {
      jest.advanceTimersByTime(LASER_FADE_MS + 500);
    });

    expect(screen.UNSAFE_queryAllByType(Circle)).toHaveLength(0);
  });

  it("renders no trail for a cursor with no ping", () => {
    const { deliver } = renderLayer();
    act(() => {
      deliver([
        { userId: "u1", displayName: "U1", x: 1, y: 1, tool: "pen", updatedAt: Date.now() },
      ]);
    });
    flushRenderThrottle();

    expect(screen.UNSAFE_queryAllByType(Circle)).toHaveLength(0);
    // The ordinary cursor arrow still renders — the laser addition doesn't
    // suppress it.
    expect(screen.getByText("U1")).toBeTruthy();
  });

  // Fix round 1: the trail is the tool's output, not a redundant pointer
  // duplicate — the pointing user has to see it, even though (unlike remote
  // users) they never see their own cursor arrow.
  it("renders the pointing user's own laser trail, without un-hiding their own cursor arrow", () => {
    const { deliver } = renderLayer(); // renderLayer() uses selfId="self"
    const t0 = Date.now();

    act(() => {
      deliver([laserCursor("self", 1, 1, t0)]);
    });
    flushRenderThrottle();

    expect(screen.UNSAFE_getAllByType(Circle)).toHaveLength(1);
    expect(screen.queryByText("self")).toBeNull();
  });
});
