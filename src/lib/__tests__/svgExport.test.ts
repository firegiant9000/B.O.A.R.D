import { toSvgDocument, SvgExportElement, SvgExportBounds } from "../svgExport";

const bounds: SvgExportBounds = { x: 0, y: 0, width: 800, height: 600 };

const pathEl: SvgExportElement = {
  kind: "path",
  data: {
    id: "p1",
    boardId: "b1",
    userId: "u1",
    points: [
      { x: 10, y: 10 },
      { x: 50, y: 50 },
    ],
    color: "#000000",
    strokeWidth: 4,
    tool: "pen",
    createdAt: new Date(),
  },
};

const shapeEl: SvgExportElement = {
  kind: "shape",
  data: {
    id: "s1",
    boardId: "b1",
    userId: "u1",
    shape: "rect",
    x: 10,
    y: 10,
    width: 100,
    height: 50,
    rotation: 0,
    fill: "none",
    stroke: "#ff0000",
    strokeWidth: 2,
    dashed: false,
    arrowheadStart: "none",
    arrowheadEnd: "none",
    createdAt: new Date(),
  },
};

const textEl: SvgExportElement = {
  kind: "text",
  data: {
    id: "t1",
    boardId: "b1",
    userId: "u1",
    text: "hello",
    position: { x: 20, y: 20 },
    width: 100,
    height: 40,
    fontSize: 16,
    color: "#111111",
    createdAt: new Date(),
  },
};

const noteEl: SvgExportElement = {
  kind: "note",
  data: {
    id: "n1",
    boardId: "b1",
    userId: "u1",
    content: "sticky",
    position: { x: 30, y: 30 },
    createdAt: new Date(),
  },
};

const imageEl: SvgExportElement = {
  kind: "image",
  data: {
    id: "i1",
    boardId: "b1",
    userId: "u1",
    storagePath: "boards/b1/images/i1.jpg",
    thumbnailPath: "boards/b1/images/i1_thumb.jpg",
    url: "https://firebasestorage.googleapis.com/v0/b/bucket/o/i1.jpg",
    thumbnailUrl: "https://firebasestorage.googleapis.com/v0/b/bucket/o/i1_thumb.jpg",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    naturalWidth: 400,
    naturalHeight: 400,
    alt: "a photo",
    createdAt: new Date(),
  },
};

const audioEl: SvgExportElement = {
  kind: "audio",
  data: {
    id: "a1",
    schemaVersion: 1,
    boardId: "b1",
    userId: "u1",
    anchorElementId: "p1",
    storagePath: "boards/b1/audio/a1.m4a",
    downloadUrl: "https://firebasestorage.googleapis.com/v0/b/bucket/o/a1.m4a?alt=media&token=abc",
    durationMs: 3000,
    x: 10,
    y: 10,
    createdAt: new Date(),
  },
};

describe("toSvgDocument", () => {
  it("serializes a path element", () => {
    const doc = toSvgDocument([pathEl], bounds);
    expect(doc).toContain("<path");
    expect(doc).toContain('d="M 10 10 L 50 50"');
    expect(doc).toContain('stroke="#000000"');
  });

  it("serializes every element kind that exists today, with real content per visual kind", () => {
    // The union has grown past the brief's five kinds (audio notes exist
    // today; poll/math/code are scheduled later) — every kind that exists
    // right now must appear here, or a board holding one would silently
    // break export without any test catching it.
    expect(() =>
      toSvgDocument([pathEl, shapeEl, textEl, noteEl, imageEl, audioEl], bounds)
    ).not.toThrow();

    // "Doesn't throw" alone would also pass for a serializer that always
    // returns an empty document, so assert each visual kind actually
    // produced its expected node.
    expect(toSvgDocument([pathEl], bounds)).toContain("<path");
    expect(toSvgDocument([shapeEl], bounds)).toContain("<rect");
    expect(toSvgDocument([textEl], bounds)).toContain("<text");
    const noteDoc = toSvgDocument([noteEl], bounds);
    expect(noteDoc).toContain("<rect");
    expect(noteDoc).toContain("sticky");
    expect(toSvgDocument([imageEl], bounds)).toContain("<image");

    // Audio is a canvas affordance badge, not board content the way a
    // stroke/shape/text/image is (see toSvgDocument's header) — it must not
    // throw, but it also must not draw a phantom node either.
    const audioOnlyDoc = toSvgDocument([audioEl], bounds);
    expect(audioOnlyDoc).toMatch(/^<svg[^>]*><\/svg>$/);
  });

  it("exports a board that includes a voice note without throwing, drawing no badge for the note itself", () => {
    const doc = toSvgDocument([pathEl, audioEl], bounds);
    // The anchored stroke still exports fully...
    expect(doc).toContain("<path");
    // ...but nothing in the document came from the audio element: only one
    // drawable node exists, for the path.
    const drawableNodes = doc.match(/<(path|rect|ellipse|line|polygon|circle|image|text)[\s/>]/g) ?? [];
    expect(drawableNodes).toHaveLength(1);
  });

  it("escapes text content", () => {
    const el: SvgExportElement = { kind: "text", data: { ...textEl.data, text: "a<b&c" } };
    expect(toSvgDocument([el], bounds)).toContain("a&lt;b&amp;c");
  });

  it("escapes quotes and XML metacharacters in an attribute value, not just text content", () => {
    // The brief's text-content case wouldn't catch an unescaped quote landing
    // in an attribute (aria-label here) — an unescaped `"` would terminate
    // the attribute value early and corrupt every attribute after it.
    const el: SvgExportElement = {
      kind: "text",
      data: { ...textEl.data, text: `She said "hi" & <bye>, it's fine` },
    };
    const doc = toSvgDocument([el], bounds);
    expect(doc).toContain(
      'aria-label="She said &quot;hi&quot; &amp; &lt;bye&gt;, it&apos;s fine"'
    );
  });

  it("sets a viewBox (and width/height) from the content bounds", () => {
    const doc = toSvgDocument([pathEl], { x: 10, y: 20, width: 30, height: 40 });
    expect(doc).toContain('viewBox="10 20 30 40"');
    expect(doc).toContain('width="30"');
    expect(doc).toContain('height="40"');
  });

  it("produces a valid, well-formed empty document for no elements", () => {
    const doc = toSvgDocument([], bounds);
    expect(doc).toMatch(/^<svg[\s\S]*<\/svg>$/);
    // "Valid" means it carries what an SVG consumer actually needs — a
    // namespace and a viewBox — not merely an opening and closing tag with
    // nothing in between.
    expect(doc).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(doc).toContain(`viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}"`);
    expect(doc).toContain(`width="${bounds.width}"`);
    expect(doc).toContain(`height="${bounds.height}"`);
  });

  it("references an image element's live Storage URL by default (not embedded)", () => {
    const doc = toSvgDocument([imageEl], bounds);
    expect(doc).toContain(`href="${imageEl.data.url}"`);
    expect(doc).toContain(`xlink:href="${imageEl.data.url}"`);
  });

  it("lets a caller substitute already-fetched bytes for an image via imageHrefs", () => {
    const dataUri = "data:image/png;base64,AAAA";
    const doc = toSvgDocument([imageEl], bounds, { imageHrefs: { [imageEl.data.id]: dataUri } });
    expect(doc).toContain(`href="${dataUri}"`);
    expect(doc).not.toContain(imageEl.data.url);
  });

  it("tolerates elements missing a string field, per the board's global tolerant-reader rule", () => {
    // A partially-written or older-shape doc can legitimately lack a color/
    // fill/stroke/url field. This must fall back to a default and keep
    // producing a document, never throw inside the XML escaper.
    const partialPath: SvgExportElement = {
      kind: "path",
      data: { ...pathEl.data, color: undefined as unknown as string },
    };
    const partialShape: SvgExportElement = {
      kind: "shape",
      data: { ...shapeEl.data, fill: undefined as unknown as string, stroke: undefined as unknown as string },
    };
    const partialText: SvgExportElement = {
      kind: "text",
      data: { ...textEl.data, color: undefined as unknown as string },
    };
    const partialImage: SvgExportElement = {
      kind: "image",
      data: { ...imageEl.data, url: undefined as unknown as string },
    };

    expect(() =>
      toSvgDocument([partialPath, partialShape, partialText, partialImage], bounds)
    ).not.toThrow();
  });
});
