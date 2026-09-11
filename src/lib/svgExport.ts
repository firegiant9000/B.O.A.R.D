import { Point } from "./viewport";
import { ArrowheadStyle, AudioElement, DrawPath, ImageElement, ShapeElement, TextElement, TextNote } from "../types";
import { renderParamsFor, calligraphyWidthRange } from "./penStyles";
import { calligraphyPathD } from "./calligraphy";
import { trianglePoints, arrowheadPoints, arrowheadSize } from "./shapes";

/**
 * Month 6 — pure SVG export serializer.
 *
 * The board's live canvas already renders paths/shapes/images as
 * `react-native-svg` nodes (`DrawingCanvas.tsx`) — this module is a second,
 * standalone renderer of the SAME element data straight to an SVG-document
 * *string*, reusing the canvas's own pure geometry helpers
 * (`penStyles.renderParamsFor`, `calligraphy.calligraphyPathD`,
 * `shapes.trianglePoints`/`arrowheadPoints`) so a stroke or shape's exported
 * look doesn't quietly drift from what the screen actually draws. It adds NO
 * new rendering path and touches no `react-native-svg` runtime — no
 * WebViews, nothing mounted, just string building — so it runs equally well
 * off the render thread (a background export job, a later PNG/PDF task).
 *
 * Text elements and sticky notes are the one place export and canvas
 * intentionally diverge: on screen they're absolutely-positioned React
 * Native `View`/`Text` overlays (`TextElementView.tsx`, `TextNoteOverlay.tsx`),
 * not SVG nodes at all — there is no existing SVG rendering of them to stay
 * faithful to. Here they become real `<text>` nodes instead, so the whole
 * export is one uniform tree of SVG elements rather than a mix of SVG shapes
 * and un-exportable RN view overlays. That is a best-effort visual match,
 * not a pixel-identical one, and the two kinds diverge from each other here:
 * a `TextElement` has no wrap of its own (this serializer has no real
 * text-measurement pass, so it only respects explicit `\n` line breaks in
 * the source text), while a sticky note DOES estimate a width-driven wrap
 * (`wrapByEstimatedWidth`, below) against its fixed `NOTE_WIDTH`, since
 * ordinary note content routinely exceeds one line at that width and a
 * `\n`-only render would just spill text past the note's coloured rect.
 * Neither is a pixel-accurate match for the live editor's own text layout —
 * see `AVG_CHAR_WIDTH_RATIO`'s comment for exactly how the note's estimate
 * falls short of that.
 *
 * ELEMENT KINDS: `SvgExportElement`'s `kind` tag covers every element kind
 * that exists on the board today (path/shape/text/note/image/audio). Voice
 * notes (`kind: "audio"`) are a canvas AFFORDANCE — a mic/speaker badge a
 * viewer taps to play (`AudioAffordance.tsx`) — not board content the way a
 * stroke or shape is: they carry no drawable geometry of their own, only an
 * anchor id and the point they were recorded at. Exporting one as a visual
 * node would mean inventing a badge shape nobody asked for, so `toSvgDocument`
 * deliberately emits nothing for it. A board that HAS a voice note must
 * still export cleanly, though: an unrecognized or non-visual kind is always
 * skipped, never thrown on, so future non-visual kinds (and any element kind
 * this module hasn't been taught about yet) degrade the same way instead of
 * making an otherwise-exportable board fail to export at all.
 *
 * IMAGE PORTABILITY — the one real design decision here. An `ImageElement`'s
 * `url` is a Firebase Storage download URL: a bearer-token link, readable by
 * whoever holds it today, with no guarantee it stays valid or accessible
 * forever. `toSvgDocument` is a pure, synchronous function — it cannot fetch
 * those bytes itself — so BY DEFAULT an exported image is only a REFERENCE
 * to that URL (`href`/`xlink:href`), exactly what the live canvas does.
 * That makes the exported SVG render correctly for the exporting user right
 * now, and NOT self-contained: opened by someone without read access to this
 * app's Storage bucket, or after the link's signing window lapses, the image
 * will not resolve. Do not treat an exported SVG as a portable, standalone
 * artifact for its images on this basis alone. A caller that needs a truly
 * self-contained file can pre-fetch each image's bytes itself (this module
 * has no opinion on how) and pass them in as `opts.imageHrefs[imageId]` —
 * typically a `data:` URI — which this function will use verbatim in place
 * of the element's own `url`. This is the seam a later PNG/PDF export task
 * can build an async, byte-fetching wrapper on top of without this function
 * itself ever becoming async.
 */

export type SvgExportElement =
  | { kind: "path"; data: DrawPath }
  | { kind: "shape"; data: ShapeElement }
  | { kind: "text"; data: TextElement }
  | { kind: "note"; data: TextNote }
  | { kind: "image"; data: ImageElement }
  | { kind: "audio"; data: AudioElement };

/**
 * The export viewBox, as a plain rectangle. Deliberately NOT the app's own
 * `Bounds` (`./viewport` — `{minX, minY, maxX, maxY}`, used everywhere else
 * on the board for content/selection/culling boxes): an SVG `viewBox` wants
 * "min-x min-y width height", and a caller passing this in (e.g. from
 * `useBoardElements#contentBounds()`) must convert — `{ x: b.minX, y:
 * b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY }` — rather than
 * pass a `Bounds` through directly.
 */
export interface SvgExportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A `viewBox`/`width`/`height` of exactly zero disables rendering of the
 * whole element per the SVG spec ("a value of zero disables rendering of
 * the element") — it isn't merely a tiny image, it's a document every
 * consumer renders as nothing. `useBoardElements.ts#contentBounds()` can
 * hand this function exactly that today: a board whose only content is one
 * legacy sticky note computes a zero-width/zero-height point bbox for it
 * (`TextNote` carries no persisted width/height — see `NOTE_WIDTH`/
 * `NOTE_MIN_HEIGHT` below for the same gap on this module's own note
 * rendering). `toSvgDocument` clamps to this floor on every call rather than
 * trusting every present and future caller to pass a non-degenerate box —
 * it does not attempt to recover the "true" extent of whatever produced a
 * degenerate box, which is that caller's bbox math to get right, not this
 * serializer's; it only guarantees the document handed back is renderable.
 */
const MIN_EXPORT_DIMENSION = 1;

export interface SvgExportOptions {
  /** Per-image-id override for the exported `<image>`'s `href`/`xlink:href`
   *  — e.g. a `data:` URI a caller has already fetched, so that image is
   *  self-contained in the export. Falls back to the element's own (Storage-
   *  hosted, not-guaranteed-permanent) `url` when an id has no entry here.
   *  See this module's header for why the fetch itself can't happen in here. */
  imageHrefs?: Record<string, string>;
}

/** Escapes text destined for XML *element content* (between two tags). */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escapes text destined for an XML *attribute value*. A superset of
 * `escapeXmlText`: `<`/`&` are still invalid there, but `"`/`'` additionally
 * terminate the attribute early (this function always uses `"` to quote, so
 * only `"` is strictly required, but `'` is escaped too since a value is
 * never re-quoted with `'` here and callers may reuse this for other
 * contexts).
 */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** `M x y L x y L x y …` — mirrors `DrawingCanvas.tsx`'s (unexported)
 *  `pointsToSvgPath`, kept as a small local copy rather than importing a
 *  component module into this lib. A single point still draws a visible dot
 *  (a stationary pen tap), same as the canvas. Deliberately uses the raw
 *  stored points, not `DrawingCanvas.tsx`'s `simplifyPoints` (a display-only
 *  perf optimization at render time) — invisible for ordinary strokes, and
 *  an export should be faithful to the persisted data, not to a rendering
 *  shortcut. Considered, not applied here. */
function pointsToPathD(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y} L ${points[0].x + 0.5} ${points[0].y + 0.5}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`;
  return d;
}

/** Mirrors `DrawingCanvas.tsx`'s (unexported) `dashArray`. */
function dashArrayFor(strokeWidth: number): string {
  const d = Math.max(2, strokeWidth * 2);
  return `${d},${d}`;
}

/** Renders pre-split `lines` as `<tspan>`s stacked under `x`, `fontSize *
 *  1.2` apart (a standard single-line-height multiplier). A single line
 *  skips the `<tspan>` wrapper entirely — plain text content is enough and
 *  keeps the common case's output simple. */
function tspansFor(lines: string[], x: number, fontSize: number): string {
  if (lines.length <= 1) return escapeXmlText(lines[0] ?? "");
  const lineHeight = fontSize * 1.2;
  return lines
    .map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${escapeXmlText(line)}</tspan>`)
    .join("");
}

/** Average glyph-advance-width estimate used to word-wrap a sticky note (see
 *  `noteNode`) without a real text-measurement pass — this module's stated
 *  limitation for text generally (this module's header). 0.6 is a plain
 *  sans-serif rule-of-thumb (roughly what this board's own UI faces average
 *  out to), not a font-table lookup, so the wrap point is an estimate, not a
 *  pixel-accurate match for `TextNoteOverlay.tsx`'s real (native) text
 *  layout — it exists so realistic note content wraps at ROUGHLY the right
 *  point instead of always rendering as one line spilling past the
 *  coloured rect. */
const AVG_CHAR_WIDTH_RATIO = 0.6;

/** Word-wraps `text` to fit within `maxWidth` at `fontSize`, honoring
 *  explicit `\n` breaks first. A single word longer than the estimated
 *  per-line character budget is left unbroken on its own line (no
 *  character-level hyphenation) rather than silently dropped. */
function wrapByEstimatedWidth(text: string, maxWidth: number, fontSize: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * AVG_CHAR_WIDTH_RATIO)));
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

function pathNode(p: DrawPath): string {
  // Tolerant-reader default (Global Constraint): a color is a plain string
  // field, not a required-by-schema one at the Firestore layer, so a
  // partially-written doc missing it must fall back rather than throwing
  // inside the escaper below.
  const color = p.color ?? "#000000";
  if (p.tool === "eraser") {
    // Unchanged from the canvas's own eraser look (DrawingCanvas.tsx
    // `strokeVisualFor`): an opaque white stroke, inflated past the pen's
    // own width, painted over whatever it "erases".
    const d = pointsToPathD(p.points ?? []);
    if (!d) return "";
    return `<path d="${escapeXmlAttr(d)}" stroke="#FFFFFF" stroke-opacity="1" stroke-width="${p.strokeWidth + 10}" fill="none" stroke-linecap="round" stroke-linejoin="round" />`;
  }
  if (p.penStyle === "calligraphy") {
    const [minW, maxW] = calligraphyWidthRange(p.strokeWidth);
    const d = calligraphyPathD(p.points ?? [], minW, maxW);
    if (!d) return "";
    return `<path d="${escapeXmlAttr(d)}" fill="${escapeXmlAttr(color)}" fill-opacity="${p.opacity ?? 1}" stroke="none" />`;
  }
  const d = pointsToPathD(p.points ?? []);
  if (!d) return "";
  const params = renderParamsFor(p.penStyle, p.strokeWidth, p.opacity);
  // `params.multiplyBlend` (highlighter only) is deliberately not applied:
  // it's DrawingCanvas.tsx's web-only CSS `mix-blend-mode`, with no SVG
  // document equivalent to fall back to on other consumers, so overlapping
  // highlighter strokes render flatter here than on the web canvas. Narrow
  // and considered, not fixed here.
  return `<path d="${escapeXmlAttr(d)}" stroke="${escapeXmlAttr(color)}" stroke-opacity="${params.opacity}" stroke-width="${params.strokeWidth}" fill="none" stroke-linecap="${params.linecap}" stroke-linejoin="${params.linejoin}" />`;
}

function arrowheadNode(style: ArrowheadStyle, tip: Point, angle: number, strokeWidth: number, color: string): string {
  if (style === "none") return "";
  const size = arrowheadSize(strokeWidth);
  if (style === "dot" || style === "circle") {
    const fill = style === "dot" ? escapeXmlAttr(color) : "none";
    return `<circle cx="${tip.x}" cy="${tip.y}" r="${size / 2}" fill="${fill}" stroke="${escapeXmlAttr(color)}" stroke-width="${strokeWidth}" />`;
  }
  const [t, b1, b2] = arrowheadPoints(tip, angle, size);
  if (style === "open") {
    return (
      `<line x1="${t.x}" y1="${t.y}" x2="${b1.x}" y2="${b1.y}" stroke="${escapeXmlAttr(color)}" stroke-width="${strokeWidth}" stroke-linecap="round" />` +
      `<line x1="${t.x}" y1="${t.y}" x2="${b2.x}" y2="${b2.y}" stroke="${escapeXmlAttr(color)}" stroke-width="${strokeWidth}" stroke-linecap="round" />`
    );
  }
  // classic — filled triangle
  return `<polygon points="${t.x},${t.y} ${b1.x},${b1.y} ${b2.x},${b2.y}" fill="${escapeXmlAttr(color)}" />`;
}

function shapeNode(s: ShapeElement): string {
  // Tolerant-reader defaults (Global Constraint) — see pathNode's `color`.
  const fill = s.fill ?? "none";
  const stroke = s.stroke ?? "#000000";
  const dash = s.dashed ? dashArrayFor(s.strokeWidth) : undefined;
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
  const fillAttr = `fill="${escapeXmlAttr(fill)}"`;
  const strokeAttrs = `stroke="${escapeXmlAttr(stroke)}" stroke-width="${s.strokeWidth}"${dashAttr}`;

  let body: string;
  if (s.shape === "rect") {
    body = `<rect x="${s.x}" y="${s.y}" width="${Math.abs(s.width)}" height="${Math.abs(s.height)}" ${fillAttr} ${strokeAttrs} />`;
  } else if (s.shape === "ellipse") {
    const cx = s.x + s.width / 2;
    const cy = s.y + s.height / 2;
    body = `<ellipse cx="${cx}" cy="${cy}" rx="${Math.abs(s.width) / 2}" ry="${Math.abs(s.height) / 2}" ${fillAttr} ${strokeAttrs} />`;
  } else if (s.shape === "triangle") {
    const pts = trianglePoints(s.x, s.y, s.width, s.height)
      .map((p) => `${p.x},${p.y}`)
      .join(" ");
    body = `<polygon points="${pts}" ${fillAttr} ${strokeAttrs} />`;
  } else {
    // line / arrow
    const end = { x: s.x + s.width, y: s.y + s.height };
    const line = `<line x1="${s.x}" y1="${s.y}" x2="${end.x}" y2="${end.y}" stroke="${escapeXmlAttr(stroke)}" stroke-width="${s.strokeWidth}"${dashAttr} stroke-linecap="round" />`;
    let heads = "";
    if (s.shape === "arrow") {
      const angleEnd = Math.atan2(s.height, s.width);
      const angleStart = Math.atan2(-s.height, -s.width);
      heads += arrowheadNode(s.arrowheadEnd, end, angleEnd, s.strokeWidth, stroke);
      heads += arrowheadNode(s.arrowheadStart, { x: s.x, y: s.y }, angleStart, s.strokeWidth, stroke);
    }
    body = line + heads;
  }

  if (s.rotation) {
    const cx = s.x + s.width / 2;
    const cy = s.y + s.height / 2;
    return `<g transform="rotate(${s.rotation}, ${cx}, ${cy})">${body}</g>`;
  }
  return body;
}

function textNode(t: TextElement): string {
  const text = t.text ?? "";
  // Tolerant-reader default (Global Constraint) — see pathNode's `color`.
  const color = t.color ?? "#000000";
  const x = t.position.x;
  // Approximate the top-left placement TextElementView.tsx's padded RN Text
  // renders with — there's no shared layout engine between an RN Text box
  // and an SVG <text> baseline, so this is a reasonable approximation, not a
  // pixel match.
  const y = t.position.y + t.fontSize;
  const content = tspansFor(text.split("\n"), x, t.fontSize);
  const rotationAttr = t.rotation
    ? ` transform="rotate(${t.rotation}, ${t.position.x + t.width / 2}, ${t.position.y + t.height / 2})"`
    : "";
  return `<text x="${x}" y="${y}" font-size="${t.fontSize}" fill="${escapeXmlAttr(color)}" aria-label="${escapeXmlAttr(text)}"${rotationAttr}>${content}</text>`;
}

// TextNote (the legacy sticky note) carries no persisted width/height or
// rotation — TextNoteOverlay.tsx sizes it from its RN layout instead
// (fixed `maxWidth: 200`, height grown to fit by real word-wrap). These
// mirror that component's own fixed width/offsets/colors; `NOTE_MIN_HEIGHT`
// is a floor for short content — `noteNode` below grows the rect for
// longer content instead of using this as a fixed height, so realistic
// note text doesn't overflow it: at 200 units wide and 14px type, ordinary
// sticky-note text — as little as ~25-30 characters — already exceeds one
// line, so a fixed height is wrong for typical content, not just outliers.
const NOTE_LEFT_OFFSET = 60;
const NOTE_TOP_OFFSET = 20;
const NOTE_WIDTH = 200;
const NOTE_MIN_HEIGHT = 70;
const NOTE_FILL = "#FFF9C4";
const NOTE_TEXT_COLOR = "#333333";
const NOTE_FONT_SIZE = 14;
const NOTE_PADDING = 10;
const NOTE_LINE_HEIGHT = NOTE_FONT_SIZE * 1.2;

function noteNode(n: TextNote): string {
  const content = n.content ?? "";
  const x = n.position.x - NOTE_LEFT_OFFSET;
  const y = n.position.y - NOTE_TOP_OFFSET;
  const textX = x + NOTE_PADDING;
  const textY = y + NOTE_PADDING + NOTE_FONT_SIZE;
  const lines = wrapByEstimatedWidth(content, NOTE_WIDTH - NOTE_PADDING * 2, NOTE_FONT_SIZE);
  const height = Math.max(NOTE_MIN_HEIGHT, NOTE_PADDING * 2 + lines.length * NOTE_LINE_HEIGHT);
  return (
    `<g aria-label="${escapeXmlAttr(content)}">` +
    `<rect x="${x}" y="${y}" width="${NOTE_WIDTH}" height="${height}" rx="6" fill="${NOTE_FILL}" stroke="none" />` +
    `<text x="${textX}" y="${textY}" font-size="${NOTE_FONT_SIZE}" fill="${NOTE_TEXT_COLOR}">${tspansFor(lines, textX, NOTE_FONT_SIZE)}</text>` +
    `</g>`
  );
}

function imageNode(img: ImageElement, opts: SvgExportOptions | undefined): string {
  const w = Math.abs(img.width);
  const h = Math.abs(img.height);
  const x = Math.min(img.x, img.x + img.width);
  const y = Math.min(img.y, img.y + img.height);
  // See this module's header (IMAGE PORTABILITY) — a caller-supplied
  // override takes priority; absent one, this falls back to the element's
  // own live (non-permanent, access-gated) Storage URL, exactly what the
  // canvas itself renders. The final `?? ""` is the tolerant-reader default
  // (Global Constraint) for a doc partial enough to be missing `url` too.
  const href = opts?.imageHrefs?.[img.id] ?? img.url ?? "";
  const hrefAttr = escapeXmlAttr(href);
  const label = img.alt ? ` aria-label="${escapeXmlAttr(img.alt)}"` : "";
  // Both `href` and the legacy `xlink:href` are emitted: this document may
  // be opened by tools (older rasterizers/converters — relevant to a later
  // PDF/PNG export task) that don't resolve the bare SVG2 `href` on <image>.
  const body = `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${hrefAttr}" xlink:href="${hrefAttr}" preserveAspectRatio="xMidYMid slice"${label} />`;
  if (img.rotation) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    return `<g transform="rotate(${img.rotation}, ${cx}, ${cy})">${body}</g>`;
  }
  return body;
}

function nodeFor(el: SvgExportElement, opts: SvgExportOptions | undefined): string {
  switch (el.kind) {
    case "path":
      return pathNode(el.data);
    case "shape":
      return shapeNode(el.data);
    case "text":
      return textNode(el.data);
    case "note":
      return noteNode(el.data);
    case "image":
      return imageNode(el.data, opts);
    case "audio":
      // A voice-note badge is a canvas affordance, not drawable board
      // content — see this module's header. Deliberately no node.
      return "";
    default: {
      // Exhaustiveness guard for this file's own union. At runtime this also
      // catches any element kind this module hasn't been taught about yet
      // (a future poll/math/code kind reaching here before its own case is
      // added) — skipped the same way `audio` is, never thrown on, so one
      // unrecognized element never makes an otherwise-exportable board fail
      // to export at all.
      const _exhaustive: never = el;
      void _exhaustive;
      return "";
    }
  }
}

/**
 * Serializes `elements` into a standalone SVG document string, viewBox'd to
 * `bounds`. Never throws: an element kind this module doesn't draw (today,
 * only `audio` — see this module's header) contributes nothing rather than
 * failing the whole export, and every reader here tolerates a partially
 * written or older-shape element the same way the rest of the board does
 * (`data?.field ?? default`). A zero (or negative) `bounds.width`/`height`
 * is clamped up to `MIN_EXPORT_DIMENSION` rather than passed through, so the
 * result is always a renderable document, never one the SVG spec's
 * zero-disables-rendering rule turns into nothing.
 *
 * IMAGE ELEMENTS ARE NOT SELF-CONTAINED BY DEFAULT: an `image` element
 * serializes as a REFERENCE to its live Firebase Storage URL unless the
 * caller supplies `opts.imageHrefs`. See this module's header (IMAGE
 * PORTABILITY) before treating this function's output as a portable,
 * standalone file.
 */
export function toSvgDocument(
  elements: SvgExportElement[],
  bounds: SvgExportBounds,
  opts?: SvgExportOptions
): string {
  const width = Math.max(bounds.width, MIN_EXPORT_DIMENSION);
  const height = Math.max(bounds.height, MIN_EXPORT_DIMENSION);
  const inner = elements.map((el) => nodeFor(el, opts)).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="${bounds.x} ${bounds.y} ${width} ${height}" width="${width}" height="${height}">` +
    `${inner}</svg>`
  );
}
