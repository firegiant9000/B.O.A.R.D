import {
  fitWithin,
  placementBox,
  imageBbox,
  MAX_IMAGE_DIM,
  THUMBNAIL_DIM,
  DEFAULT_PLACED_LONG_EDGE,
} from "../images";

describe("fitWithin", () => {
  it("scales the long edge down to the ceiling, preserving aspect", () => {
    expect(fitWithin(4096, 2048, MAX_IMAGE_DIM)).toEqual({ width: 2048, height: 1024 });
  });

  it("respects a portrait long edge", () => {
    expect(fitWithin(1000, 4000, THUMBNAIL_DIM)).toEqual({ width: 64, height: 256 });
  });

  it("never upscales a small image", () => {
    expect(fitWithin(100, 50, MAX_IMAGE_DIM)).toEqual({ width: 100, height: 50 });
  });

  it("clamps to at least 1px and handles a degenerate size", () => {
    expect(fitWithin(0, 0, MAX_IMAGE_DIM)).toEqual({ width: 0, height: 0 });
    expect(fitWithin(10000, 1, MAX_IMAGE_DIM).height).toBe(1);
  });
});

describe("placementBox", () => {
  it("centers an aspect-fitted box on the given point", () => {
    const box = placementBox(800, 400, { x: 100, y: 100 });
    expect(box.width).toBe(DEFAULT_PLACED_LONG_EDGE);
    expect(box.height).toBe(DEFAULT_PLACED_LONG_EDGE / 2);
    // centered: x = center - width/2, y = center - height/2
    expect(box.x).toBe(100 - box.width / 2);
    expect(box.y).toBe(100 - box.height / 2);
  });

  it("honors a custom long edge", () => {
    const box = placementBox(200, 200, { x: 0, y: 0 }, 100);
    expect(box).toEqual({ x: -50, y: -50, width: 100, height: 100 });
  });
});

describe("imageBbox", () => {
  it("returns the axis-aligned box for an unrotated image", () => {
    expect(imageBbox({ x: 10, y: 20, width: 100, height: 40, rotation: 0 })).toEqual({
      minX: 10,
      minY: 20,
      maxX: 110,
      maxY: 60,
    });
  });

  it("normalizes a negative-extent box", () => {
    expect(imageBbox({ x: 110, y: 60, width: -100, height: -40, rotation: 0 })).toEqual({
      minX: 10,
      minY: 20,
      maxX: 110,
      maxY: 60,
    });
  });

  it("expands the AABB to cover a 90° rotation about the center", () => {
    // 100x40 box rotated 90° → bbox becomes 40x100 about the same center (60,40).
    const b = imageBbox({ x: 10, y: 20, width: 100, height: 40, rotation: 90 });
    expect(b.minX).toBeCloseTo(40);
    expect(b.maxX).toBeCloseTo(80);
    expect(b.minY).toBeCloseTo(-10);
    expect(b.maxY).toBeCloseTo(90);
  });

  it("a 45° rotation produces a strictly larger AABB than the unrotated box", () => {
    const plain = imageBbox({ x: 0, y: 0, width: 100, height: 100, rotation: 0 });
    const rot = imageBbox({ x: 0, y: 0, width: 100, height: 100, rotation: 45 });
    expect(rot.maxX - rot.minX).toBeGreaterThan(plain.maxX - plain.minX);
  });
});
