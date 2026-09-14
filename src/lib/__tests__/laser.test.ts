import { activeTrail, appendPing, LASER_FADE_MS } from "../laser";

describe("activeTrail", () => {
  it("keeps points inside the fade window", () => {
    const pings = [{ x: 1, y: 1, t: 900 }, { x: 2, y: 2, t: 1000 }];
    expect(activeTrail(pings, 1000)).toHaveLength(2);
  });

  it("drops points past the fade window", () => {
    const pings = [{ x: 1, y: 1, t: 0 }, { x: 2, y: 2, t: 1000 }];
    expect(activeTrail(pings, 1000 + LASER_FADE_MS + 1)).toHaveLength(0);
  });

  it("fades opacity from 1 to 0 across the window", () => {
    const [p] = activeTrail([{ x: 0, y: 0, t: 1000 }], 1000);
    expect(p.opacity).toBeCloseTo(1, 2);
    const [q] = activeTrail([{ x: 0, y: 0, t: 1000 }], 1000 + LASER_FADE_MS / 2);
    expect(q.opacity).toBeCloseTo(0.5, 1);
  });

  it("returns an empty trail for no pings", () => {
    expect(activeTrail([], 0)).toEqual([]);
  });
});

// Reader-side accumulation (Month 5): a cursor doc holds at most one ping
// (full-document `setDoc` replace — see `cursorService.ts#writerFor`), so the
// multi-point trail `activeTrail` fades is built here, across successive
// deliveries, not out of the payload itself.
describe("appendPing", () => {
  it("appends a new ping onto the accumulated trail", () => {
    const trail = [{ x: 0, y: 0, t: 100 }];
    const next = appendPing(trail, { x: 1, y: 1, t: 200 }, 200);
    expect(next).toEqual([{ x: 0, y: 0, t: 100 }, { x: 1, y: 1, t: 200 }]);
  });

  it("starts a trail from nothing", () => {
    expect(appendPing([], { x: 5, y: 5, t: 10 }, 10)).toEqual([{ x: 5, y: 5, t: 10 }]);
  });

  it("does not duplicate a redelivery of the same unchanged ping", () => {
    // The cursor doc's `setDoc` replace means a still cursor keeps rebroadcasting
    // the *same* ping timestamp; the multiplexed listener also redelivers it on
    // every unrelated cursor's write. Neither should grow the trail.
    const trail = appendPing([], { x: 1, y: 1, t: 100 }, 100);
    const again = appendPing(trail, { x: 1, y: 1, t: 100 }, 100);
    expect(again).toEqual([{ x: 1, y: 1, t: 100 }]);
  });

  it("prunes points that fell out of the fade window before appending the new one", () => {
    const trail = [{ x: 0, y: 0, t: 0 }];
    const now = LASER_FADE_MS + 1;
    const next = appendPing(trail, { x: 9, y: 9, t: now }, now);
    expect(next).toEqual([{ x: 9, y: 9, t: now }]);
  });

  it("with no new ping, still prunes the trail down to the fade window", () => {
    const trail = [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 1000 }];
    const next = appendPing(trail, undefined, 1000 + LASER_FADE_MS + 1);
    expect(next).toEqual([]);
  });

  it("with no new ping and nothing stale, leaves the trail untouched", () => {
    const trail = [{ x: 0, y: 0, t: 1000 }];
    expect(appendPing(trail, null, 1000)).toEqual(trail);
  });
});
