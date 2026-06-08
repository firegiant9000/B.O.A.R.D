import { viewportBounds, boundsIntersect } from "../culling";
import { IDENTITY_VIEWPORT } from "../viewport";

describe("viewportBounds", () => {
  it("maps the screen rect to board-space at the identity viewport", () => {
    expect(viewportBounds(IDENTITY_VIEWPORT, { width: 800, height: 600 })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 800,
      maxY: 600,
    });
  });

  it("accounts for pan and zoom (board = (screen - offset) / scale)", () => {
    const vp = { x: 100, y: 50, scale: 2 };
    // screen (0,0) -> board (-50,-25); screen (800,600) -> board (350,275)
    expect(viewportBounds(vp, { width: 800, height: 600 })).toEqual({
      minX: -50,
      minY: -25,
      maxX: 350,
      maxY: 275,
    });
  });

  it("inflates by the screen-space margin (margin / scale in board units)", () => {
    const vp = { x: 0, y: 0, scale: 2 };
    // 100px margin at 2x => 50 board units beyond each edge.
    expect(viewportBounds(vp, { width: 400, height: 400 }, 100)).toEqual({
      minX: -50,
      minY: -50,
      maxX: 250,
      maxY: 250,
    });
  });
});

describe("boundsIntersect", () => {
  const view = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it("is true for an overlapping box", () => {
    expect(boundsIntersect(view, { minX: 50, minY: 50, maxX: 150, maxY: 150 })).toBe(true);
  });

  it("is true for a fully contained box", () => {
    expect(boundsIntersect(view, { minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBe(true);
  });

  it("counts a touching edge as intersecting", () => {
    expect(boundsIntersect(view, { minX: 100, minY: 0, maxX: 120, maxY: 100 })).toBe(true);
  });

  it("is false for a box fully outside on any axis", () => {
    expect(boundsIntersect(view, { minX: 101, minY: 0, maxX: 120, maxY: 100 })).toBe(false);
    expect(boundsIntersect(view, { minX: 0, minY: -50, maxX: 100, maxY: -1 })).toBe(false);
  });

  it("is symmetric", () => {
    const b = { minX: -50, minY: -50, maxX: 10, maxY: 10 };
    expect(boundsIntersect(view, b)).toBe(boundsIntersect(b, view));
  });
});
