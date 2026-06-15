import { createHmac, timingSafeEqual } from "crypto";

// Minimal HS256 JWT sign/verify built on node:crypto (Month 4, Phase 8). Hand-
// rolled instead of pulling in `jsonwebtoken` so the embed token path adds no new
// dependency. Scope is intentionally tiny: HS256 only, the few claims the embed
// flow needs. The signing secret never leaves the function runtime (a Functions
// secret, like OPENAI_API_KEY) so a forged token can't be produced client-side.

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sign(signingInput: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(signingInput).digest());
}

/** Signs a payload as an HS256 JWT. Caller sets `exp` (seconds since epoch) on the
 *  payload — this util doesn't impose an expiry policy, it only signs. */
export function signJwt(payload: object, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

export type JwtVerifyError = "malformed" | "bad-signature" | "expired";

export interface JwtVerifyResult<T> {
  ok: boolean;
  payload?: T;
  error?: JwtVerifyError;
}

/** Verifies signature (timing-safe) and `exp` against `now` (seconds since epoch).
 *  Returns a discriminated result rather than throwing so the caller maps each
 *  failure to the right HttpsError code. */
export function verifyJwt<T extends { exp?: number }>(
  token: string,
  secret: string,
  now: number
): JwtVerifyResult<T> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed" };
  const [header, body, signature] = parts;

  const expected = sign(`${header}.${body}`, secret);
  // timingSafeEqual throws on length mismatch, so guard on length first.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "bad-signature" };
  }

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64").toString("utf8")) as T;
  } catch {
    return { ok: false, error: "malformed" };
  }

  if (typeof payload.exp === "number" && now >= payload.exp) {
    return { ok: false, error: "expired" };
  }
  return { ok: true, payload };
}
