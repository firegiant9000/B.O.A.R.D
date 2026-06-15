import { signJwt, verifyJwt, type JwtVerifyError } from "./jwt";

// Embed-token contract (Month 4, Phase 8). The link the host app embeds carries a
// short-lived signed JWT minted by `mintEmbedToken`. The embed page sends it to
// `exchangeEmbedToken`, which verifies it here and mints a Firebase custom token
// whose claims (below) the security rules check. Firestore never trusts the JWT
// directly — only the resulting auth claims — so the embed read path is just a
// scoped auth identity, rules-tested like any other.

/** Only read-only embeds ship in Phase 8. The 'edit' arm is reserved so the link
 *  format and rules don't have to change when M5/M6 wire editable integrations. */
export type EmbedScope = "view" | "edit";

/** Schema version on the token so a future shape change can be rejected rather
 *  than silently misread (element-schema-churn discipline from the roadmap). */
export const EMBED_TOKEN_VERSION = 1;

/** Default lifetime: short-lived per the roadmap's named embed risk. One hour is
 *  long enough for a page to load + exchange, short enough that a leaked link
 *  expires fast. The host app re-mints on each render. */
export const EMBED_TOKEN_TTL_SECONDS = 60 * 60;

export interface EmbedTokenPayload {
  v: number;
  boardId: string;
  scope: EmbedScope;
  iat: number; // seconds since epoch
  exp: number; // seconds since epoch
}

/** Mints a signed embed token for a board. `nowMs` is injected for testability. */
export function mintEmbedToken(
  args: { boardId: string; scope: EmbedScope; secret: string; nowMs: number; ttlSeconds?: number }
): { token: string; expSeconds: number } {
  const iat = Math.floor(args.nowMs / 1000);
  const exp = iat + (args.ttlSeconds ?? EMBED_TOKEN_TTL_SECONDS);
  const payload: EmbedTokenPayload = {
    v: EMBED_TOKEN_VERSION,
    boardId: args.boardId,
    scope: args.scope,
    iat,
    exp,
  };
  return { token: signJwt(payload, args.secret), expSeconds: exp };
}

export type EmbedVerifyError = JwtVerifyError | "bad-version" | "bad-payload";

export interface EmbedVerifyResult {
  ok: boolean;
  payload?: EmbedTokenPayload;
  error?: EmbedVerifyError;
}

/** Verifies an embed token: signature + expiry (via verifyJwt) then payload shape
 *  + version. `nowMs` injected for testability. */
export function verifyEmbedToken(
  token: string,
  secret: string,
  nowMs: number
): EmbedVerifyResult {
  const res = verifyJwt<EmbedTokenPayload>(token, secret, Math.floor(nowMs / 1000));
  if (!res.ok || !res.payload) return { ok: false, error: res.error };

  const p = res.payload;
  if (p.v !== EMBED_TOKEN_VERSION) return { ok: false, error: "bad-version" };
  if (
    typeof p.boardId !== "string" ||
    p.boardId === "" ||
    (p.scope !== "view" && p.scope !== "edit")
  ) {
    return { ok: false, error: "bad-payload" };
  }
  return { ok: true, payload: p };
}
