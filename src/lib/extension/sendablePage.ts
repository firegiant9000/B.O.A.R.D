/**
 * Month 6 — browser extension "send this page to a board" action.
 *
 * Decides whether the active tab's URL is even eligible to offer the action
 * for — purely a UI-affordance gate (disable the context-menu item / button).
 * It is not, and does not need to be, a security boundary: nothing downstream
 * of this decision performs a write today (see editActionsGate.ts) — there is
 * no write for this check to protect, only a "send" affordance that shouldn't
 * be offered for a page that can't sensibly become board content: the
 * browser's own internal pages, an empty/invalid URL, or the board app's own
 * embed surface (sending B.O.A.R.D's embed page to a board would be recursive
 * noise, not content).
 */

const BLOCKED_SCHEMES = new Set([
  "chrome:",
  "edge:",
  "about:",
  "chrome-extension:",
  "extension:",
  "devtools:",
  "view-source:",
  "data:",
]);

export function isSendablePageUrl(
  rawUrl: string | undefined | null,
  boardOrigin: string
): boolean {
  if (!rawUrl) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (BLOCKED_SCHEMES.has(url.protocol)) return false;

  try {
    if (url.origin === new URL(boardOrigin).origin) return false;
  } catch {
    // An unparsable boardOrigin can't rule anything out — fall through to the
    // scheme check result above rather than fail the whole decision on a
    // misconfigured constant.
  }

  return true;
}
