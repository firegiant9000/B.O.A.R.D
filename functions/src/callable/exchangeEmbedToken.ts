import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import {
  verifyEmbedToken,
  isAllowedIssuer,
  normalizeIssuer,
  parseIssuerAllowlist,
  type EmbedScope,
} from "../embed/token";
import { EMBED_JWT_SECRET, EMBED_ALLOWED_ISSUERS } from "../config";

// Exchange a signed embed token for a Firebase custom token (Month 4 — read-only;
// Month 5 — editable). UNAUTHENTICATED on purpose: this is how a viewer inside a
// host panel, with no B.O.A.R.D account, gets an identity. The token is the only
// credential: we verify its signature + expiry, then mint a custom token carrying
// embed claims the security rules check. The resulting identity can only touch the
// one board the token names (rules gate on `embedBoardId`), read-only unless the
// token's scope is 'edit'. This is the auth path that bypasses the normal member
// gate, so it is deliberately narrow and the rules path is explicitly tested.
//
// ⚠️ This function turns a host's ASSERTION into an identity. See the trust-model
// note at the top of ../embed/token.ts before touching the uid derivation below:
// the namespacing and the issuer allowlist are what keep a host's assertions
// inside that host's own sandbox instead of landing on real accounts.

export interface ExchangeEmbedTokenRequest {
  token: string;
}

export interface ExchangeEmbedTokenResponse {
  customToken: string;
  boardId: string;
  scope: EmbedScope;
}

export interface ExchangeEmbedTokenDeps {
  /** HS256 signing secret the embed token was minted with. */
  secret: string;
  /** Hosts whose `iss` we accept, already parsed (see config.EMBED_ALLOWED_ISSUERS). */
  allowedIssuers: readonly string[];
  mintCustomToken: (uid: string, claims: object) => Promise<string>;
}

/** Custom-token uid for an ANONYMOUS embed identity (a read-only token carrying no
 *  subject). Deterministic per board so concurrent viewers of the same board share
 *  one anonymous identity — they never write, so there's nothing to collide on —
 *  and it can never equal a real user uid. */
export function embedUid(boardId: string): string {
  return `embed:${boardId}`;
}

/** Custom-token uid for a HOST-ASSERTED embed identity (Month 5).
 *
 *  The namespace is the whole security property. `sub` is a string a host chose;
 *  mapping it straight onto a uid would mean a host — or anyone who obtained the
 *  signing secret — could assert `sub` equal to a real B.O.A.R.D uid and be handed
 *  a custom token authenticating AS that user. That is full account takeover, not
 *  scoped board access. Prefixing with a VALIDATED issuer fixes both halves of the
 *  problem: the result lives in a space no real Firebase uid occupies, and two
 *  hosts asserting the same subject land on two different identities instead of
 *  colliding onto one.
 *
 *  Stable by construction — the same (iss, sub) always maps to the same uid, which
 *  is what makes presence, comments and the activity feed attribute consistently
 *  across sessions.
 *
 *  `iss` MUST be allowlisted before it reaches here (the caller below does it); an
 *  unvalidated issuer would make this namespace decorative, since an attacker
 *  would simply pick the issuer string they wanted. */
export function embedIdentityUid(iss: string, sub: string): string {
  return `embed:${iss}:${sub}`;
}

export async function handleExchangeEmbedToken(
  req: CallableRequest<ExchangeEmbedTokenRequest>,
  deps: ExchangeEmbedTokenDeps,
  nowMs: number
): Promise<ExchangeEmbedTokenResponse> {
  const token = req.data?.token;
  if (!token) {
    throw new HttpsError("invalid-argument", "token is required.");
  }

  const result = verifyEmbedToken(token, deps.secret, nowMs);
  if (!result.ok || !result.payload) {
    // Expiry is the one case worth distinguishing for the client UX ("link
    // expired" vs "invalid link"); everything else is a flat permission denial so
    // a forged/tampered token leaks nothing about why it failed.
    if (result.error === "expired") {
      throw new HttpsError("deadline-exceeded", "This embed link has expired.");
    }
    throw new HttpsError("permission-denied", "Invalid embed link.");
  }

  const { boardId, scope, sub, iss } = result.payload;

  // verifyEmbedToken guarantees sub and iss travel together, so this is the single
  // place identity is or isn't present. The issuer is canonicalised HERE, before it
  // is either checked or turned into a uid — a token minted with "MEET" and one
  // minted with "meet" must resolve to the same person, not to two.
  const identity =
    sub !== undefined && iss !== undefined ? { sub, iss: normalizeIssuer(iss) } : null;

  if (identity && !isAllowedIssuer(identity.iss, deps.allowedIssuers)) {
    // Same flat denial as a forged token — we don't tell a caller which issuers
    // exist. This is the check that gives the uid namespace its meaning.
    throw new HttpsError("permission-denied", "Invalid embed link.");
  }

  // Belt and braces. verifyEmbedToken already refuses an edit token with no
  // subject, so this cannot fire today — but if that ever regressed, falling
  // through would hand every edit-scoped viewer of a board the SAME shared
  // anonymous uid, making their writes mutually unattributable. Fail instead.
  if (scope === "edit" && !identity) {
    throw new HttpsError("permission-denied", "Invalid embed link.");
  }

  const uid = identity ? embedIdentityUid(identity.iss, identity.sub) : embedUid(boardId);
  const claims = identity
    ? {
        embed: true,
        embedBoardId: boardId,
        embedScope: scope,
        // Carried as claims as well as encoded in the uid so rules and the UI can
        // read them without parsing a uid. Host-supplied text — display it as
        // untrusted, never as a verified name.
        embedIssuer: identity.iss,
        embedSubject: identity.sub,
      }
    : { embed: true, embedBoardId: boardId, embedScope: scope };

  const customToken = await deps.mintCustomToken(uid, claims);
  return { customToken, boardId, scope };
}

export const exchangeEmbedToken_fn = onCall(
  { secrets: [EMBED_JWT_SECRET] },
  (req: CallableRequest<ExchangeEmbedTokenRequest>) =>
    handleExchangeEmbedToken(
      req,
      {
        secret: EMBED_JWT_SECRET.value(),
        allowedIssuers: parseIssuerAllowlist(EMBED_ALLOWED_ISSUERS.value()),
        mintCustomToken: (uid, claims) => getAuth().createCustomToken(uid, claims),
      },
      Date.now()
    )
);
