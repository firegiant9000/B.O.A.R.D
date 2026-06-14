jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, makeDocSnap, ts } from "../../test-utils/firestoreMock";
import * as workspaceService from "../workspaceService";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;

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
  it("creates the workspace with the owner as sole 'owner' member and free plan", async () => {
    addDoc.mockResolvedValueOnce({ id: "ws-1" });

    const id = await workspaceService.createWorkspace("Personal", "owner-1");

    expect(id).toBe("ws-1");
    const payload = addDoc.mock.calls[0][1];
    expect(payload).toMatchObject({
      name: "Personal",
      ownerId: "owner-1",
      members: { "owner-1": "owner" },
      memberIds: ["owner-1"],
      plan: "free",
    });
    expect(payload.createdAt).toBe("__serverTimestamp__");
  });

  it("honors an explicit plan", async () => {
    addDoc.mockResolvedValueOnce({ id: "ws-2" });
    await workspaceService.createWorkspace("Class", "o", "edu");
    expect(addDoc.mock.calls[0][1].plan).toBe("edu");
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
    expect(addDoc).not.toHaveBeenCalled();
  });

  it("creates a personal workspace when the user has none (signup auto-create lagged)", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    addDoc.mockResolvedValueOnce({ id: "ws-new" });

    const id = await workspaceService.ensurePersonalWorkspace("u1");

    expect(id).toBe("ws-new");
    expect(addDoc.mock.calls[0][1]).toMatchObject({
      name: "Personal",
      ownerId: "u1",
      members: { u1: "owner" },
    });
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
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));

    const res = await workspaceService.addMemberByEmail("ws-1", "nobody@x.com");

    expect(res).toEqual({ result: "not_found" });
    expect(updateDoc).not.toHaveBeenCalled();
    // email is normalized (lowercased + trimmed) before lookup
    expect((fs.where as jest.Mock).mock.calls.at(-1)).toEqual([
      "email",
      "==",
      "nobody@x.com",
    ]);
  });

  it("normalizes the email before lookup", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    await workspaceService.addMemberByEmail("ws-1", "  Foo@Bar.COM ");
    expect((fs.where as jest.Mock).mock.calls.at(-1)).toEqual([
      "email",
      "==",
      "foo@bar.com",
    ]);
  });

  it("returns already_member without writing when the uid is in the role map", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["u2", { email: "u2@x.com" }]]));
    getDoc.mockResolvedValueOnce(
      makeDocSnap("ws-1", { members: { owner: "owner", u2: "member" } })
    );

    const res = await workspaceService.addMemberByEmail("ws-1", "u2@x.com");

    expect(res).toEqual({ result: "already_member", uid: "u2" });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("adds the user with the given role and unions the parallel array", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["u3", { email: "u3@x.com" }]]));
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", { members: { owner: "owner" } }));

    const res = await workspaceService.addMemberByEmail("ws-1", "u3@x.com", "admin");

    expect(res).toEqual({ result: "added", uid: "u3" });
    const update = updateDoc.mock.calls[0][1];
    expect(update["members.u3"]).toBe("admin");
    expect(update.memberIds).toEqual({ __type: "arrayUnion", values: ["u3"] });
  });

  it("defaults the role to member", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["u4", { email: "u4@x.com" }]]));
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", { members: {} }));

    await workspaceService.addMemberByEmail("ws-1", "u4@x.com");

    expect(updateDoc.mock.calls[0][1]["members.u4"]).toBe("member");
  });

  it("throws when the workspace does not exist", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["u5", { email: "u5@x.com" }]]));
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", null));

    await expect(
      workspaceService.addMemberByEmail("ws-1", "u5@x.com")
    ).rejects.toThrow("Workspace not found");
  });
});
