import { signJwt, verifyJwt } from "../embed/jwt";
import {
  mintEmbedToken,
  verifyEmbedToken,
  EMBED_TOKEN_VERSION,
  EMBED_TOKEN_TTL_SECONDS,
} from "../embed/token";
import { handleExchangeEmbedToken, embedUid } from "../callable/exchangeEmbedToken";
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
    const { token } = mintEmbedToken({ boardId: "b1", scope: "edit", secret: SECRET, nowMs: NOW_MS });
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

describe("handleExchangeEmbedToken", () => {
  const mint = jest.fn(async (uid: string, claims: object) => `custom(${uid},${JSON.stringify(claims)})`);
  const reqOf = (token?: string) =>
    ({ data: token === undefined ? {} : { token } } as CallableRequest<{ token: string }>);

  beforeEach(() => mint.mockClear());

  it("mints a custom token with embed claims for a valid token", async () => {
    const { token } = mintEmbedToken({ boardId: "b9", scope: "view", secret: SECRET, nowMs: NOW_MS });
    const res = await handleExchangeEmbedToken(reqOf(token), SECRET, NOW_MS, mint);
    expect(res).toMatchObject({ boardId: "b9", scope: "view" });
    expect(mint).toHaveBeenCalledWith(embedUid("b9"), {
      embed: true,
      embedBoardId: "b9",
      embedScope: "view",
    });
  });

  it("rejects a missing token", async () => {
    await expect(handleExchangeEmbedToken(reqOf(undefined), SECRET, NOW_MS, mint)).rejects.toThrow();
    expect(mint).not.toHaveBeenCalled();
  });

  it("maps expiry to a distinct error and never mints", async () => {
    const { token } = mintEmbedToken({ boardId: "b1", scope: "view", secret: SECRET, nowMs: NOW_MS, ttlSeconds: 1 });
    await expect(
      handleExchangeEmbedToken(reqOf(token), SECRET, NOW_MS + 5_000, mint)
    ).rejects.toThrow(/expired/i);
    expect(mint).not.toHaveBeenCalled();
  });

  it("rejects a forged token without minting", async () => {
    const { token } = mintEmbedToken({ boardId: "b1", scope: "view", secret: "wrong", nowMs: NOW_MS });
    await expect(handleExchangeEmbedToken(reqOf(token), SECRET, NOW_MS, mint)).rejects.toThrow(/invalid/i);
    expect(mint).not.toHaveBeenCalled();
  });
});
