/**
 * Month 6 — browser extension side panel.
 *
 * The side panel (web/extension/) has no B.O.A.R.D-authenticated session of its
 * own and never will: it is a static, dependency-free Manifest V3 surface, not a
 * build of this app, so it cannot call `createEmbedLink`
 * (src/services/embedService.ts) to mint a link itself. Instead the user copies a
 * link from the existing "Embed (read-only)" action in ShareBoardModal
 * (src/components/ShareBoardModal.tsx) — which only ever mints `scope: "view"`
 * links — and pastes it into the panel.
 *
 * This module is the panel's defensive parse of that pasted text before it is
 * ever used as an iframe `src`. Two things make that parse worth having instead
 * of just setting `iframe.src = input`:
 *   - Arbitrary user-supplied text must never reach `src` unchecked — that would
 *     make the panel a general-purpose iframe loader for whatever string a user
 *     pastes, not a B.O.A.R.D-only surface.
 *   - The link must resolve to the configured board origin specifically and to
 *     the exact `/embed/b/{boardId}` shape `embedPath` produces (see
 *     src/services/embedService.ts) — not merely "looks like a URL".
 *
 * Mirrored, not imported, by web/extension/sidepanel.js: the extension ships as
 * plain JS with no bundler (see that file's own header for why). Keep the two in
 * sync by hand — the same discipline already documented in
 * web/meet-addon/README.md's "Domain placeholders" section for BOARD_ORIGIN.
 */

export interface ParsedEmbedLink {
  boardId: string;
  token: string;
}

/**
 * Parses a pasted embed link against the expected shape
 * `${boardOrigin}/embed/b/{boardId}?token={token}`. Returns `null` for anything
 * that doesn't match exactly — a different origin, a different path shape, or a
 * missing/empty token — rather than trying to be lenient. A wrong-origin link is
 * exactly the case this function exists to catch.
 */
export function parseEmbedLink(input: string, boardOrigin: string): ParsedEmbedLink | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  let origin: URL;
  try {
    origin = new URL(boardOrigin);
  } catch {
    // A misconfigured boardOrigin can't be used to validate anything — fail
    // closed rather than let every link through.
    return null;
  }

  if (url.origin !== origin.origin) return null;

  const match = url.pathname.match(/^\/embed\/b\/([^/]+)$/);
  if (!match) return null;

  const boardId = decodeURIComponent(match[1]);
  if (!boardId) return null;

  const token = url.searchParams.get("token");
  if (!token) return null;

  return { boardId, token };
}
