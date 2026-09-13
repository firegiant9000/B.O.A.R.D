/**
 * Month 6 — browser extension side panel: refuse to even load an edit-scope
 * embed link.
 *
 * ⚠️ Read functions/src/embed/token.ts's trust-model note and
 * EMBED_EDIT_TOKEN_TTL_SECONDS's doc comment before touching this. An exchanged
 * embed session outlives every control that appears to bound it:
 * `signInWithCustomToken` establishes a Firebase Auth session whose refresh
 * token outlives the embed token's own expiry, is not invalidated by
 * re-minting, and is not revoked by rotating the signing secret. A leaked
 * *editable* embed link is therefore board write access with no revocation
 * path anywhere in this codebase. Closing that gap needs
 * `auth.revokeRefreshTokens(uid)` reachable from somewhere, an `auth_time`
 * bound in firestore.rules' `isEmbedEditor`, and a client that re-exchanges on
 * expiry — none of which exists yet.
 *
 * The side panel's own product surface (ShareBoardModal's "Embed (read-only)"
 * action) only ever mints `scope: "view"` links, so in the ordinary flow this
 * never fires. It exists as a second, independent line of defense: if a
 * differently-scoped link ever reaches this panel (a future edit-scope share
 * UI, a link copied from a different integration), the panel refuses to load
 * it rather than silently becoming a second surface edit scope can be
 * exercised from.
 *
 * This is ADVISORY UI behavior, not a security boundary — the real boundary is
 * the server-side exchange (functions/src/callable/exchangeEmbedToken.ts) and
 * firestore.rules' `isEmbedEditor`, exactly as src/lib/embedScope.ts's own doc
 * comment says for the same reason. Getting this function wrong in the
 * dangerous direction would be a confusing UI (the panel loads an edit-scope
 * board), never a write it didn't already have to grant.
 *
 * HS256 signs, it does not encrypt: the token's middle segment is plain
 * base64url JSON even without the signing secret, so this reads the `scope`
 * claim WITHOUT verifying the signature. That is exactly why it must never be
 * used to grant anything, only to refuse to load — an attacker can forge a
 * token that decodes to `scope: "view"`, but that forged token still has to
 * pass the real, signature-verified exchange before it does anything; it just
 * won't be refused *here* for the wrong reason.
 */

/**
 * Best-effort peek at an embed JWT's own `scope` claim (see
 * functions/src/embed/token.ts's `EmbedTokenPayload`). Returns `true` for
 * anything that decodes to `scope: "edit"` — and, deliberately, for anything
 * that fails to decode at all, since an undecodable token is "not provably
 * view" and the safe default here is to refuse rather than guess.
 */
export function looksLikeEditScopeToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return true; // malformed — refuse rather than guess

  try {
    const json = base64UrlDecode(parts[1]);
    const payload = JSON.parse(json) as { scope?: unknown };
    return payload?.scope === "edit";
  } catch {
    return true; // undecodable — refuse rather than guess
  }
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(padded, "base64").toString("utf-8");
  }
  // Browser fallback (the side panel's own plain-JS mirror uses this path;
  // kept here too so this module runs the same way under Jest's Node
  // environment and inside an actual extension page).
  return atob(padded);
}
