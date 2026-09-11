import { signJwt, verifyJwt } from "../embed/jwt";
import {
  mintEmbedToken,
  verifyEmbedToken,
  isAllowedIssuer,
  parseIssuerAllowlist,
  EMBED_TOKEN_VERSION,
  EMBED_TOKEN_TTL_SECONDS,
  EMBED_EDIT_TOKEN_TTL_SECONDS,
  MAX_EMBED_SUBJECT_LENGTH,
} from "../embed/token";
import {
  handleExchangeEmbedToken,
  embedUid,
  embedIdentityUid,
} from "../callable/exchangeEmbedToken";
import { handleMintEmbedToken } from "../callable/mintEmbedToken";
import type { CallableRequest } from "firebase-functions/v2/https";

const SECRET = "test-embed-secret";
const NOW_MS = 1_700_000_000_000; // fixed clock
const NOW_S = Math.floor(NOW_MS / 1000);

describe("HS256 jwt util", () => {
  it("round-trips a payload", () => {
    const token = signJwt({ a: 1, exp: NOW_S + 100 }, SECRET);
    const res = verifyJwt<{ a: number; exp: number }>(token, SECRET, NOW_S);
    expect(res.ok).toBe(true);
    expect(res.payload?.a).toBe(1);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signJwt({ exp: NOW_S + 100 }, "other-secret");
    expect(verifyJwt(token, SECRET, NOW_S)).toMatchObject({ ok: false, error: "bad-signature" });
  });

  it("rejects a tampered payload", () => {
    const token = signJwt({ scope: "view", exp: NOW_S + 100 }, SECRET);
    const [h, , s] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ scope: "edit", exp: NOW_S + 100 }))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const forged = `${h}.${forgedBody}.${s}`;
    expect(verifyJwt(forged, SECRET, NOW_S)).toMatchObject({ ok: false, error: "bad-signature" });
  });

  it("rejects an expired token", () => {
    const token = signJwt({ exp: NOW_S - 1 }, SECRET);
    expect(verifyJwt(token, SECRET, NOW_S)).toMatchObject({ ok: false, error: "expired" });
  });

  it("rejects a malformed token", () => {
    expect(verifyJwt("not.a.jwt.at.all", SECRET, NOW_S)).toMatchObject({ ok: false });
    expect(verifyJwt("missingdots", SECRET, NOW_S)).toMatchObject({ ok: false, error: "malformed" });
  });
});

describe("embed token mint/verify", () => {
  it("mints a token verifiable within its lifetime", () => {
    const { token, expSeconds } = mintEmbedToken({ boardId: "b1", scope: "view", secret: SECRET, nowMs: NOW_MS });
    expect(expSeconds).toBe(NOW_S + EMBED_TOKEN_TTL_SECONDS);
    const res = verifyEmbedToken(token, SECRET, NOW_MS);
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ boardId: "b1", scope: "view", v: EMBED_TOKEN_VERSION });
  });

  it("preserves scope through the round-trip", () => {
    // Month 5 — an edit token must now carry a host-asserted subject to verify at
    // all (see "embed token v2" below); the assertion is unchanged.
    const { token } = mintEmbedToken({
      boardId: "b1", scope: "edit", sub: "host:u1", iss: "meet", secret: SECRET, nowMs: NOW_MS,
    });
    expect(verifyEmbedToken(token, SECRET, NOW_MS).payload?.scope).toBe("edit");
  });

  it("rejects after expiry", () => {
    const { token } = mintEmbedToken({ boardId: "b1", scope: "view", secret: SECRET, nowMs: NOW_MS, ttlSeconds: 10 });
    const res = verifyEmbedToken(token, SECRET, NOW_MS + 11_000);
    expect(res).toMatchObject({ ok: false, error: "expired" });
  });

  it("rejects a wrong-version token", () => {
    const token = signJwt({ v: 999, boardId: "b1", scope: "view", iat: NOW_S, exp: NOW_S + 100 }, SECRET);
    expect(verifyEmbedToken(token, SECRET, NOW_MS)).toMatchObject({ ok: false, error: "bad-version" });
  });

  it("rejects a payload missing boardId", () => {
    const token = signJwt({ v: EMBED_TOKEN_VERSION, scope: "view", iat: NOW_S, exp: NOW_S + 100 }, SECRET);
    expect(verifyEmbedToken(token, SECRET, NOW_MS)).toMatchObject({ ok: false, error: "bad-payload" });
  });
});

// ── Month 5 — v2 token with host-asserted identity ────────────────────────────
// Aliased to the brief's names so each case reads as the contract it pins.
const S = SECRET;
const T = NOW_MS;

function base64url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Re-encodes a token's body without touching its signature. The header and the
 *  JSON body stay well-formed, so the only thing wrong with the result is that the
 *  signature no longer covers it — which is exactly what the forgery cases test. */
function tamper(token: string, patch: Record<string, unknown>): string {
  const [h, b, s] = token.split(".");
  const body = JSON.parse(Buffer.from(b, "base64").toString("utf8")) as Record<string, unknown>;
  return `${h}.${base64url(JSON.stringify({ ...body, ...patch }))}.${s}`;
}

describe("embed token v2", () => {
  // A v1 view token and a v1 edit token that differ in NOTHING but `scope`, so the
  // v1-edit rejection below cannot pass for an unrelated reason.
  const v1Payload = { v: 1, boardId: "b1", iat: NOW_S, exp: NOW_S + EMBED_TOKEN_TTL_SECONDS };
  const v1ViewToken = signJwt({ ...v1Payload, scope: "view" }, S);
  const v1EditToken = signJwt({ ...v1Payload, scope: "edit" }, S);
  // A v2 edit token that is well-formed in every other respect: right secret,
  // unexpired, real boardId, current version. Only `sub`/`iss` are absent.
  const editTokenNoSub = signJwt(
    { v: 2, boardId: "b1", scope: "edit", iat: NOW_S, exp: NOW_S + EMBED_TOKEN_TTL_SECONDS },
    S
  );
  const { token } = mintEmbedToken({
    boardId: "b1", scope: "edit", sub: "host:u9", iss: "meet", secret: S, nowMs: T,
  });
  const tamperedBoardId = tamper(token, { boardId: "b2" });

  it("mints an edit token carrying the subject", () => {
    const { token } = mintEmbedToken({ boardId: "b1", scope: "edit", sub: "host:u9", iss: "meet", secret: S, nowMs: T });
    expect(verifyEmbedToken(token, S, T).payload).toMatchObject({ v: 2, sub: "host:u9", iss: "meet" });
  });

  it("still accepts a v1 view token", () => {
    expect(verifyEmbedToken(v1ViewToken, S, T).ok).toBe(true);
  });

  it("rejects a v1 token that requests edit", () => {
    expect(verifyEmbedToken(v1EditToken, S, T).error).toBe("bad-version");
  });

  it("rejects an edit token with no subject", () => {
    expect(verifyEmbedToken(editTokenNoSub, S, T).error).toBe("bad-payload");
  });

  it("rejects a token signed with the wrong secret", () => {
    expect(verifyEmbedToken(token, "wrong-secret", T).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    expect(verifyEmbedToken(token, S, T + EMBED_TOKEN_TTL_SECONDS * 1000 + 1).ok).toBe(false);
    expect(verifyEmbedToken(token, S, T + EMBED_TOKEN_TTL_SECONDS * 1000 + 1).error).toBe("expired");
  });

  it("rejects a token whose boardId was tampered with", () => {
    expect(verifyEmbedToken(tamperedBoardId, S, T).ok).toBe(false);
  });

  // Falsifiability guards for the two forgery cases above: prove each is rejected
  // by the SIGNATURE check and not because the fixture happened to be malformed,
  // out of date or otherwise invalid on its own terms.
  it("the forgery rejections are signature failures, not shape failures", () => {
    expect(verifyEmbedToken(token, "wrong-secret", T).error).toBe("bad-signature");
    expect(verifyEmbedToken(tamperedBoardId, S, T).error).toBe("bad-signature");
    // The tampered body, re-signed with the real secret, verifies cleanly — so the
    // rejection above was the HMAC, not the payload.
    const [, b] = tamperedBoardId.split(".");
    const body = JSON.parse(Buffer.from(b, "base64").toString("utf8")) as object;
    expect(verifyEmbedToken(signJwt(body, S), S, T)).toMatchObject({
      ok: true,
      payload: { boardId: "b2", scope: "edit" },
    });
  });

  it("accepts an anonymous v2 view token (the unchanged read-only embed)", () => {
    const { token: viewToken } = mintEmbedToken({ boardId: "b1", scope: "view", secret: S, nowMs: T });
    const res = verifyEmbedToken(viewToken, S, T);
    expect(res.ok).toBe(true);
    expect(res.payload?.sub).toBeUndefined();
  });

  it("rejects a v2 token carrying a subject with no issuer", () => {
    const half = signJwt(
      { v: 2, boardId: "b1", scope: "view", sub: "host:u9", iat: NOW_S, exp: NOW_S + 100 },
      S
    );
    expect(verifyEmbedToken(half, S, T).error).toBe("bad-payload");
  });

  it("rejects a v2 token carrying an issuer with no subject", () => {
    const half = signJwt(
      { v: 2, boardId: "b1", scope: "view", iss: "meet", iat: NOW_S, exp: NOW_S + 100 },
      S
    );
    expect(verifyEmbedToken(half, S, T).error).toBe("bad-payload");
  });

  it("rejects a subject longer than the uid budget", () => {
    const long = "x".repeat(MAX_EMBED_SUBJECT_LENGTH + 1);
    const ok = signJwt(
      { v: 2, boardId: "b1", scope: "edit", sub: "x".repeat(MAX_EMBED_SUBJECT_LENGTH), iss: "meet", iat: NOW_S, exp: NOW_S + 100 },
      S
    );
    const tooLong = signJwt(
      { v: 2, boardId: "b1", scope: "edit", sub: long, iss: "meet", iat: NOW_S, exp: NOW_S + 100 },
      S
    );
    // The pair differs only in subject length, so the rejection is the length rule.
    expect(verifyEmbedToken(ok, S, T).ok).toBe(true);
    expect(verifyEmbedToken(tooLong, S, T).error).toBe("bad-payload");
  });

  it("rejects a v1 token carrying identity fields it could never have minted", () => {
    // Differs from the accepted v1 view token ONLY by the presence of sub/iss.
    const v1WithIdentity = signJwt(
      { ...v1Payload, scope: "view", sub: "host:u9", iss: "meet" },
      S
    );
    expect(verifyEmbedToken(signJwt({ ...v1Payload, scope: "view" }, S), S, T).ok).toBe(true);
    expect(verifyEmbedToken(v1WithIdentity, S, T).error).toBe("bad-payload");
  });

  it("rejects a subject that could not be a presence document id", () => {
    // The uid becomes the doc id under presence/{userId} and cursors/{userId}. A
    // '/' there yields a uid that can never satisfy the rules' isOwner(userId),
    // silently killing presence for that host user. The pair differs only in that
    // one character, so the rejection is the character set.
    const ok = signJwt(
      { v: 2, boardId: "b1", scope: "edit", sub: "host.u9", iss: "meet", iat: NOW_S, exp: NOW_S + 100 },
      S
    );
    const slash = signJwt(
      { v: 2, boardId: "b1", scope: "edit", sub: "host/u9", iss: "meet", iat: NOW_S, exp: NOW_S + 100 },
      S
    );
    expect(verifyEmbedToken(ok, S, T).ok).toBe(true);
    expect(verifyEmbedToken(slash, S, T).error).toBe("bad-payload");
  });

  it("rejects a malformed issuer on its own terms, without consulting an allowlist", () => {
    // verifyEmbedToken takes no allowlist by design. It must still refuse an `iss`
    // that could break the `embed:<iss>:<sub>` namespace, so the module is
    // self-defending rather than safe only because its caller's allowlist happens
    // to be well formed.
    const colon = signJwt(
      { v: 2, boardId: "b1", scope: "edit", sub: "u9", iss: "meet:evil", iat: NOW_S, exp: NOW_S + 100 },
      S
    );
    expect(verifyEmbedToken(colon, S, T).error).toBe("bad-payload");
  });

  it("accepts an issuer whose canonical form is valid, so case-stability survives", () => {
    // The pattern is lower-case; `iss` is matched against its canonical form, not
    // its raw one, or "MEET" would be rejected here and the exchange could never
    // canonicalise it.
    const upper = signJwt(
      { v: 2, boardId: "b1", scope: "edit", sub: "u9", iss: "MEET", iat: NOW_S, exp: NOW_S + 100 },
      S
    );
    expect(verifyEmbedToken(upper, S, T).ok).toBe(true);
  });

  it("rejects a non-string subject", () => {
    const weird = signJwt(
      { v: 2, boardId: "b1", scope: "edit", sub: 9, iss: "meet", iat: NOW_S, exp: NOW_S + 100 },
      S
    );
    expect(verifyEmbedToken(weird, S, T).error).toBe("bad-payload");
  });
});

// ── Month 5 — issuer-namespaced identity ──────────────────────────────────────
describe("embed identity uid", () => {
  it("namespaces the host subject so it can never equal a real uid", () => {
    // `alice` is the shape of a real B.O.A.R.D uid. A host asserting it must NOT
    // be handed that account's identity — this is the account-takeover case.
    expect(embedIdentityUid("meet", "alice")).not.toBe("alice");
    expect(embedIdentityUid("meet", "alice")).toBe("embed:meet:alice");
  });

  it("gives two hosts asserting the same subject two different identities", () => {
    expect(embedIdentityUid("meet", "u9")).not.toBe(embedIdentityUid("extension", "u9"));
  });

  it("is stable: the same (iss, sub) always maps to the same uid", () => {
    expect(embedIdentityUid("meet", "u9")).toBe(embedIdentityUid("meet", "u9"));
  });

  it("never collides with the anonymous per-board view uid", () => {
    expect(embedIdentityUid("meet", "u9")).not.toBe(embedUid("b1"));
    expect(embedIdentityUid("meet", "u9")).not.toBe(embedUid("meet"));
  });
});

describe("issuer allowlist", () => {
  it("parses a comma-separated list, trimming and lower-casing", () => {
    expect(parseIssuerAllowlist(" meet , Extension ")).toEqual(["meet", "extension"]);
  });

  it("drops entries that could break the uid namespace", () => {
    // A colon in an issuer would make `embed:<iss>:<sub>` ambiguous; a wildcard or
    // an empty entry would make the allowlist meaningless.
    expect(parseIssuerAllowlist("meet,a:b,*,,ok_1")).toEqual(["meet", "ok_1"]);
  });

  it("treats an unset or empty value as an empty allowlist (fail closed)", () => {
    expect(parseIssuerAllowlist(undefined)).toEqual([]);
    expect(parseIssuerAllowlist("   ")).toEqual([]);
  });

  it("matches only listed issuers", () => {
    const allowed = ["meet", "extension"];
    expect(isAllowedIssuer("meet", allowed)).toBe(true);
    expect(isAllowedIssuer("evil-host", allowed)).toBe(false);
    // Case-insensitive, so an issuer cannot be smuggled past by casing it oddly.
    expect(isAllowedIssuer("MEET", allowed)).toBe(true);
  });
});

describe("handleExchangeEmbedToken", () => {
  const mint = jest.fn(async (uid: string, claims: object) => `custom(${uid},${JSON.stringify(claims)})`);
  const deps = () => ({ secret: SECRET, allowedIssuers: ["meet", "extension"], mintCustomToken: mint });
  const reqOf = (token?: string) =>
    ({ data: token === undefined ? {} : { token } } as CallableRequest<{ token: string }>);

  beforeEach(() => mint.mockClear());

  it("mints a custom token with embed claims for a valid token", async () => {
    const { token } = mintEmbedToken({ boardId: "b9", scope: "view", secret: SECRET, nowMs: NOW_MS });
    const res = await handleExchangeEmbedToken(reqOf(token), deps(), NOW_MS);
    expect(res).toMatchObject({ boardId: "b9", scope: "view" });
    expect(mint).toHaveBeenCalledWith(embedUid("b9"), {
      embed: true,
      embedBoardId: "b9",
      embedScope: "view",
    });
  });

  it("rejects a missing token", async () => {
    await expect(handleExchangeEmbedToken(reqOf(undefined), deps(), NOW_MS)).rejects.toThrow();
    expect(mint).not.toHaveBeenCalled();
  });

  it("maps expiry to a distinct error and never mints", async () => {
    const { token } = mintEmbedToken({ boardId: "b1", scope: "view", secret: SECRET, nowMs: NOW_MS, ttlSeconds: 1 });
    await expect(
      handleExchangeEmbedToken(reqOf(token), deps(), NOW_MS + 5_000)
    ).rejects.toThrow(/expired/i);
    expect(mint).not.toHaveBeenCalled();
  });

  it("rejects a forged token without minting", async () => {
    const { token } = mintEmbedToken({ boardId: "b1", scope: "view", secret: "wrong", nowMs: NOW_MS });
    await expect(handleExchangeEmbedToken(reqOf(token), deps(), NOW_MS)).rejects.toThrow(/invalid/i);
    expect(mint).not.toHaveBeenCalled();
  });

  it("maps a host-asserted subject to an issuer-namespaced uid", async () => {
    const { token } = mintEmbedToken({
      boardId: "b9", scope: "edit", sub: "host:u9", iss: "meet", secret: SECRET, nowMs: NOW_MS,
    });
    const res = await handleExchangeEmbedToken(reqOf(token), deps(), NOW_MS);
    expect(res).toMatchObject({ boardId: "b9", scope: "edit" });
    expect(mint).toHaveBeenCalledWith("embed:meet:host:u9", {
      embed: true,
      embedBoardId: "b9",
      embedScope: "edit",
      embedIssuer: "meet",
      embedSubject: "host:u9",
    });
  });

  it("does NOT hand out a real user's identity when the host asserts their uid", async () => {
    // The account-takeover case: a host (or anyone holding the signing secret)
    // asserts `sub` equal to a real B.O.A.R.D uid. The custom token must be minted
    // for the namespaced identity, never for `alice`.
    const { token } = mintEmbedToken({
      boardId: "b9", scope: "edit", sub: "alice", iss: "meet", secret: SECRET, nowMs: NOW_MS,
    });
    await handleExchangeEmbedToken(reqOf(token), deps(), NOW_MS);
    const [uid] = mint.mock.calls[0];
    expect(uid).not.toBe("alice");
    expect(uid).toBe("embed:meet:alice");
  });

  it("is stable: exchanging the same (iss, sub) twice yields the same uid", async () => {
    const mk = (nowMs: number) =>
      mintEmbedToken({ boardId: "b9", scope: "edit", sub: "u9", iss: "meet", secret: SECRET, nowMs }).token;
    await handleExchangeEmbedToken(reqOf(mk(NOW_MS)), deps(), NOW_MS);
    await handleExchangeEmbedToken(reqOf(mk(NOW_MS + 1000)), deps(), NOW_MS + 1000);
    expect(mint.mock.calls[0][0]).toBe(mint.mock.calls[1][0]);
  });

  it("is case-stable: the same host cased differently yields one identity", async () => {
    // "MEET" clears the allowlist (isAllowedIssuer is case-insensitive), so without
    // canonicalisation it would mint `embed:MEET:u9` — a second, separate person.
    const upper = mintEmbedToken({
      boardId: "b9", scope: "edit", sub: "u9", iss: "MEET", secret: SECRET, nowMs: NOW_MS,
    }).token;
    const lower = mintEmbedToken({
      boardId: "b9", scope: "edit", sub: "u9", iss: "meet", secret: SECRET, nowMs: NOW_MS,
    }).token;
    await handleExchangeEmbedToken(reqOf(upper), deps(), NOW_MS);
    await handleExchangeEmbedToken(reqOf(lower), deps(), NOW_MS);
    expect(mint.mock.calls[0][0]).toBe("embed:meet:u9");
    expect(mint.mock.calls[1][0]).toBe("embed:meet:u9");
  });

  it("rejects an issuer that is not on the allowlist, without minting", async () => {
    // Identical to the accepted case above except for `iss`, so the denial is the
    // allowlist and nothing else.
    const { token } = mintEmbedToken({
      boardId: "b9", scope: "edit", sub: "host:u9", iss: "evil-host", secret: SECRET, nowMs: NOW_MS,
    });
    await expect(handleExchangeEmbedToken(reqOf(token), deps(), NOW_MS)).rejects.toThrow(/invalid/i);
    expect(mint).not.toHaveBeenCalled();
  });

  it("rejects every issuer when the allowlist is empty (fail closed)", async () => {
    const { token } = mintEmbedToken({
      boardId: "b9", scope: "edit", sub: "host:u9", iss: "meet", secret: SECRET, nowMs: NOW_MS,
    });
    await expect(
      handleExchangeEmbedToken(reqOf(token), { ...deps(), allowedIssuers: [] }, NOW_MS)
    ).rejects.toThrow(/invalid/i);
    expect(mint).not.toHaveBeenCalled();
  });

  it("rejects a v1 token that asks for edit, without minting", async () => {
    const v1Edit = signJwt({ v: 1, boardId: "b9", scope: "edit", iat: NOW_S, exp: NOW_S + 100 }, SECRET);
    await expect(handleExchangeEmbedToken(reqOf(v1Edit), deps(), NOW_MS)).rejects.toThrow(/invalid/i);
    expect(mint).not.toHaveBeenCalled();
  });

  it("still exchanges a v1 view token (existing embeds keep working)", async () => {
    const v1View = signJwt({ v: 1, boardId: "b9", scope: "view", iat: NOW_S, exp: NOW_S + 100 }, SECRET);
    const res = await handleExchangeEmbedToken(reqOf(v1View), deps(), NOW_MS);
    expect(res).toMatchObject({ boardId: "b9", scope: "view" });
    expect(mint).toHaveBeenCalledWith(embedUid("b9"), {
      embed: true,
      embedBoardId: "b9",
      embedScope: "view",
    });
  });
});

describe("handleMintEmbedToken", () => {
  type MintOpts = Partial<{
    isMember: boolean;
    isAdmin: boolean;
    inWorkspace: boolean;
    found: boolean;
    legacy: boolean;
    allowedIssuers: string[];
  }>;
  const access = (over: MintOpts = {}) => ({
    workspaceId: over.legacy ? "" : "ws1",
    isMember: over.isMember ?? true,
    isAdmin: over.isAdmin ?? true,
  });
  const deps = (over: MintOpts = {}) => ({
    secret: SECRET,
    allowedIssuers: over.allowedIssuers ?? ["meet", "extension"],
    resolveAccess: jest.fn(async () => (over.found === false ? null : access(over))),
    isInWorkspace: jest.fn(async () => over.inWorkspace ?? true),
  });
  const reqOf = (uid: string | undefined, data: unknown) =>
    ({ auth: uid ? { uid } : undefined, data } as never);

  it("rejects an unauthenticated caller", async () => {
    await expect(handleMintEmbedToken(reqOf(undefined, { boardId: "b1" }), deps(), NOW_MS))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects a request with no boardId", async () => {
    await expect(handleMintEmbedToken(reqOf("u1", {}), deps(), NOW_MS))
      .rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects a board that does not exist", async () => {
    await expect(handleMintEmbedToken(reqOf("u1", { boardId: "b1" }), deps({ found: false }), NOW_MS))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects a non-member", async () => {
    await expect(handleMintEmbedToken(reqOf("u1", { boardId: "b1" }), deps({ isMember: false }), NOW_MS))
      .rejects.toMatchObject({ code: "permission-denied" });
  });

  it("mints an anonymous view token for any board member", async () => {
    const res = await handleMintEmbedToken(
      reqOf("u1", { boardId: "b1" }),
      deps({ isAdmin: false }),
      NOW_MS
    );
    expect(res.scope).toBe("view");
    const payload = verifyEmbedToken(res.token, SECRET, NOW_MS).payload;
    expect(payload).toMatchObject({ boardId: "b1", scope: "view", v: EMBED_TOKEN_VERSION });
    expect(payload?.sub).toBeUndefined();
  });

  it("mints an edit token for a board admin", async () => {
    const res = await handleMintEmbedToken(
      reqOf("u1", { boardId: "b1", scope: "edit", sub: "host:u9", iss: "meet" }),
      deps(),
      NOW_MS
    );
    expect(res.scope).toBe("edit");
    expect(verifyEmbedToken(res.token, SECRET, NOW_MS).payload).toMatchObject({
      v: 2, boardId: "b1", scope: "edit", sub: "host:u9", iss: "meet",
    });
  });

  it("denies an edit token to an admin who has been removed from the workspace", async () => {
    // Revocation is "remove them from the workspace": the rules' isBoardAdmin
    // requires inBoardWorkspace, so such a caller is denied every direct write.
    // Without this gate they could still mint an edit link and write as the embed
    // identity, turning revocation into a write-bypass. Same request as the
    // accepted case; only workspace membership differs.
    const d = deps({ inWorkspace: false });
    await expect(
      handleMintEmbedToken(
        reqOf("u1", { boardId: "b1", scope: "edit", sub: "host:u9", iss: "meet" }),
        d,
        NOW_MS
      )
    ).rejects.toMatchObject({ code: "permission-denied" });
    expect(d.isInWorkspace).toHaveBeenCalledWith("ws1", "u1");
  });

  it("does not pay for a workspace read on the read-only path", async () => {
    const d = deps();
    await handleMintEmbedToken(reqOf("u1", { boardId: "b1" }), d, NOW_MS);
    expect(d.isInWorkspace).not.toHaveBeenCalled();
  });

  it("refuses an edit token on a legacy board with no workspace", async () => {
    const d = deps({ legacy: true });
    await expect(
      handleMintEmbedToken(
        reqOf("u1", { boardId: "b1", scope: "edit", sub: "host:u9", iss: "meet" }),
        d,
        NOW_MS
      )
    ).rejects.toMatchObject({ code: "failed-precondition" });
    // Never silently falls through to an unverifiable workspace check.
    expect(d.isInWorkspace).not.toHaveBeenCalled();
  });

  it("still mints a read-only link on a legacy board", async () => {
    // The legacy refusal above is scoped to 'edit'; existing embeds must not break.
    const res = await handleMintEmbedToken(reqOf("u1", { boardId: "b1" }), deps({ legacy: true }), NOW_MS);
    expect(res.scope).toBe("view");
  });

  it("gives an editable link a much shorter redemption window than a read-only one", async () => {
    // The TTL bounds how long a leaked LINK stays redeemable. It does NOT bound the
    // Auth session redeeming it produces — see EMBED_EDIT_TOKEN_TTL_SECONDS.
    const view = await handleMintEmbedToken(reqOf("u1", { boardId: "b1" }), deps(), NOW_MS);
    const edit = await handleMintEmbedToken(
      reqOf("u1", { boardId: "b1", scope: "edit", sub: "host:u9", iss: "meet" }),
      deps(),
      NOW_MS
    );
    expect(view.expiresAt).toBe(NOW_S + EMBED_TOKEN_TTL_SECONDS);
    expect(edit.expiresAt).toBe(NOW_S + EMBED_EDIT_TOKEN_TTL_SECONDS);
    expect(EMBED_EDIT_TOKEN_TTL_SECONDS).toBeLessThan(EMBED_TOKEN_TTL_SECONDS);
    // And it really does stop verifying that much sooner.
    expect(verifyEmbedToken(edit.token, SECRET, NOW_MS + EMBED_EDIT_TOKEN_TTL_SECONDS * 1000 + 1).error)
      .toBe("expired");
    expect(verifyEmbedToken(view.token, SECRET, NOW_MS + EMBED_EDIT_TOKEN_TTL_SECONDS * 1000 + 1).ok)
      .toBe(true);
  });

  it("denies an edit token to a member who is not a board admin", async () => {
    // Same request as the accepted case above; only `isAdmin` differs. Without
    // this gate a board VIEWER could mint themselves write access.
    await expect(
      handleMintEmbedToken(
        reqOf("u1", { boardId: "b1", scope: "edit", sub: "host:u9", iss: "meet" }),
        deps({ isAdmin: false }),
        NOW_MS
      )
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("rejects an edit request with no subject", async () => {
    await expect(
      handleMintEmbedToken(reqOf("u1", { boardId: "b1", scope: "edit", iss: "meet" }), deps(), NOW_MS)
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects an edit request whose issuer is not allowlisted", async () => {
    await expect(
      handleMintEmbedToken(
        reqOf("u1", { boardId: "b1", scope: "edit", sub: "host:u9", iss: "evil-host" }),
        deps(),
        NOW_MS
      )
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("canonicalises the issuer it mints into the token", async () => {
    const res = await handleMintEmbedToken(
      reqOf("u1", { boardId: "b1", scope: "edit", sub: "host:u9", iss: "MEET" }),
      deps(),
      NOW_MS
    );
    expect(verifyEmbedToken(res.token, SECRET, NOW_MS).payload?.iss).toBe("meet");
  });

  it("rejects a subject on a read-only link (a shared link has no one person)", async () => {
    await expect(
      handleMintEmbedToken(reqOf("u1", { boardId: "b1", sub: "host:u9", iss: "meet" }), deps(), NOW_MS)
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects an oversized subject", async () => {
    await expect(
      handleMintEmbedToken(
        reqOf("u1", {
          boardId: "b1", scope: "edit", sub: "x".repeat(MAX_EMBED_SUBJECT_LENGTH + 1), iss: "meet",
        }),
        deps(),
        NOW_MS
      )
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});
