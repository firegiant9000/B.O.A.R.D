import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { verifyEmbedToken, type EmbedScope } from "../embed/token";
import { EMBED_JWT_SECRET } from "../config";

// Exchange a signed embed token for a Firebase custom token (Month 4, Phase 8).
// UNAUTHENTICATED on purpose — this is how an embed viewer with no account gets an
// identity. The token is the only credential: we verify its signature + expiry,
// then mint a custom token carrying embed claims the security rules check. The
// resulting identity can ONLY read the one board the token names (rules gate on
// `embedBoardId`), and only reads (rules deny writes for an embed identity). This
// is the auth path that bypasses the normal member gate, so it is deliberately
// narrow and the rules path is explicitly tested.

export interface ExchangeEmbedTokenRequest {
  token: string;
}

export interface ExchangeEmbedTokenResponse {
  customToken: string;
  boardId: string;
  scope: EmbedScope;
}

/** Custom-token uid for an embed identity. Deterministic per board so concurrent
 *  embed viewers of the same board share one anonymous identity (they never write,
 *  so there's nothing to collide on) and it can never equal a real user uid. */
export function embedUid(boardId: string): string {
  return `embed:${boardId}`;
}

export async function handleExchangeEmbedToken(
  req: CallableRequest<ExchangeEmbedTokenRequest>,
  secret: string,
  nowMs: number,
  mintCustomToken: (uid: string, claims: object) => Promise<string>
): Promise<ExchangeEmbedTokenResponse> {
  const token = req.data?.token;
  if (!token) {
    throw new HttpsError("invalid-argument", "token is required.");
  }

  const result = verifyEmbedToken(token, secret, nowMs);
  if (!result.ok || !result.payload) {
    // Expiry is the one case worth distinguishing for the client UX ("link
    // expired" vs "invalid link"); everything else is a flat permission denial so
    // a forged/tampered token leaks nothing about why it failed.
    if (result.error === "expired") {
      throw new HttpsError("deadline-exceeded", "This embed link has expired.");
    }
    throw new HttpsError("permission-denied", "Invalid embed link.");
  }

  const { boardId, scope } = result.payload;
  const customToken = await mintCustomToken(embedUid(boardId), {
    embed: true,
    embedBoardId: boardId,
    embedScope: scope,
  });
  return { customToken, boardId, scope };
}

export const exchangeEmbedToken_fn = onCall(
  { secrets: [EMBED_JWT_SECRET] },
  (req: CallableRequest<ExchangeEmbedTokenRequest>) =>
    handleExchangeEmbedToken(
      req,
      EMBED_JWT_SECRET.value(),
      Date.now(),
      (uid, claims) => getAuth().createCustomToken(uid, claims)
    )
);
