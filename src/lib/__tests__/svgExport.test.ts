import { toSvgDocument, toSvgExportElements, SvgExportElement, SvgExportBounds } from "../svgExport";
import { ArrowheadStyle, AudioElement, DrawPath, ImageElement, ShapeElement, TextElement, TextNote } from "../../types";

const bounds: SvgExportBounds = { x: 0, y: 0, width: 800, height: 600 };

// Precisely-typed raw fixtures, kept separate from their `SvgExportElement`
// wrappers below. Spreading `xEl.data` (where `xEl: SvgExportElement`, a
// union) loses the per-kind narrowing once passed through a helper function
// — TypeScript widens it back to the union of every kind's `data` shape —
// so tests that build variants of a fixture spread these typed originals
// instead.
const pathData: DrawPath = {
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
};

const shapeData: ShapeElement = {
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
};

const textData: TextElement = {
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
};

const noteData: TextNote = {
  id: "n1",
  boardId: "b1",
  userId: "u1",
  content: "sticky",
  position: { x: 30, y: 30 },
  createdAt: new Date(),
};

const imageData: ImageElement = {
  id: "i1",
  boardId: "b1",
  userId: "u1",
  storagePath: "boards/b1/images/i1.jpg",
  thumbnailPath: "boards/b1/images/i1_thumb.jpg",
  // Realistic Firebase download URL shape (query string with `&`) — a
  // fixture with no `&`/`?` would never exercise attribute-escaping on the
  // image path, and a real download URL virtually always has one.
  url: "https://firebasestorage.googleapis.com/v0/b/bucket/o/i1.jpg?alt=media&token=abc-123",
  thumbnailUrl: "https://firebasestorage.googleapis.com/v0/b/bucket/o/i1_thumb.jpg?alt=media&token=abc-123",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  naturalWidth: 400,
  naturalHeight: 400,
  alt: "a photo",
  createdAt: new Date(),
};

const audioData: AudioElement = {
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
};

const pathEl: SvgExportElement = { kind: "path", data: pathData };
const shapeEl: SvgExportElement = { kind: "shape", data: shapeData };
const textEl: SvgExportElement = { kind: "text", data: textData };
const noteEl: SvgExportElement = { kind: "note", data: noteData };
const imageEl: SvgExportElement = { kind: "image", data: imageData };
const audioEl: SvgExportElement = { kind: "audio", data: audioData };

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
    const el: SvgExportElement = { kind: "text", data: { ...textData, text: "a<b&c" } };
    expect(toSvgDocument([el], bounds)).toContain("a&lt;b&amp;c");
  });

  it("escapes quotes and XML metacharacters in an attribute value, not just text content", () => {
    // The brief's text-content case wouldn't catch an unescaped quote landing
    // in an attribute (aria-label here) — an unescaped `"` would terminate
    // the attribute value early and corrupt every attribute after it.
    const el: SvgExportElement = {
      kind: "text",
      data: { ...textData, text: `She said "hi" & <bye>, it's fine` },
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

  it("references an image element's live Storage URL by default (not embedded), with its & properly attribute-escaped", () => {
    const doc = toSvgDocument([imageEl], bounds);
    // The raw URL contains an unescaped `&` (a real download URL's query
    // string always does) — asserting against the literal raw URL here
    // would prove nothing about escaping; it must appear as `&amp;`.
    expect(imageData.url).toContain("&");
    const expectedHref = imageData.url.replace(/&/g, "&amp;");
    expect(doc).toContain(`href="${expectedHref}"`);
    expect(doc).toContain(`xlink:href="${expectedHref}"`);
  });

  it("lets a caller substitute already-fetched bytes for an image via imageHrefs", () => {
    const dataUri = "data:image/png;base64,AAAA";
    const doc = toSvgDocument([imageEl], bounds, { imageHrefs: { [imageData.id]: dataUri } });
    expect(doc).toContain(`href="${dataUri}"`);
    expect(doc).not.toContain(imageData.url);
  });

  it("tolerates elements missing a string field, per the board's global tolerant-reader rule", () => {
    // A partially-written or older-shape doc can legitimately lack a color/
    // fill/stroke/content/url field. This must fall back to a default and
    // keep producing a document, never throw inside the XML escaper.
    const partialPath: SvgExportElement = {
      kind: "path",
      data: { ...pathData, color: undefined as unknown as string },
    };
    const partialShape: SvgExportElement = {
      kind: "shape",
      data: { ...shapeData, fill: undefined as unknown as string, stroke: undefined as unknown as string },
    };
    const partialText: SvgExportElement = {
      kind: "text",
      data: { ...textData, color: undefined as unknown as string },
    };
    const partialNote: SvgExportElement = {
      kind: "note",
      data: { ...noteData, content: undefined as unknown as string },
    };
    const partialImage: SvgExportElement = {
      kind: "image",
      data: { ...imageData, url: undefined as unknown as string },
    };

    expect(() =>
      toSvgDocument([partialPath, partialShape, partialText, partialNote, partialImage], bounds)
    ).not.toThrow();
  });

  describe("degenerate bounds", () => {
    it("clamps a zero-width/zero-height bounds to a renderable minimum instead of a spec-disabled viewBox", () => {
      // useBoardElements.ts#contentBounds() computes exactly this for a
      // board whose only content is one legacy sticky note (TextNote has no
      // persisted width/height): a zero-size point bbox. Per the SVG spec, a
      // viewBox/width/height of exactly zero disables rendering entirely —
      // not "tiny", literally nothing — so this must never reach the output.
      const doc = toSvgDocument([pathEl], { x: 5, y: 5, width: 0, height: 0 });
      expect(doc).not.toContain('viewBox="5 5 0 0"');
      expect(doc).not.toContain('width="0"');
      expect(doc).not.toContain('height="0"');
      expect(doc).toMatch(/viewBox="5 5 \d+(\.\d+)? \d+(\.\d+)?"/);
    });

    it("leaves an already-sane bounds untouched", () => {
      const doc = toSvgDocument([pathEl], { x: 10, y: 20, width: 30, height: 40 });
      expect(doc).toContain('viewBox="10 20 30 40"');
    });
  });

  describe("sticky note word-wrap", () => {
    it("keeps a short note at the floor height", () => {
      const doc = toSvgDocument([noteEl], bounds); // content: "sticky"
      expect(doc).toContain('height="70"');
      expect(doc).not.toContain("<tspan");
    });

    it("wraps realistic note content across multiple lines and grows the rect instead of overflowing it", () => {
      // ~70 characters, ordinary words — this is normal sticky-note
      // content, not an extreme edge case.
      const longNote: SvgExportElement = {
        kind: "note",
        data: { ...noteData, content: "Remember to follow up with the design team about the new onboarding flow" },
      };
      const doc = toSvgDocument([longNote], bounds);
      const tspanCount = (doc.match(/<tspan\b/g) ?? []).length;
      expect(tspanCount).toBeGreaterThan(1);
      const heightMatch = doc.match(/<rect[^>]*\bheight="([\d.]+)"/);
      expect(heightMatch).not.toBeNull();
      expect(Number(heightMatch![1])).toBeGreaterThan(70);
    });
  });

  describe("path pen-style branches (highlighter opacity is the highest-risk one: it must default per-style, not to a hardcoded 1)", () => {
    const baseWidth = 5;
    function pathWith(
      penStyle: DrawPath["penStyle"],
      opacity: number | undefined,
      tool: DrawPath["tool"] = "pen"
    ): SvgExportElement {
      return { kind: "path", data: { ...pathData, tool, penStyle, opacity, strokeWidth: baseWidth } };
    }

    it("widens a highlighter stroke and falls back to ITS OWN default alpha (0.35), never a hardcoded 1", () => {
      const doc = toSvgDocument([pathWith("highlighter", undefined)], bounds);
      expect(doc).toContain('stroke-width="8"'); // 5 * 1.6
      expect(doc).toContain('stroke-opacity="0.35"');
    });

    it("an explicit opacity still overrides the highlighter's own default", () => {
      const doc = toSvgDocument([pathWith("highlighter", 0.9)], bounds);
      expect(doc).toContain('stroke-opacity="0.9"');
    });

    it("widens a marker stroke with hard (butt/miter) edges at full opacity", () => {
      const doc = toSvgDocument([pathWith("marker", undefined)], bounds);
      expect(doc).toContain('stroke-width="6.5"'); // 5 * 1.3
      expect(doc).toContain('stroke-linecap="butt"');
      expect(doc).toContain('stroke-linejoin="miter"');
      expect(doc).toContain('stroke-opacity="1"');
    });

    it("renders calligraphy as a filled variable-width ribbon, not a stroked path", () => {
      const doc = toSvgDocument([pathWith("calligraphy", undefined)], bounds);
      expect(doc).toContain('stroke="none"');
      expect(doc).toMatch(/fill="#[0-9a-fA-F]{6}"/);
      expect(doc).not.toContain("stroke-linecap");
    });

    it("renders an eraser stroke as opaque white paint, inflated past the pen width", () => {
      const doc = toSvgDocument([pathWith(undefined, undefined, "eraser")], bounds);
      expect(doc).toContain('stroke="#FFFFFF"');
      expect(doc).toContain('stroke-width="15"'); // 5 + 10
    });
  });

  describe("shape arrowhead styles", () => {
    function arrowWith(arrowheadEnd: ArrowheadStyle): SvgExportElement {
      return {
        kind: "shape",
        data: {
          ...shapeData,
          shape: "arrow",
          x: 0,
          y: 0,
          width: 100,
          height: 0,
          stroke: "#0000ff",
          arrowheadStart: "none",
          arrowheadEnd,
        },
      };
    }

    it("classic renders a filled triangle polygon", () => {
      const doc = toSvgDocument([arrowWith("classic")], bounds);
      expect(doc).toContain("<polygon");
    });

    it("dot renders a filled circle", () => {
      const doc = toSvgDocument([arrowWith("dot")], bounds);
      expect(doc).toContain("<circle");
      expect(doc).toContain('fill="#0000ff"');
    });

    it("circle renders an outline-only (unfilled) circle", () => {
      const doc = toSvgDocument([arrowWith("circle")], bounds);
      expect(doc).toContain("<circle");
      expect(doc).toContain('fill="none"');
    });

    it("open renders two barb lines instead of a filled shape", () => {
      const doc = toSvgDocument([arrowWith("open")], bounds);
      const lineCount = (doc.match(/<line\b/g) ?? []).length;
      expect(lineCount).toBe(3); // the shaft + two open barbs
      expect(doc).not.toContain("<polygon");
    });

    it("none draws only the shaft, no arrowhead", () => {
      const doc = toSvgDocument([arrowWith("none")], bounds);
      const lineCount = (doc.match(/<line\b/g) ?? []).length;
      expect(lineCount).toBe(1); // the shaft only
      expect(doc).not.toContain("<polygon");
      expect(doc).not.toContain("<circle");
    });
  });

  describe("rotation branches", () => {
    it("wraps a rotated shape in a <g transform=rotate(...)> about its box center", () => {
      const rotated: SvgExportElement = { kind: "shape", data: { ...shapeData, rotation: 45 } };
      const doc = toSvgDocument([rotated], bounds);
      const cx = shapeData.x + shapeData.width / 2;
      const cy = shapeData.y + shapeData.height / 2;
      expect(doc).toContain(`<g transform="rotate(45, ${cx}, ${cy})">`);
    });

    it("draws an unrotated shape (rotation: 0) with no wrapping <g>", () => {
      const doc = toSvgDocument([shapeEl], bounds);
      expect(doc).not.toContain('<g transform="rotate');
    });

    it("wraps a rotated text element in a <g transform=rotate(...)> about its box center", () => {
      const rotated: SvgExportElement = { kind: "text", data: { ...textData, rotation: 30 } };
      const doc = toSvgDocument([rotated], bounds);
      const cx = textData.position.x + textData.width / 2;
      const cy = textData.position.y + textData.height / 2;
      expect(doc).toContain(`transform="rotate(30, ${cx}, ${cy})"`);
    });

    it("wraps a rotated image in a <g transform=rotate(...)> about its box center", () => {
      const rotated: SvgExportElement = { kind: "image", data: { ...imageData, rotation: 90 } };
      const doc = toSvgDocument([rotated], bounds);
      const cx = imageData.x + imageData.width / 2;
      const cy = imageData.y + imageData.height / 2;
      expect(doc).toContain(`<g transform="rotate(90, ${cx}, ${cy})">`);
    });
  });
});

describe("toSvgExportElements", () => {
  const empty = { paths: [], shapes: [], texts: [], notes: [], images: [], audioNotes: [] };

  it("wraps every kind's array entries with the matching kind tag", () => {
    const els = toSvgExportElements({
      ...empty,
      paths: [pathData],
      shapes: [shapeData],
      texts: [textData],
      notes: [noteData],
      images: [imageData],
      audioNotes: [audioData],
    });
    const kinds = els.map((el) => el.kind).sort();
    expect(kinds).toEqual(["audio", "image", "note", "path", "shape", "text"]);
    // Not just the right kind tags — the right underlying data too.
    expect(els.find((el) => el.kind === "path")?.data).toBe(pathData);
    expect(els.find((el) => el.kind === "image")?.data).toBe(imageData);
  });

  it("orders back-to-front matching the live canvas's own stacking (images, paths, shapes, notes, texts)", () => {
    // Two of each kind (in a scrambled input order) proves this reorders by
    // kind rather than by accidentally preserving call-argument order.
    const els = toSvgExportElements({
      images: [imageData],
      audioNotes: [audioData],
      paths: [pathData],
      notes: [noteData],
      shapes: [shapeData],
      texts: [textData],
    });
    expect(els.map((el) => el.kind)).toEqual(["image", "path", "shape", "note", "text", "audio"]);
  });

  it("produces an empty array (not throwing) for a board with no content of any kind", () => {
    expect(toSvgExportElements(empty)).toEqual([]);
  });

  it("feeds cleanly into toSvgDocument end to end", () => {
    const els = toSvgExportElements({ ...empty, paths: [pathData], images: [imageData] });
    const doc = toSvgDocument(els, bounds);
    expect(doc).toContain("<path");
    expect(doc).toContain("<image");
  });
});
