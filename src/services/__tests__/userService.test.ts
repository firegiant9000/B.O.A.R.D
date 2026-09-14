jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));

// `mockHttpsCallable` wraps `httpsCallable` itself rather than only its return
// value, so the FUNCTION NAME can be asserted. That matters more here than in
// most services: a typo in the name fails at runtime as a generic callable
// error, and the fallback it would break (a client-side `users` query) no
// longer exists — firestore.rules denies `list` on that collection.
const mockCallable = jest.fn();
const mockHttpsCallable = jest.fn((..._args: unknown[]) => mockCallable);
jest.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => mockHttpsCallable(...args),
}));

import { lookupUserByEmail } from "../userService";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("lookupUserByEmail", () => {
  it("binds httpsCallable to the \"lookupUserByEmail\" function name", async () => {
    mockCallable.mockResolvedValueOnce({ data: null });

    await lookupUserByEmail("a@x.z");

    expect(mockHttpsCallable.mock.calls[0][1]).toBe("lookupUserByEmail");
  });

  it("returns the directory entry the callable produced", async () => {
    mockCallable.mockResolvedValueOnce({
      data: { uid: "u2", displayName: "Bob", email: "bob@x.z" },
    });

    expect(await lookupUserByEmail("bob@x.z")).toEqual({
      uid: "u2",
      displayName: "Bob",
      email: "bob@x.z",
    });
  });

  it("returns null when no user matches, rather than throwing", async () => {
    mockCallable.mockResolvedValueOnce({ data: null });
    expect(await lookupUserByEmail("nobody@x.z")).toBeNull();
  });

  it("normalizes an absent payload to null", async () => {
    // A callable that answered with no body at all (an older deployment, a
    // transport quirk) must read as "no such user", never as a truthy object
    // whose `uid` is undefined — that would add a member with an undefined id.
    mockCallable.mockResolvedValueOnce({ data: undefined });
    expect(await lookupUserByEmail("nobody@x.z")).toBeNull();
  });

  it("sends the raw address — normalization is the server's job, not three clients'", async () => {
    // The regression this replaced: boardService and workspaceService
    // lowercased+trimmed before querying and friendService did not, so the same
    // address resolved differently depending on which feature asked. Doing it
    // here as well would re-create a second place for that to drift.
    mockCallable.mockResolvedValueOnce({ data: null });

    await lookupUserByEmail("  BoB@X.Z ");

    expect(mockCallable).toHaveBeenCalledWith({ email: "  BoB@X.Z " });
  });

  it("propagates a callable rejection instead of swallowing it into null", async () => {
    // "Not signed in" / "blank address" / offline are failures, and a caller
    // that showed "no such user" for them would be lying about the directory.
    mockCallable.mockRejectedValueOnce(new Error("unauthenticated"));
    await expect(lookupUserByEmail("a@x.z")).rejects.toThrow("unauthenticated");
  });
});
