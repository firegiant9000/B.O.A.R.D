jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
const mockCallable = jest.fn();
const mockHttpsCallable = jest.fn((..._args: unknown[]) => mockCallable);
jest.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => mockHttpsCallable(...args),
}));
// The email lookup behind `addMemberByEmail` is a Cloud Function call now, not
// a `users` query — firestore.rules denies `list` on that collection. Mocked at
// the service seam so these tests stay about membership branching; the callable
// binding itself is pinned in userService.test.ts.
jest.mock("../userService", () => ({ lookupUserByEmail: jest.fn() }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, makeDocSnap, ts } from "../../test-utils/firestoreMock";
import { lookupUserByEmail } from "../userService";
import * as workspaceService from "../workspaceService";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;
const lookup = lookupUserByEmail as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("role helpers", () => {
  const ws = { members: { o: "owner", a: "admin", m: "member", v: "viewer" } as const };

  it("getWorkspaceRole returns the role or undefined", () => {
    expect(workspaceService.getWorkspaceRole(ws, "a")).toBe("admin");
    expect(workspaceService.getWorkspaceRole(ws, "nobody")).toBeUndefined();
  });

  it("isWorkspaceMember reflects map membership", () => {
    expect(workspaceService.isWorkspaceMember(ws, "v")).toBe(true);
    expect(workspaceService.isWorkspaceMember(ws, "nobody")).toBe(false);
  });

  it("canManageMembers is true only for owner/admin", () => {
    expect(workspaceService.canManageMembers("owner")).toBe(true);
    expect(workspaceService.canManageMembers("admin")).toBe(true);
    expect(workspaceService.canManageMembers("member")).toBe(false);
    expect(workspaceService.canManageMembers("viewer")).toBe(false);
    expect(workspaceService.canManageMembers(undefined)).toBe(false);
  });
});

describe("createWorkspace", () => {
  it("returns the id the callable minted and writes nothing directly", async () => {
    mockCallable.mockResolvedValueOnce({ data: { workspaceId: "ws-1" } });

    const id = await workspaceService.createWorkspace("Personal", "owner-1");

    expect(id).toBe("ws-1");
    // The client no longer writes the workspace doc: firestore.rules denies a
    // client create outright, so an `addDoc` here would simply be rejected.
    expect(addDoc).not.toHaveBeenCalled();
  });

  it("binds httpsCallable to the \"createWorkspace\" function name", async () => {
    // Pins the callable's name against the mock factory's own second argument,
    // not just the mock's configured return value — a typo here (e.g.
    // "createworkspace") would satisfy every other assertion in this block
    // while breaking signup for every new account.
    mockCallable.mockResolvedValueOnce({ data: { workspaceId: "ws-1" } });

    await workspaceService.createWorkspace("Personal", "owner-1");

    expect(mockHttpsCallable).toHaveBeenCalled();
    expect(mockHttpsCallable.mock.calls[0][1]).toBe("createWorkspace");
  });

  it("sends only the name — ownerId comes from the auth token server-side", async () => {
    mockCallable.mockResolvedValueOnce({ data: { workspaceId: "ws-1" } });

    await workspaceService.createWorkspace("Personal", "owner-1");

    expect(mockCallable).toHaveBeenCalledWith({ name: "Personal" });
  });

  it("does NOT forward an explicit plan — the function forces \"free\" regardless", async () => {
    // The parameter survives for call-site compatibility only. Sending it would
    // advertise a choice the server does not honour; a paid or edu workspace is
    // provisioned out of band (the Stripe webhook, or an operator).
    mockCallable.mockResolvedValueOnce({ data: { workspaceId: "ws-2" } });

    await workspaceService.createWorkspace("Class", "o", "edu");

    expect(mockCallable).toHaveBeenCalledWith({ name: "Class" });
  });
});

describe("getWorkspace", () => {
  it("returns null when the workspace does not exist", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", null));
    expect(await workspaceService.getWorkspace("ws-1")).toBeNull();
  });

  it("maps a doc with sensible defaults", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", { ownerId: "o1" }));
    const ws = await workspaceService.getWorkspace("ws-1");
    expect(ws).toMatchObject({ id: "ws-1", name: "Untitled", members: {}, plan: "free" });
  });
});

describe("getUserWorkspaces", () => {
  it("queries the parallel memberIds array and returns oldest-first", async () => {
    const older = new Date("2026-01-01");
    const newer = new Date("2026-02-01");
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["b", { name: "B", createdAt: ts(newer) }],
        ["a", { name: "A", createdAt: ts(older) }],
      ])
    );

    const result = await workspaceService.getUserWorkspaces("u1");

    expect(result.map((w) => w.id)).toEqual(["a", "b"]);
    expect((fs.where as jest.Mock).mock.calls.at(-1)).toEqual([
      "memberIds",
      "array-contains",
      "u1",
    ]);
  });
});

describe("ensurePersonalWorkspace", () => {
  it("returns the oldest existing workspace without creating one", async () => {
    const older = new Date("2026-01-01");
    const newer = new Date("2026-02-01");
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["new", { name: "Class", createdAt: ts(newer) }],
        ["personal", { name: "Personal", createdAt: ts(older) }],
      ])
    );

    const id = await workspaceService.ensurePersonalWorkspace("u1");

    expect(id).toBe("personal");
    expect(mockCallable).not.toHaveBeenCalled();
  });

  it("creates a personal workspace through the callable when the user has none", async () => {
    // This is the signup path (src/services/authService.ts), and it is the one
    // create the server-side cap must always permit: a brand-new user owns zero
    // workspaces, so the free limit of 1 grants it without any special case.
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    mockCallable.mockResolvedValueOnce({ data: { workspaceId: "ws-new" } });

    const id = await workspaceService.ensurePersonalWorkspace("u1");

    expect(id).toBe("ws-new");
    expect(mockCallable).toHaveBeenCalledWith({ name: "Personal" });
    expect(addDoc).not.toHaveBeenCalled();
  });
});

describe("addMember", () => {
  it("sets the role map key and unions the parallel array", async () => {
    await workspaceService.addMember("ws-1", "u2", "viewer");
    const update = updateDoc.mock.calls[0][1];
    expect(update["members.u2"]).toBe("viewer");
    expect(update.memberIds).toEqual({ __type: "arrayUnion", values: ["u2"] });
  });

  it("defaults the role to member", async () => {
    await workspaceService.addMember("ws-1", "u3");
    expect(updateDoc.mock.calls[0][1]["members.u3"]).toBe("member");
  });
});

describe("updateMemberRole", () => {
  it("updates only the role map key", async () => {
    await workspaceService.updateMemberRole("ws-1", "u2", "admin");
    expect(updateDoc.mock.calls[0][1]).toEqual({ "members.u2": "admin" });
  });
});

describe("removeMember", () => {
  it("deletes the role map key and removes from the parallel array", async () => {
    await workspaceService.removeMember("ws-1", "u2");
    const update = updateDoc.mock.calls[0][1];
    expect(update["members.u2"]).toBe("__deleteField__");
    expect(update.memberIds).toEqual({ __type: "arrayRemove", values: ["u2"] });
  });
});

describe("addMemberByEmail", () => {
  it("returns not_found when no user matches the email (no write)", async () => {
    lookup.mockResolvedValueOnce(null);

    const res = await workspaceService.addMemberByEmail("ws-1", "nobody@x.com");

    expect(res).toEqual({ result: "not_found" });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("resolves the email through the callable, never through a users query", async () => {
    // This used to be `getDocs(query(collection(db,"users"), where("email",…)))`.
    // firestore.rules now denies `list` on /users — the collection carries
    // email addresses, and `allow read` covered `list`, so one unfiltered
    // query dumped the whole directory. No rule could have admitted the
    // filtered shape alone: rules never see a query's `where` clauses.
    lookup.mockResolvedValueOnce(null);

    await workspaceService.addMemberByEmail("ws-1", "nobody@x.com");

    expect(lookup).toHaveBeenCalledWith("nobody@x.com");
    expect(getDocs).not.toHaveBeenCalled();
  });

  it("sends the address unnormalized — the callable owns the lowercase/trim now", async () => {
    // The lowercase/trim moved server-side so that all three email lookups
    // share it; friendService never applied it, which made the same address
    // resolve differently depending on which feature asked.
    lookup.mockResolvedValueOnce(null);
    await workspaceService.addMemberByEmail("ws-1", "  Foo@Bar.COM ");
    expect(lookup).toHaveBeenCalledWith("  Foo@Bar.COM ");
  });

  it("returns already_member without writing when the uid is in the role map", async () => {
    lookup.mockResolvedValueOnce({ uid: "u2", displayName: "U2", email: "u2@x.com" });
    getDoc.mockResolvedValueOnce(
      makeDocSnap("ws-1", { members: { owner: "owner", u2: "member" } })
    );

    const res = await workspaceService.addMemberByEmail("ws-1", "u2@x.com");

    expect(res).toEqual({ result: "already_member", uid: "u2" });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("adds the user with the given role and unions the parallel array", async () => {
    lookup.mockResolvedValueOnce({ uid: "u3", displayName: "U3", email: "u3@x.com" });
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", { members: { owner: "owner" } }));

    const res = await workspaceService.addMemberByEmail("ws-1", "u3@x.com", "admin");

    expect(res).toEqual({ result: "added", uid: "u3" });
    const update = updateDoc.mock.calls[0][1];
    expect(update["members.u3"]).toBe("admin");
    expect(update.memberIds).toEqual({ __type: "arrayUnion", values: ["u3"] });
  });

  it("never touches ownerId when adding a member — the rules pin would deny the write", async () => {
    // firestore.rules refuses any workspace update whose affected keys include
    // `ownerId` (the pin the per-owner workspace cap depends on). This is the
    // positive control on the client side: the invite path's write is
    // `members`/`memberIds` only, so the pin costs it nothing.
    lookup.mockResolvedValueOnce({ uid: "u3", displayName: "U3", email: "u3@x.com" });
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", { members: { owner: "owner" } }));

    await workspaceService.addMemberByEmail("ws-1", "u3@x.com");

    expect(Object.keys(updateDoc.mock.calls[0][1])).not.toContain("ownerId");
  });

  it("defaults the role to member", async () => {
    lookup.mockResolvedValueOnce({ uid: "u4", displayName: "U4", email: "u4@x.com" });
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", { members: {} }));

    await workspaceService.addMemberByEmail("ws-1", "u4@x.com");

    expect(updateDoc.mock.calls[0][1]["members.u4"]).toBe("member");
  });

  it("throws when the workspace does not exist", async () => {
    lookup.mockResolvedValueOnce({ uid: "u5", displayName: "U5", email: "u5@x.com" });
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", null));

    await expect(
      workspaceService.addMemberByEmail("ws-1", "u5@x.com")
    ).rejects.toThrow("Workspace not found");
  });
});

describe("getWorkspace — swatches default", () => {
  it("maps a missing swatches field to an empty array (migration-tolerant)", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", { ownerId: "o1" }));
    const ws = await workspaceService.getWorkspace("ws-1");
    expect(ws?.swatches).toEqual([]);
  });

  it("passes an existing swatches array through", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", { ownerId: "o1", swatches: ["#3366ff"] }));
    const ws = await workspaceService.getWorkspace("ws-1");
    expect(ws?.swatches).toEqual(["#3366ff"]);
  });
});

describe("addWorkspaceSwatch / removeWorkspaceSwatch", () => {
  it("unions the hex into the swatches array", async () => {
    await workspaceService.addWorkspaceSwatch("ws-1", "#3366ff");
    const update = updateDoc.mock.calls[0][1];
    expect(update.swatches).toEqual({ __type: "arrayUnion", values: ["#3366ff"] });
  });

  it("removes the hex from the swatches array", async () => {
    await workspaceService.removeWorkspaceSwatch("ws-1", "#3366ff");
    const update = updateDoc.mock.calls[0][1];
    expect(update.swatches).toEqual({ __type: "arrayRemove", values: ["#3366ff"] });
  });
});

describe("canUseCustomPalette — advisory Pro gate (mirrors canRecordVoiceNotes)", () => {
  it("is false for the free plan", () => {
    expect(workspaceService.canUseCustomPalette("free")).toBe(false);
  });

  it("is true for pro and edu", () => {
    expect(workspaceService.canUseCustomPalette("pro")).toBe(true);
    expect(workspaceService.canUseCustomPalette("edu")).toBe(true);
  });
});

// Fix Wave F2 — mirrors the sibling test above exactly (same shape as
// canRecordVoiceNotes/canUseCustomPalette): ROADMAP.md:615's third Pro
// affordance had no predicate at all before this.
describe("canUsePresenter — advisory Pro gate (mirrors canUseCustomPalette / canRecordVoiceNotes)", () => {
  it("is false for the free plan", () => {
    expect(workspaceService.canUsePresenter("free")).toBe(false);
  });

  it("is true for pro and edu", () => {
    expect(workspaceService.canUsePresenter("pro")).toBe(true);
    expect(workspaceService.canUsePresenter("edu")).toBe(true);
  });

  // Final correction (C1) — undefined means "not known yet" (workspace
  // unresolved, legacy/workspace-less board, or a failed fetch), which is a
  // different fact from "known to be on the free plan," and must fail OPEN.
  it("is true for an unknown plan (undefined) — fails open, unlike the free plan", () => {
    expect(workspaceService.canUsePresenter(undefined)).toBe(true);
  });
});
