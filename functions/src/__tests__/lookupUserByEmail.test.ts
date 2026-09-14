import { HttpsError } from "firebase-functions/v2/https";
import {
  handleLookupUserByEmail,
  normalizeLookupEmail,
} from "../callable/lookupUserByEmail";

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

// The directory is modelled as the raw documents Firestore would hand back:
// `Record<string, unknown>` per user, not a tidy typed profile. That is
// deliberate — this collection is written by the CLIENT
// (src/services/authService.ts), so a missing field, a non-string field, or an
// extra field nobody planned for are all real shapes the handler has to
// survive without passing them back out.
const deps = (rows: Record<string, Record<string, unknown>>) => ({
  findByEmail: jest.fn(async (email: string) => {
    for (const [uid, data] of Object.entries(rows)) {
      if (data.email === email) return { uid, data };
    }
    return null;
  }),
});

describe("normalizeLookupEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeLookupEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });

  it("is the single normalization point the three call sites used to disagree on", () => {
    // boardService and workspaceService lowercased + trimmed; friendService did
    // neither, so `Bob@X.Z` resolved to nobody through friend search and to Bob
    // through an invite. Both spellings must now land on the same string.
    expect(normalizeLookupEmail("Bob@X.Z")).toBe(normalizeLookupEmail("bob@x.z"));
  });
});

describe("handleLookupUserByEmail", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(
      handleLookupUserByEmail(reqFor(undefined, { email: "a@x.z" }), deps({}))
    ).rejects.toBeInstanceOf(HttpsError);
  });

  it("rejects an unauthenticated caller with the unauthenticated code, without reading the directory", async () => {
    const d = deps({ u1: { email: "a@x.z" } });
    await expect(
      handleLookupUserByEmail(reqFor(undefined, { email: "a@x.z" }), d)
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(d.findByEmail).not.toHaveBeenCalled();
  });

  it("rejects a missing email with invalid-argument", async () => {
    await expect(
      handleLookupUserByEmail(reqFor("caller", {}), deps({}))
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects a blank/whitespace-only email with invalid-argument", async () => {
    await expect(
      handleLookupUserByEmail(reqFor("caller", { email: "   " }), deps({}))
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects a non-string email with invalid-argument rather than coercing it", async () => {
    await expect(
      handleLookupUserByEmail(reqFor("caller", { email: 42 }), deps({}))
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("returns null for no match rather than throwing", async () => {
    // All three call sites have a `not_found` branch that predates this
    // function; throwing would turn a routine "no such user" into an error
    // banner at every one of them.
    const res = await handleLookupUserByEmail(
      reqFor("caller", { email: "nobody@x.z" }),
      deps({ u1: { email: "a@x.z" } })
    );
    expect(res).toBeNull();
  });

  it("returns exactly uid, displayName and email — and nothing else", async () => {
    // The whole point of the callable. Returning the stored document would
    // rebuild inside the function the disclosure the /users `list` deny closed.
    const res = await handleLookupUserByEmail(
      reqFor("caller", { email: "a@x.z" }),
      deps({
        u1: {
          email: "a@x.z",
          displayName: "Ada",
          photoURL: "https://example.test/a.png",
          pushToken: "expo-push-token",
          plan: "pro",
        },
      })
    );
    expect(res).toEqual({ uid: "u1", displayName: "Ada", email: "a@x.z" });
    expect(Object.keys(res as object).sort()).toEqual(["displayName", "email", "uid"]);
  });

  it("matches a mixed-case, whitespace-padded email against a lowercase stored record", async () => {
    const d = deps({ u2: { email: "bob@x.z", displayName: "Bob" } });
    const res = await handleLookupUserByEmail(reqFor("caller", { email: "  BoB@X.Z " }), d);
    expect(res).toEqual({ uid: "u2", displayName: "Bob", email: "bob@x.z" });
    expect(d.findByEmail).toHaveBeenCalledWith("bob@x.z");
  });

  it("substitutes an empty displayName for a missing or non-string one", async () => {
    // A user document with no `displayName` is ordinary (social sign-in before
    // the profile step). Returning `undefined` would make that absence the
    // client's problem at three separate call sites — and `undefined` is not
    // even representable in a callable's JSON response.
    const res = await handleLookupUserByEmail(
      reqFor("caller", { email: "c@x.z" }),
      deps({ u3: { email: "c@x.z", displayName: { first: "C" } } })
    );
    expect(res).toEqual({ uid: "u3", displayName: "", email: "c@x.z" });
  });

  it("falls back to the normalized query email when the stored value is not a string", async () => {
    const res = await handleLookupUserByEmail(reqFor("caller", { email: " D@X.Z " }), {
      findByEmail: jest.fn(async () => ({ uid: "u4", data: { email: 7, displayName: "D" } })),
    });
    expect(res).toEqual({ uid: "u4", displayName: "D", email: "d@x.z" });
  });
});
