import {
  ClipItem,
  setClipboard,
  getClipboard,
  hasClipboard,
  clearClipboard,
  nextPasteOffset,
  offsetClipItem,
} from "../clipboard";
import { DUPLICATE_OFFSET } from "../transform";

const pathItem: ClipItem = {
  kind: "path",
  data: {
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 5 },
    ],
    color: "#000",
    strokeWidth: 5,
    tool: "pen",
  },
};

const shapeItem: ClipItem = {
  kind: "shape",
  data: {
    shape: "rect",
    x: 100,
    y: 50,
    width: 40,
    height: 30,
    rotation: 0,
    fill: "none",
    stroke: "#000",
    strokeWidth: 2,
    dashed: false,
    arrowheadStart: "none",
    arrowheadEnd: "none",
  },
};

const textItem: ClipItem = {
  kind: "text",
  data: {
    text: "hi",
    position: { x: 20, y: 30 },
    width: 100,
    height: 40,
    fontSize: 16,
    color: "#000",
  },
};

const imageItem: ClipItem = {
  kind: "image",
  data: {
    storagePath: "boards/a/images/x/full.jpg",
    thumbnailPath: "boards/a/images/x/thumb.jpg",
    url: "https://example/full",
    thumbnailUrl: "https://example/thumb",
    x: 5,
    y: 7,
    width: 200,
    height: 100,
    rotation: 0,
    naturalWidth: 800,
    naturalHeight: 400,
    alt: "pic",
  },
};

describe("clipboard store", () => {
  beforeEach(() => clearClipboard());

  it("is empty initially", () => {
    expect(hasClipboard()).toBe(false);
    expect(getClipboard()).toEqual([]);
  });

  it("stores and reports a payload", () => {
    setClipboard([pathItem, shapeItem]);
    expect(hasClipboard()).toBe(true);
    expect(getClipboard()).toHaveLength(2);
  });

  it("clears the payload", () => {
    setClipboard([pathItem]);
    clearClipboard();
    expect(hasClipboard()).toBe(false);
  });
});

describe("nextPasteOffset", () => {
  beforeEach(() => clearClipboard());

  it("cascades the offset on repeated pastes", () => {
    setClipboard([pathItem]);
    expect(nextPasteOffset()).toBe(DUPLICATE_OFFSET);
    expect(nextPasteOffset()).toBe(2 * DUPLICATE_OFFSET);
    expect(nextPasteOffset()).toBe(3 * DUPLICATE_OFFSET);
  });

  it("resets the cascade on a fresh copy", () => {
    setClipboard([pathItem]);
    nextPasteOffset();
    nextPasteOffset();
    setClipboard([shapeItem]);
    expect(nextPasteOffset()).toBe(DUPLICATE_OFFSET);
  });

  it("accepts a custom step", () => {
    setClipboard([pathItem]);
    expect(nextPasteOffset(10)).toBe(10);
    expect(nextPasteOffset(10)).toBe(20);
  });
});

describe("offsetClipItem", () => {
  it("translates path points without mutating the source", () => {
    const out = offsetClipItem(pathItem, 16);
    expect(out.kind).toBe("path");
    if (out.kind === "path") {
      expect(out.data.points).toEqual([
        { x: 16, y: 16 },
        { x: 26, y: 21 },
      ]);
    }
    // original untouched
    expect(pathItem.data.points[0]).toEqual({ x: 0, y: 0 });
  });

  it("offsets a shape's top-left", () => {
    const out = offsetClipItem(shapeItem, 16);
    if (out.kind === "shape") {
      expect(out.data.x).toBe(116);
      expect(out.data.y).toBe(66);
      expect(out.data.width).toBe(40);
    }
  });

  it("offsets a text element's position", () => {
    const out = offsetClipItem(textItem, 16);
    if (out.kind === "text") {
      expect(out.data.position).toEqual({ x: 36, y: 46 });
    }
  });

  it("offsets an image's top-left and preserves storage refs", () => {
    const out = offsetClipItem(imageItem, 16);
    if (out.kind === "image") {
      expect(out.data.x).toBe(21);
      expect(out.data.y).toBe(23);
      expect(out.data.storagePath).toBe("boards/a/images/x/full.jpg");
      expect(out.data.url).toBe("https://example/full");
    }
  });
});
