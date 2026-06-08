import {
  screenToBoard,
  boardToScreen,
  panBy,
  zoomAtPoint,
  zoomToScale,
  clampScale,
  boundsOfPoints,
  unionBounds,
  fitToBounds,
  MIN_SCALE,
  MAX_SCALE,
  IDENTITY_VIEWPORT,
} from "../viewport";

describe("clampScale", () => {
  it("clamps to the 10%–800% range", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1)).toBe(1);
  });
});

describe("screenToBoard / boardToScreen", () => {
  it("is the identity transform at the default viewport", () => {
    const p = { x: 42, y: 99 };
    expect(screenToBoard(IDENTITY_VIEWPORT, p)).toEqual(p);
    expect(boardToScreen(IDENTITY_VIEWPORT, p)).toEqual(p);
  });

  it("round-trips through a panned + zoomed viewport", () => {
    const vp = { x: 30, y: -15, scale: 2 };
    const screen = { x: 200, y: 120 };
    const board = screenToBoard(vp, screen);
    expect(boardToScreen(vp, board)).toEqual(screen);
  });

  it("applies translate then scale (screen = x + board*scale)", () => {
    const vp = { x: 100, y: 50, scale: 2 };
    // board (10,10) -> screen (120,70)
    expect(boardToScreen(vp, { x: 10, y: 10 })).toEqual({ x: 120, y: 70 });
    expect(screenToBoard(vp, { x: 120, y: 70 })).toEqual({ x: 10, y: 10 });
  });
});

describe("panBy", () => {
  it("shifts the origin without touching scale", () => {
    expect(panBy({ x: 5, y: 5, scale: 3 }, 10, -2)).toEqual({ x: 15, y: 3, scale: 3 });
  });
});

describe("zoomAtPoint", () => {
  it("keeps the board point under the focal fixed", () => {
    const vp = IDENTITY_VIEWPORT;
    const focal = { x: 300, y: 200 };
    const boardBefore = screenToBoard(vp, focal);
    const next = zoomAtPoint(vp, 2, focal);
    expect(next.scale).toBe(2);
    // The same board point still maps back to the focal.
    expect(boardToScreen(next, boardBefore)).toEqual(focal);
  });

  it("does not exceed MAX_SCALE and returns the same viewport when clamped", () => {
    const vp = { x: 0, y: 0, scale: MAX_SCALE };
    expect(zoomAtPoint(vp, 2, { x: 0, y: 0 })).toBe(vp);
  });
});

describe("zoomToScale", () => {
  it("sets an absolute scale around the focal", () => {
    const next = zoomToScale({ x: 0, y: 0, scale: 1 }, 4, { x: 100, y: 100 });
    expect(next.scale).toBe(4);
    expect(boardToScreen(next, screenToBoard({ x: 0, y: 0, scale: 1 }, { x: 100, y: 100 }))).toEqual({
      x: 100,
      y: 100,
    });
  });
});

describe("boundsOfPoints", () => {
  it("returns null for empty input", () => {
    expect(boundsOfPoints([])).toBeNull();
  });
  it("computes a tight box", () => {
    expect(boundsOfPoints([{ x: 1, y: 5 }, { x: -3, y: 2 }, { x: 4, y: 0 }])).toEqual({
      minX: -3,
      minY: 0,
      maxX: 4,
      maxY: 5,
    });
  });
});

describe("unionBounds", () => {
  it("ignores nulls and unions the rest", () => {
    expect(
      unionBounds([null, { minX: 0, minY: 0, maxX: 2, maxY: 2 }, { minX: -1, minY: 1, maxX: 1, maxY: 5 }])
    ).toEqual({ minX: -1, minY: 0, maxX: 2, maxY: 5 });
  });
  it("returns null when everything is null", () => {
    expect(unionBounds([null, null])).toBeNull();
  });
});

describe("fitToBounds", () => {
  it("returns identity for empty content", () => {
    expect(fitToBounds(null, { width: 800, height: 600 })).toEqual(IDENTITY_VIEWPORT);
  });

  it("centers and scales content to fit with padding", () => {
    const content = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const vp = fitToBounds(content, { width: 500, height: 500 }, 50);
    // available 400x400 / content 100 => scale 4
    expect(vp.scale).toBe(4);
    // content center (50,50) maps to viewport center (250,250)
    expect(boardToScreen(vp, { x: 50, y: 50 })).toEqual({ x: 250, y: 250 });
  });

  it("centers a single point at 100%", () => {
    const vp = fitToBounds({ minX: 10, minY: 10, maxX: 10, maxY: 10 }, { width: 200, height: 200 });
    expect(vp.scale).toBe(1);
    expect(boardToScreen(vp, { x: 10, y: 10 })).toEqual({ x: 100, y: 100 });
  });
});
