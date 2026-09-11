import { signJwt, verifyJwt, type JwtVerifyError } from "./jwt";

// Embed-token contract (Month 4 — read-only embeds; Month 5 — editable embeds).
// The link the host app embeds carries a short-lived signed JWT minted by
// `mintEmbedToken`. The embed page sends it to `exchangeEmbedToken`, which
// verifies it here and mints a Firebase custom token whose claims the security
// rules check. Firestore never trusts the JWT directly — only the resulting auth
// claims — so an embed session is just a scoped auth identity, rules-tested like
// any other.
//
// ⚠️ TRUST MODEL — read before changing anything below.
// The token is signed with a SHARED SECRET held by this Functions runtime. A v2
// token carries `sub` (the host's own id for its user) and `iss` (which host said
// so). That pair is an ASSERTION, not proof: whoever can obtain a validly signed
// token for an issuer can claim to be any subject under that issuer. What the
// design buys is BLAST RADIUS, not authentication:
//   - `iss` is checked against a server-side allowlist, so an unknown host cannot
//     name itself into existence;
//   - the exchanged uid is namespaced per issuer, so a host can only ever mint
//     identities inside its own namespace and can never land on a real B.O.A.R.D
//     uid or on another host's subject.
// A compromised allowlisted host can therefore impersonate ITS OWN users to each
// other. It cannot become a B.O.A.R.D account, and it cannot reach a board its
// token does not name. Do not describe this token as proving who the user is.

/** The access an embed token grants. 'view' is the read-only embed (Month 4);
 *  'edit' is the host-integration write scope (Month 5) and requires a v2 token
 *  carrying a host-asserted subject. */
export type EmbedScope = "view" | "edit";

/** Schema version on the token so a shape change is rejected rather than silently
 *  misread (element-schema-churn discipline from the roadmap). v2 added `sub`/`iss`. */
export const EMBED_TOKEN_VERSION = 2;

/** The one pre-v2 version still accepted. v1 predates host-asserted identity, so a
 *  v1 token can only ever have meant a read-only embed — it verifies for
 *  `scope: "view"` and nothing else. Existing embeds in the wild keep working;
 *  a v1 token asking for `edit` is rejected as `bad-version`. */
const EMBED_TOKEN_LEGACY_VERSION = 1;

/** Default lifetime: short-lived per the roadmap's named embed risk. One hour is
 *  long enough for a page to load + exchange, short enough that a leaked link
 *  expires fast. The host app re-mints on each render. */
export const EMBED_TOKEN_TTL_SECONDS = 60 * 60;

/** Caps on the host-asserted pair. Both feed `embed:<iss>:<sub>`, which becomes a
 *  Firebase Auth uid — hard-limited to 128 characters — so an unbounded subject
 *  would turn into a runtime failure inside createCustomToken rather than a clean
 *  rejection here. 64 + 32 + the 7-character prefix stays comfortably under. */
export const MAX_EMBED_SUBJECT_LENGTH = 64;
export const MAX_EMBED_ISSUER_LENGTH = 32;

/** Issuer ids are restricted to this shape so `embed:<iss>:<sub>` has an
 *  unambiguous prefix — a colon inside `iss` would let one issuer's namespace
 *  masquerade as another's. Enforced when the allowlist is parsed, so an
 *  unparseable entry is dropped rather than silently trusted. */
const ISSUER_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export interface EmbedTokenPayload {
  v: number;
  boardId: string;
  scope: EmbedScope;
  iat: number; // seconds since epoch
  exp: number; // seconds since epoch
  /** v2 — the host's own identifier for the user driving the embed. Host-asserted;
   *  see the trust-model note above. Required for `scope: "edit"`. */
  sub?: string;
  /** v2 — which host asserted `sub`. Validated against the Functions-side issuer
   *  allowlist before it is ever turned into an identity. */
  iss?: string;
}

/** Mints a signed embed token for a board. `nowMs` is injected for testability.
 *  Pass `sub` + `iss` together or not at all; `scope: "edit"` requires them. */
export function mintEmbedToken(
  args: {
    boardId: string;
    scope: EmbedScope;
    secret: string;
    nowMs: number;
    ttlSeconds?: number;
    sub?: string;
    iss?: string;
  }
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
  // Only set the identity pair when the caller supplied it, so an anonymous view
  // token stays byte-identical in shape to the Month 4 one it replaces.
  if (args.sub !== undefined) payload.sub = args.sub;
  if (args.iss !== undefined) payload.iss = args.iss;
  return { token: signJwt(payload, args.secret), expSeconds: exp };
}

export type EmbedVerifyError = JwtVerifyError | "bad-version" | "bad-payload";

export interface EmbedVerifyResult {
  ok: boolean;
  payload?: EmbedTokenPayload;
  error?: EmbedVerifyError;
}

/** Whether an optional host-asserted string is absent, or present and within the
 *  shape this contract accepts. A present-but-wrong value is a hard rejection, not
 *  a silently dropped field — dropping it would downgrade an identity-bearing
 *  token to an anonymous one instead of failing. */
function optionalIdentityFieldOk(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value !== "" && value.length <= maxLength)
  );
}

/** Verifies an embed token: signature + expiry (via verifyJwt), then version, then
 *  payload shape. `nowMs` injected for testability.
 *
 *  This deliberately does NOT check `iss` against the allowlist: the allowlist is
 *  deployment configuration and this module stays pure. The exchange applies it
 *  before `iss` is turned into an identity (see exchangeEmbedToken.ts). */
export function verifyEmbedToken(
  token: string,
  secret: string,
  nowMs: number
): EmbedVerifyResult {
  const res = verifyJwt<EmbedTokenPayload>(token, secret, Math.floor(nowMs / 1000));
  if (!res.ok || !res.payload) return { ok: false, error: res.error };

  const p = res.payload;

  // Version first: an unknown version's payload shape is not ours to interpret.
  if (p.v !== EMBED_TOKEN_VERSION && p.v !== EMBED_TOKEN_LEGACY_VERSION) {
    return { ok: false, error: "bad-version" };
  }

  if (
    typeof p.boardId !== "string" ||
    p.boardId === "" ||
    (p.scope !== "view" && p.scope !== "edit")
  ) {
    return { ok: false, error: "bad-payload" };
  }

  if (p.v === EMBED_TOKEN_LEGACY_VERSION) {
    // A v1 minter had no way to attach a subject, so a v1 'edit' token is either a
    // forgery attempt or a stale caller. Either way it must never reach the write
    // path unattributed. This TIGHTENS a previously-permissive path: v1 + edit
    // verified before Month 5.
    if (p.scope !== "view") return { ok: false, error: "bad-version" };
    // v1 has no identity fields. A v1 token carrying them is not a shape this
    // contract ever produced, so reject rather than let it through and have the
    // exchange namespace an identity out of a version that cannot express one.
    if (p.sub !== undefined || p.iss !== undefined) {
      return { ok: false, error: "bad-payload" };
    }
    return { ok: true, payload: p };
  }

  // v2 identity rules.
  if (
    !optionalIdentityFieldOk(p.sub, MAX_EMBED_SUBJECT_LENGTH) ||
    !optionalIdentityFieldOk(p.iss, MAX_EMBED_ISSUER_LENGTH)
  ) {
    return { ok: false, error: "bad-payload" };
  }
  // A subject with no issuer cannot be namespaced, and an issuer with no subject
  // names nobody — neither half is meaningful alone.
  if ((p.sub === undefined) !== (p.iss === undefined)) {
    return { ok: false, error: "bad-payload" };
  }
  // An editable embed writes as somebody. No subject, no edit.
  if (p.scope === "edit" && p.sub === undefined) {
    return { ok: false, error: "bad-payload" };
  }

  return { ok: true, payload: p };
}

/** Parses the Functions-side issuer allowlist from its configured string form
 *  (comma-separated). Entries are trimmed and lower-cased; anything that does not
 *  match `ISSUER_PATTERN` — an empty entry, a wildcard, anything containing the
 *  namespace separator — is DROPPED rather than trusted. An unset or empty value
 *  yields an empty allowlist, which denies every identity-bearing token: the embed
 *  read path keeps working, the write path fails closed until a host is listed. */
export function parseIssuerAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(normalizeIssuer)
    .filter((entry) => entry.length <= MAX_EMBED_ISSUER_LENGTH && ISSUER_PATTERN.test(entry));
}

/** The canonical form of an issuer id. Everything that turns `iss` into an
 *  identity MUST go through this first. Without it "MEET" and "meet" would clear
 *  the same allowlist entry but produce two different uids — the same person on
 *  the same host would be two users, silently, depending on how the caller cased
 *  a string. Canonicalising is what makes the mapping actually stable. */
export function normalizeIssuer(iss: string): string {
  return iss.trim().toLowerCase();
}

/** Whether a token's `iss` names a host we actually trust. Case-insensitive so an
 *  issuer cannot be smuggled past the list by re-casing it. */
export function isAllowedIssuer(iss: string, allowed: readonly string[]): boolean {
  return allowed.includes(normalizeIssuer(iss));
}
