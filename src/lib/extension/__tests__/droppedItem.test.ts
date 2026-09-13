import { parseDroppedItem } from "../droppedItem";

describe("parseDroppedItem", () => {
  it("prefers a text/uri-list entry when present", () => {
    const result = parseDroppedItem({
      types: ["text/uri-list", "text/html"],
      uriList: "https://example.com/cat.png",
      html: '<img src="https://example.com/other.png">',
    });
    expect(result).toEqual({ kind: "image-url", url: "https://example.com/cat.png" });
  });

  it("skips comment lines and blank lines in a uri-list, taking the first real entry", () => {
    const result = parseDroppedItem({
      types: ["text/uri-list"],
      uriList: "# a comment\n\nhttps://example.com/cat.png\nhttps://example.com/second.png",
    });
    expect(result).toEqual({ kind: "image-url", url: "https://example.com/cat.png" });
  });

  it("falls back to extracting an <img src> from text/html when uri-list is absent", () => {
    const result = parseDroppedItem({
      types: ["text/html"],
      html: '<div><img alt="x" src="https://example.com/pic.jpg" width="10"></div>',
    });
    expect(result).toEqual({ kind: "image-url", url: "https://example.com/pic.jpg" });
  });

  it("falls back to a dropped image file when there's no url", () => {
    const result = parseDroppedItem({
      types: ["Files"],
      files: [{ name: "photo.png", type: "image/png" }],
    });
    expect(result).toEqual({ kind: "file", name: "photo.png", type: "image/png" });
  });

  it("rejects a dropped non-image file", () => {
    const result = parseDroppedItem({
      types: ["Files"],
      files: [{ name: "notes.pdf", type: "application/pdf" }],
    });
    expect(result).toBeNull();
  });

  it("returns null for a plain text drop with no uri, html, or files", () => {
    expect(parseDroppedItem({ types: ["text/plain"] })).toBeNull();
  });

  it("returns null for an empty uri-list and no other data", () => {
    expect(parseDroppedItem({ types: ["text/uri-list"], uriList: "\n\n  \n" })).toBeNull();
  });

  it("returns null for html with no <img> tag", () => {
    expect(parseDroppedItem({ types: ["text/html"], html: "<b>hello</b>" })).toBeNull();
  });
});
