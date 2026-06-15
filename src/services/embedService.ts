import { httpsCallable } from "firebase/functions";
import { signInWithCustomToken } from "firebase/auth";
import { auth, functions } from "../config/firebase";
import type { EmbedScope } from "../types";

// Client seam for embeddable boards (Month 4, Phase 8). Two calls, both thin
// wrappers over Cloud Functions:
//   - createEmbedLink: a board member mints a short-lived signed link to share.
//   - redeemEmbedToken: the embed page (no account) trades the link's token for a
//     scoped, read-only Firebase identity and signs in with it.
// No secret ever touches the client — the function holds the signing key, the
// client only ever sees the opaque token and the resulting custom token.

export interface EmbedLink {
  /** Absolute URL on web (origin + path); the path alone elsewhere. */
  url: string;
  path: string;
  token: string;
  scope: EmbedScope;
  /** Token expiry, seconds since epoch. */
  expiresAt: number;
}

/** Path for an embed link. Kept here so the route shape lives in one place. */
export function embedPath(boardId: string, token: string): string {
  return `/embed/b/${boardId}?token=${encodeURIComponent(token)}`;
}

/** Mints a read-only embed link for a board (caller must be a board member). */
export async function createEmbedLink(boardId: string): Promise<EmbedLink> {
  const callable = httpsCallable<
    { boardId: string; scope?: EmbedScope },
    { token: string; scope: EmbedScope; expiresAt: number }
  >(functions, "mintEmbedToken");

  const { data } = await callable({ boardId });
  const path = embedPath(boardId, data.token);
  const origin =
    typeof window !== "undefined" && window.location ? window.location.origin : "";
  return {
    url: origin ? `${origin}${path}` : path,
    path,
    token: data.token,
    scope: data.scope,
    expiresAt: data.expiresAt,
  };
}

/**
 * Exchanges an embed token for a scoped identity and signs in with it. Throws the
 * function's HttpsError message (expired / invalid link) so the embed page can
 * show the right state. On success the board's read rules accept the new identity.
 */
export async function redeemEmbedToken(
  token: string
): Promise<{ boardId: string; scope: EmbedScope }> {
  const callable = httpsCallable<
    { token: string },
    { customToken: string; boardId: string; scope: EmbedScope }
  >(functions, "exchangeEmbedToken");

  const { data } = await callable({ token });
  await signInWithCustomToken(auth, data.customToken);
  return { boardId: data.boardId, scope: data.scope };
}
