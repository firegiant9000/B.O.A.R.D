import { looksLikeEditScopeToken } from "../tokenScopeGuard";

/** Builds an unsigned base64url JWT-shaped string carrying the given payload —
 *  good enough here since this module never checks the signature, only reads
 *  the payload's `scope` claim (see its own doc comment for why that's safe). */
function fakeToken(payload: unknown): string {
  const b64url = (s: string) =>
    Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

describe("looksLikeEditScopeToken", () => {
  it("returns false for a token whose payload carries scope 'view'", () => {
    expect(looksLikeEditScopeToken(fakeToken({ v: 2, boardId: "b1", scope: "view" }))).toBe(
      false
    );
  });

  it("returns true for a token whose payload carries scope 'edit'", () => {
    expect(
      looksLikeEditScopeToken(fakeToken({ v: 2, boardId: "b1", scope: "edit", sub: "u1", iss: "meet" }))
    ).toBe(true);
  });

  it("refuses (returns true) a malformed token — not exactly three segments", () => {
    expect(looksLikeEditScopeToken("not.a.jwt.at.all")).toBe(true);
    expect(looksLikeEditScopeToken("onlyonepart")).toBe(true);
    expect(looksLikeEditScopeToken("two.parts")).toBe(true);
  });

  it("refuses (returns true) a token whose middle segment isn't valid JSON", () => {
    expect(looksLikeEditScopeToken("aGVhZGVy.bm90LWpzb24.sig")).toBe(true);
  });

  it("treats a decodable payload with no scope claim as not-edit, same as any other non-'edit' value", () => {
    expect(looksLikeEditScopeToken(fakeToken({ v: 2, boardId: "b1" }))).toBe(false);
  });

  it("is exact-match on the literal 'edit' — mirrors parseEmbedScope's own exact-match contract", () => {
    // Same discipline as src/lib/embedScope.ts: only the exact literal "edit"
    // ever means edit. A decodable-but-unrecognized scope value is treated the
    // same as "view" (safe to load) here, not as "unsafe" — guards a future
    // `!== "view"`-style rewrite from over-refusing, and a future
    // `.includes("edit")`-style rewrite from under-refusing.
    expect(looksLikeEditScopeToken(fakeToken({ scope: "viewer" }))).toBe(false);
    expect(looksLikeEditScopeToken(fakeToken({ scope: "pre-edit" }))).toBe(false);
    expect(looksLikeEditScopeToken(fakeToken({ scope: "view" }))).toBe(false);
    expect(looksLikeEditScopeToken(fakeToken({ scope: "edit" }))).toBe(true);
  });
});
