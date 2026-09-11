import { Platform } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { Session, SessionSummary, ParticipantSnapshot } from "../types";
import { toSvgDocument, SvgExportElement, SvgExportBounds } from "../lib/svgExport";
import { tilePages, A4 } from "../lib/pdfTiling";
import { captureBoardImageForExport } from "./canvasCapture";

// Phase 4: exportable session recap (PDF). The HTML builder is a pure function so
// it can be unit-tested without the platform print/share modules. Export is
// platform-split:
//  - native: expo-print renders the HTML to a PDF file, expo-sharing opens the
//    share sheet on it.
//  - web: expo-print's printToFileAsync is unsupported, so we open the HTML in a
//    new window and trigger the browser print dialog (Save as PDF).
//
// Month 6 — board export (SVG/PDF/PNG) reuses this exact platform split for
// `exportBoardPdf`/`exportBoardPng` below, rather than inventing a second one.

/** Normalizes either summary form (legacy string or structured) into the
 *  structured shape, mirroring SummaryCard.normalize. */
function normalizeSummary(
  summary: string | SessionSummary | undefined
): SessionSummary {
  if (!summary) return { tldr: "", actionItems: [], decisions: [], openQuestions: [] };
  if (typeof summary === "string") {
    return { tldr: summary, actionItems: [], decisions: [], openQuestions: [] };
  }
  return {
    tldr: summary.tldr ?? "",
    actionItems: summary.actionItems ?? [],
    decisions: summary.decisions ?? [],
    openQuestions: summary.openQuestions ?? [],
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Real elapsed minutes from startedAt → endedAt when both exist; otherwise the
 *  planned durationMinutes. */
export function recapDurationMinutes(session: Session): number {
  if (session.startedAt && session.endedAt) {
    return Math.max(1, Math.round((session.endedAt.getTime() - session.startedAt.getTime()) / 60000));
  }
  return session.durationMinutes;
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "";
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
}

/** Builds the printable HTML for a session recap. Pure — no platform deps. */
export function buildRecapHtml(session: Session): string {
  const s = normalizeSummary(session.summary);
  const participants: ParticipantSnapshot[] =
    session.participants && session.participants.length > 0
      ? session.participants
      : [];
  const dateStr = (session.endedAt ?? session.scheduledAt).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const section = (label: string, body: string) =>
    body ? `<section><h2>${escapeHtml(label)}</h2>${body}</section>` : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; padding: 32px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; margin: 22px 0 6px; }
  .tldr { font-size: 15px; line-height: 1.5; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 3px 0; font-size: 14px; line-height: 1.4; }
  img.snapshot { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; margin-top: 8px; }
  .participants { font-size: 14px; }
</style></head><body>
  <h1>${escapeHtml(session.title)}</h1>
  <div class="meta">${escapeHtml(session.boardTitle)} • ${escapeHtml(dateStr)} • ${escapeHtml(
    formatDuration(recapDurationMinutes(session))
  )} • ${participants.length || session.participantIds.length + 1} participant(s)</div>
  ${section("Summary", s.tldr ? `<p class="tldr">${escapeHtml(s.tldr)}</p>` : "")}
  ${section("Action items", bulletList(s.actionItems))}
  ${section("Decisions", bulletList(s.decisions))}
  ${section("Open questions", bulletList(s.openQuestions))}
  ${section("Agenda", session.agenda ? `<p class="tldr">${escapeHtml(session.agenda)}</p>` : "")}
  ${section(
    "Participants",
    participants.length > 0
      ? `<div class="participants">${participants
          .map((p) => escapeHtml(p.displayName))
          .join(", ")}</div>`
      : ""
  )}
  ${section(
    "Board snapshot",
    session.canvasSnapshot ? `<img class="snapshot" src="${session.canvasSnapshot}" />` : ""
  )}
</body></html>`;
}

/** Renders the recap to a PDF and opens the platform share/print flow. */
export async function exportRecapPdf(session: Session): Promise<void> {
  const html = buildRecapHtml(session);

  if (Platform.OS === "web") {
    if (typeof window === "undefined") return;
    const win = window.open("", "_blank");
    if (!win) throw new Error("Popup blocked — allow popups to export the recap.");
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
    return;
  }

  const { uri } = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: "application/pdf",
      dialogTitle: `${session.title} — Recap`,
      UTI: "com.adobe.pdf",
    });
  }
}

// --- Month 6: board export (SVG/PDF/PNG) ---

/**
 * Fan-out ceiling for `buildImageHrefs`'s image fetches. Unbounded
 * `Promise.all` over every image on a large board would fire dozens of
 * concurrent requests at Firebase Storage and hold all of their bytes (each
 * already base64-inflated to a `data:` URI) in memory at once. A small fixed
 * concurrency keeps memory bounded and is gentle on Storage, at the cost of
 * a proportionally longer export for an image-heavy board — an acceptable
 * trade per `buildImageHrefs`'s own reasoning (a slower export beats a
 * broken one, so a bit slower still beats hammering the backend).
 */
const IMAGE_FETCH_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `limit` in flight at once, preserving
 *  result order. A tiny fixed-size worker pool rather than a dependency —
 *  `items.length <= limit` behaves exactly like `Promise.all`. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Fetches `url`'s bytes and returns them as a `data:` URI, or `null` on any
 *  failure (offline, an expired Storage token, a CORS-blocked fetch on web).
 *  `fetch` + `Blob` + `FileReader` all behave the same on web and React
 *  Native, so this needs no platform split of its own. Never throws — a
 *  broken image reference should degrade that one image, not the export. */
async function fetchImageAsDataUri(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("image read failed"));
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.warn("[recapExport] failed to fetch image bytes for a self-contained export:", err);
    return null;
  }
}

/**
 * Builds a self-contained `imageHrefs` map for `toSvgDocument` (see
 * `svgExport.ts`'s IMAGE PORTABILITY section) by fetching every `image`
 * element's bytes as a `data:` URI. Without this, an exported PDF's images
 * are only references to their live (bearer-token, not-guaranteed-permanent)
 * Firebase Storage URLs — fine for the exporting user right now, but a PDF
 * is meant to be handed to someone else later: opened without access to this
 * app's Storage bucket, or after the link's signing window lapses, those
 * would render as broken image boxes. A PDF full of those is a worse outcome
 * than a slower export, so this is called unconditionally by `exportBoardPdf`
 * rather than left as an opt-in.
 *
 * `overrides` (a caller-supplied id → data URI map) wins per image id and is
 * never re-fetched. A fetch failure for one image just leaves that id unset
 * — `toSvgDocument` falls back to the element's own live URL for it — rather
 * than failing the whole export.
 *
 * Fetches at most `IMAGE_FETCH_CONCURRENCY` images at once (see that
 * constant) rather than firing every fetch in parallel — a board with many
 * images should export more slowly, not hammer Storage or hold every
 * image's bytes in memory simultaneously.
 */
export async function buildImageHrefs(
  elements: SvgExportElement[],
  overrides: Record<string, string> | undefined
): Promise<Record<string, string>> {
  const hrefs: Record<string, string> = { ...overrides };
  const toFetch = elements.filter(
    (el): el is Extract<SvgExportElement, { kind: "image" }> =>
      el.kind === "image" && !hrefs[el.data.id] && !!el.data.url
  );
  await mapWithConcurrency(toFetch, IMAGE_FETCH_CONCURRENCY, async (el) => {
    const dataUri = await fetchImageAsDataUri(el.data.url);
    if (dataUri) hrefs[el.data.id] = dataUri;
  });
  return hrefs;
}

function svgPageDataUri(svg: string): string {
  // Percent-encoding (not base64/`btoa`) so this works identically on native
  // — `btoa` is a browser global this codebase does not assume exists off
  // the web platform (see canvasCapture.ts's web-only `captureSvgAsPng`).
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Builds the printable multi-page HTML for a tiled board export: one
 * `<div class="page">` per tile, each holding that tile's own SVG document
 * (see `pdfTiling.tilePages` + `svgExport.toSvgDocument`) as a plain `<img>`
 * at its native size. Deliberately NOT scaled to fill the page — a full
 * interior tile is already exactly one page's worth of content at 1:1 scale
 * (this module always renders each page at `A4`'s own point dimensions, and
 * passes those same dimensions to `Print.printToFileAsync` in
 * `exportBoardPdf`), so scaling it up or down would make an edge tile (the
 * last row/column, trimmed smaller by `tilePages`) disagree in physical
 * scale with its full-size neighbors. Pure — no platform deps — so it's
 * unit-testable the same way `buildRecapHtml` is.
 */
export function buildBoardPdfHtml(pageSvgs: string[]): string {
  const pages = pageSvgs.map((svg) => `<div class="page"><img src="${svgPageDataUri(svg)}" /></div>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  /* Native ignores this — Print.printToFileAsync's own width/height option
     (see exportBoardPdf) sets its page size directly — but the web path's
     window.print() has no such option, only whatever the browser's print
     dialog defaults to, so this is the one place the intended physical page
     size is stated for that path. */
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .page img { display: block; }
</style></head><body>${pages}</body></html>`;
}

/**
 * Hard ceiling on the number of tiled pages a single PDF export will
 * attempt. A very large board can tile into an absurd page count (a
 * thousand-pixel-wide-per-page grid over a huge canvas), and discovering
 * that by watching a device grind through rendering and printing dozens of
 * pages is a bad experience. 40 pages is a stack of paper someone would
 * plausibly still want printed or paged through; past that, the board is
 * better served by PNG (one image, any size) or SVG (one vector document,
 * no page concept at all) than by a PDF nobody will read page-by-page.
 * `exportBoardPdf` fails fast with this number named in the error, before
 * fetching a single image byte, rather than silently truncating — a PDF
 * quietly missing the board's bottom-right corner is worse than a refusal
 * that says why.
 */
export const MAX_EXPORT_PAGES = 40;

export interface BoardPdfExportOptions {
  /** Shown in the native share sheet / web print dialog title, mirroring
   *  `exportRecapPdf`'s own `dialogTitle`. */
  title?: string;
  /** Per-image-id `data:` URI overrides — see `svgExport.ts`'s IMAGE
   *  PORTABILITY section. Any image element not covered here is fetched
   *  automatically (see `buildImageHrefs`) so the exported PDF is
   *  self-contained by default without the caller having to opt in. */
  imageHrefs?: Record<string, string>;
}

/**
 * Renders `elements` to a tiled, multi-page PDF and opens the platform
 * share/print flow — the PDF sibling of `exportRecapPdf`, same platform
 * split (native: `expo-print` + `expo-sharing`; web: open a window and
 * trigger the browser print dialog).
 *
 * This path does NOT touch `react-native-svg`'s `toDataURL` at all: each
 * page is a plain HTML `<img>` of an SVG document, rendered through
 * `expo-print`'s ordinary HTML-to-PDF pipeline — the same one
 * `buildRecapHtml`'s `session.canvasSnapshot` `<img>` already relies on. So
 * unlike PNG export below, it carries none of that path's open-on-hardware
 * risk (see `canvasCapture.ts#captureBoardImage`'s G7 caveat) and is,
 * together with plain SVG export, the native-guaranteed format until that
 * gate closes.
 *
 * Throws (naming `MAX_EXPORT_PAGES`) instead of attempting an export that
 * would tile into more pages than that.
 *
 * CAVEAT (web page scale): on native, `Print.printToFileAsync({ width:
 * A4.width, height: A4.height })` pins the physical PDF page to exactly the
 * same point dimensions this module tiles in, so a full-size tile fills its
 * page at true 1:1 scale. On web there is no equivalent option —
 * `window.print()` hands the HTML to the browser's own print dialog, which
 * only takes the `@page { size: A4 }` hint in `buildBoardPdfHtml` as a
 * suggestion, and a user's own "fit to page"/scale setting in that dialog
 * can still stretch the result. This is an existing limitation of the
 * web-print fallback this function reuses (`exportRecapPdf`'s own web path
 * has the same imprecision), not something introduced here, and not
 * something a browser's own print API lets a caller fully control.
 */
export async function exportBoardPdf(
  elements: SvgExportElement[],
  bounds: SvgExportBounds,
  opts?: BoardPdfExportOptions
): Promise<void> {
  const pages = tilePages({ width: bounds.width, height: bounds.height }, A4);
  if (pages.length > MAX_EXPORT_PAGES) {
    throw new Error(
      `This board would need ${pages.length} PDF pages, over the ${MAX_EXPORT_PAGES}-page export limit. Try exporting as PNG or SVG instead.`
    );
  }
  const imageHrefs = await buildImageHrefs(elements, opts?.imageHrefs);
  const pageSvgs = pages.map((p) =>
    toSvgDocument(
      elements,
      { x: bounds.x + p.x, y: bounds.y + p.y, width: p.width, height: p.height },
      { imageHrefs }
    )
  );
  const html = buildBoardPdfHtml(pageSvgs);
  const title = opts?.title ?? "Board";

  if (Platform.OS === "web") {
    if (typeof window === "undefined") return;
    const win = window.open("", "_blank");
    if (!win) throw new Error("Popup blocked — allow popups to export the board.");
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
    return;
  }

  const { uri } = await Print.printToFileAsync({ html, width: A4.width, height: A4.height });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: "application/pdf",
      dialogTitle: `${title} — Export`,
      UTI: "com.adobe.pdf",
    });
  }
}

export interface BoardPngExportOptions {
  /** Shown in the native share sheet title and used as the web download's
   *  filename (sanitized), mirroring `exportBoardPdf`'s `title`. */
  title?: string;
}

/**
 * Captures the board as a single PNG and opens the platform share/download
 * flow: native shares the file via the share sheet, web triggers a browser
 * download — the same platform split as `exportRecapPdf`/`exportBoardPdf`.
 *
 * CAVEAT (Month 6, gate G7 — a real Android device, still unmet): on native
 * this rides `canvasCapture.ts#captureBoardImageForExport`'s `toDataURL`
 * path, whose rendering of `image` elements has never been confirmed on real
 * Android hardware (see that function's own doc comment for the full
 * reasoning). This is UNVERIFIED — not confirmed broken, not confirmed
 * correct — and ships anyway rather than being disabled: disabling a
 * working feature on a suspicion is worse than shipping it with the risk
 * recorded. `exportBoardPdf`/plain SVG export do not carry this risk and are
 * the native-guaranteed formats until G7 closes.
 */
export async function exportBoardPng(canvasRef: any, opts?: BoardPngExportOptions): Promise<void> {
  const dataUrl = await captureBoardImageForExport(canvasRef);
  if (!dataUrl) {
    throw new Error("PNG export failed — could not capture the board.");
  }
  const filename = `${(opts?.title ?? "board").replace(/[^a-z0-9-_]+/gi, "-")}.png`;

  if (Platform.OS === "web") {
    if (typeof document === "undefined") return;
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return;
  }

  // Sharing.shareAsync requires a local file URL, not a `data:` URI — reuse
  // expo-image-manipulator (already a dependency; canvasCapture.ts's own
  // cropNative uses the same manipulate→saveAsync round trip) purely to
  // write the captured bytes to a real cache file.
  const rendered = await ImageManipulator.manipulate(dataUrl).renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.PNG });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(saved.uri, {
      mimeType: "image/png",
      dialogTitle: `${opts?.title ?? "Board"} — Export`,
      UTI: "public.png",
    });
  }
}

export interface BoardSvgExportOptions {
  /** Used as the web download's filename (sanitized), mirroring
   *  `exportBoardPdf`/`exportBoardPng`'s own `title`. */
  title?: string;
  /** Per-image-id `data:` URI overrides — see `svgExport.ts`'s IMAGE
   *  PORTABILITY section. Any image element not covered here is fetched
   *  automatically (see `buildImageHrefs`), same as `exportBoardPdf`, so a
   *  downloaded SVG is self-contained rather than carrying live Storage
   *  URLs a later opener may not have access to. */
  imageHrefs?: Record<string, string>;
}

/**
 * Downloads the board as a single, self-contained SVG document — WEB ONLY.
 * Reuses `exportBoardPng`'s own web download mechanism (build an `<a
 * download>`, click it, remove it — no new dependency, no WebView) and
 * `exportBoardPdf`'s self-contained-image fetch (`buildImageHrefs`), for
 * the same reason PDF needs it: a downloaded file is meant to outlive this
 * session and this device, so a bare Storage-URL reference isn't good
 * enough.
 *
 * NATIVE GAP — stated plainly, not a "verify later" caveat like PNG's G7
 * one: this function is NOT implemented on native, and that isn't a risk to
 * confirm, it's a real capability gap. `Sharing.shareAsync` needs a local
 * file; writing an arbitrary SVG text file to one needs a filesystem-write
 * dependency (`expo-file-system` is the obvious candidate) that is not
 * currently a dependency of this app and has not been approved to add.
 * PNG's native path sidesteps this via `expo-image-manipulator`, which only
 * accepts raster sources (a local file or a base64 data URI), never an
 * arbitrary text string; PDF's sidesteps it via `expo-print`, which renders
 * HTML into its own PDF file rather than writing one directly. Neither
 * trick extends to a raw SVG document. This throws on native — loudly,
 * naming why — rather than silently no-op'ing, so a caller can't wire a
 * dead button by accident. Adding `expo-file-system` (or another way to
 * close this gap) is a dependency decision for a human, not this function.
 */
export async function exportBoardSvg(
  elements: SvgExportElement[],
  bounds: SvgExportBounds,
  opts?: BoardSvgExportOptions
): Promise<void> {
  if (Platform.OS !== "web") {
    throw new Error(
      "SVG export isn't available on this platform yet: writing the file for the share sheet needs a filesystem dependency (e.g. expo-file-system) this app doesn't have, and adding one hasn't been approved."
    );
  }
  if (typeof document === "undefined") return;
  const imageHrefs = await buildImageHrefs(elements, opts?.imageHrefs);
  const svg = toSvgDocument(elements, bounds, { imageHrefs });
  const filename = `${(opts?.title ?? "board").replace(/[^a-z0-9-_]+/gi, "-")}.svg`;

  const link = document.createElement("a");
  link.href = svgPageDataUri(svg);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
