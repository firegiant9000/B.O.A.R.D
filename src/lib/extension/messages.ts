/**
 * Month 6 — browser extension message-bus contract.
 *
 * The background service worker (web/extension/background.js) relays page
 * metadata collected by the on-demand content script (web/extension/content.js)
 * to the side panel (web/extension/sidepanel.js) via `chrome.runtime.sendMessage`
 * / `chrome.runtime.onMessage`. Anything arriving over that channel is, from the
 * receiver's point of view, just untyped JSON from another extension
 * component — worth validating defensively before any field is trusted, the
 * same rigor `parseEmbedScope` (src/lib/embedScope.ts) applies to a Cloud
 * Function response. Returns `null` for anything that doesn't match exactly,
 * rather than trying to coerce a partially-shaped message into a valid one.
 */

export const PAGE_METADATA_MESSAGE = "BOARD_EXT_PAGE_METADATA" as const;

export interface PageMetadataMessage {
  type: typeof PAGE_METADATA_MESSAGE;
  url: string;
  title: string;
  /** An `og:image` URL, when the page declared one. Untrusted, host-page-supplied
   *  text/URL — display it, never treat it as verified. */
  image?: string;
}

export function validateExtensionMessage(raw: unknown): PageMetadataMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  if (msg.type !== PAGE_METADATA_MESSAGE) return null;
  if (typeof msg.url !== "string" || msg.url === "") return null;
  if (typeof msg.title !== "string") return null;
  if (msg.image !== undefined && (typeof msg.image !== "string" || msg.image === "")) {
    return null;
  }

  return {
    type: PAGE_METADATA_MESSAGE,
    url: msg.url,
    title: msg.title,
    ...(typeof msg.image === "string" ? { image: msg.image } : {}),
  };
}
