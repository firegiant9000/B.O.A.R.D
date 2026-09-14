/**
 * Month 6 — browser extension "drag an image onto the board" affordance.
 *
 * Normalizes whatever a drop event on the side panel's drop zone carried into
 * a small typed shape, or `null` if the drop wasn't a droppable image at all
 * (a text selection, a non-image file, a bookmark to a non-image page, …). The
 * real `DataTransfer` object isn't available outside a browser, so this takes
 * a plain, serializable subset of it — the side panel's own plain-JS mirror
 * builds this shape from the real event before calling the equivalent logic;
 * see that file's header for why the two aren't literally the same module.
 *
 * This function only ever decides WHAT was dropped, never what happens next.
 * Whether the result is actually added to the board is gated separately — see
 * editActionsGate.ts.
 */

export interface DroppedItemInput {
  /** `event.dataTransfer.types`, e.g. `["text/uri-list", "text/html", "Files"]`. */
  types: readonly string[];
  /** `event.dataTransfer.getData("text/uri-list")`, if present. Browsers set
   *  this when an `<img>` (or a link) is dragged from a page. */
  uriList?: string;
  /** `event.dataTransfer.getData("text/html")`, if present — recovers an
   *  `<img src>` on sites that only populate text/html, not text/uri-list. */
  html?: string;
  /** `event.dataTransfer.files`, reduced to the two fields this needs. */
  files?: readonly { name: string; type: string }[];
}

export type DroppedItem =
  | { kind: "image-url"; url: string }
  | { kind: "file"; name: string; type: string };

const IMG_SRC = /<img\b[^>]*\ssrc=["']([^"']+)["']/i;

/**
 * `text/uri-list` is a spec'd, newline-separated list of URIs where lines
 * starting with `#` are comments (RFC 2483) — this returns the first real
 * entry, which is what a single dragged image/link populates.
 */
function firstUri(uriList: string): string | undefined {
  return uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
}

export function parseDroppedItem(input: DroppedItemInput): DroppedItem | null {
  if (input.uriList) {
    const uri = firstUri(input.uriList);
    if (uri) return { kind: "image-url", url: uri };
  }

  if (input.html) {
    const match = input.html.match(IMG_SRC);
    if (match) return { kind: "image-url", url: match[1] };
  }

  const file = input.files?.[0];
  if (file && file.type.startsWith("image/")) {
    return { kind: "file", name: file.name, type: file.type };
  }

  return null;
}
