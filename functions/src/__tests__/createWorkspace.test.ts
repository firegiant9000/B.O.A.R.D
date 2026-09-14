import { HttpsError } from "firebase-functions/v2/https";
import { handleCreateWorkspace, resolveOwnerPlan } from "../callable/createWorkspace";

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

// `owned` is the list of workspaces the caller already OWNS, described by the
// only field the gate reads off them — `plan`. `undefined` stands for a
// workspace whose `plan` field is missing or non-string, which
// `countOwnedWorkspaces` drops from `plans` while still counting the document:
// the fixture models that split deliberately, because "counts toward the cap
// but grants no entitlement" is the fail-closed behaviour under test.
const deps = (opts: { owned?: (string | undefined)[] }) => {
  const owned = opts.owned ?? [];
  return {
    countOwnedWorkspaces: jest.fn(async () => ({
      count: owned.length,
      plans: owned.filter((p): p is string => typeof p === "string"),
    })),
    writeWorkspace: jest.fn(async (_doc: Record<string, unknown>) => "ws123"),
  };
};

describe("resolveOwnerPlan", () => {
  it("resolves an owner of nothing to free", () => {
    expect(resolveOwnerPlan([])).toBe("free");
  });

  it("resolves an owner of only free workspaces to free", () => {
    expect(resolveOwnerPlan(["free", "free"])).toBe("free");
  });

  it("resolves to pro when any owned workspace is pro", () => {
    expect(resolveOwnerPlan(["free", "pro", "free"])).toBe("pro");
  });

  it("resolves to edu when an owned workspace is edu and none is pro", () => {
    expect(resolveOwnerPlan(["free", "edu"])).toBe("edu");
  });

  it("prefers pro over edu when the owner has both", () => {
    // Decides nothing for the workspace cap today (both are UNLIMITED there),
    // but pins the ordering so it can't become document-order-dependent if a
    // future plan row gives one of them a finite `workspaces` number.
    expect(resolveOwnerPlan(["edu", "pro"])).toBe("pro");
  });

  it("resolves an unrecognized plan string to free rather than trusting it", () => {
    expect(resolveOwnerPlan(["team-tier-that-does-not-exist"])).toBe("free");
  });
});

describe("handleCreateWorkspace", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(handleCreateWorkspace(reqFor(undefined, { name: "W" }), deps({})))
      .rejects.toBeInstanceOf(HttpsError);
  });

  it("rejects an unauthenticated caller with the unauthenticated code", async () => {
    const d = deps({});
    await expect(handleCreateWorkspace(reqFor(undefined, { name: "W" }), d))
      .rejects.toMatchObject({ code: "unauthenticated" });
    expect(d.writeWorkspace).not.toHaveBeenCalled();
  });

  it("rejects a missing name", async () => {
    const d = deps({});
    await expect(handleCreateWorkspace(reqFor("u1", {}), d))
      .rejects.toMatchObject({ code: "invalid-argument" });
    expect(d.writeWorkspace).not.toHaveBeenCalled();
  });

  it("rejects a blank name", async () => {
    const d = deps({});
    await expect(handleCreateWorkspace(reqFor("u1", { name: "   " }), d))
      .rejects.toMatchObject({ code: "invalid-argument" });
    expect(d.writeWorkspace).not.toHaveBeenCalled();
  });

  it("creates the FIRST workspace for a user who owns none — the signup path", async () => {
    // Load-bearing: src/services/authService.ts provisions a personal workspace
    // through this callable on account creation, so a regression here breaks
    // signup, not just the workspace switcher. Nothing special-cases the first
    // workspace — 0 < 1 is simply under the free cap.
    const d = deps({ owned: [] });
    const res = await handleCreateWorkspace(reqFor("u1", { name: "Personal" }), d);
    expect(res.workspaceId).toBe("ws123");
    expect(d.writeWorkspace).toHaveBeenCalledTimes(1);
  });

  it("blocks a SECOND workspace on the free plan", async () => {
    const d = deps({ owned: ["free"] });
    await expect(handleCreateWorkspace(reqFor("u1", { name: "Second" }), d))
      .rejects.toThrow(/limit/i);
    expect(d.writeWorkspace).not.toHaveBeenCalled();
  });

  it("blocking the second workspace throws resource-exhausted so the upsell can catch it", async () => {
    const d = deps({ owned: ["free"] });
    await expect(handleCreateWorkspace(reqFor("u1", { name: "Second" }), d))
      .rejects.toMatchObject({ code: "resource-exhausted" });
  });

  it("does NOT block an owner of a pro workspace", async () => {
    // The entitlement for this one resource comes from the workspaces the
    // caller already owns, since a workspace has no container to read a plan
    // off — this is the test that pins that resolution.
    const d = deps({ owned: ["pro"] });
    await expect(handleCreateWorkspace(reqFor("u1", { name: "Second" }), d))
      .resolves.toMatchObject({ workspaceId: "ws123" });
  });

  it("does NOT block an owner of an edu workspace", async () => {
    const d = deps({ owned: ["edu"] });
    await expect(handleCreateWorkspace(reqFor("u1", { name: "Second" }), d))
      .resolves.toMatchObject({ workspaceId: "ws123" });
  });

  it("lets a pro owner past the free cap even with many free workspaces alongside", async () => {
    const d = deps({ owned: ["free", "free", "pro", "free"] });
    await expect(handleCreateWorkspace(reqFor("u1", { name: "Fifth" }), d))
      .resolves.toMatchObject({ workspaceId: "ws123" });
  });

  it("fails closed on an owned workspace with a garbage plan value", async () => {
    // A corrupt/unknown `plan` string must not read as an upgrade: it counts
    // toward the cap and grants nothing, so this owner of one is denied.
    const d = deps({ owned: ["team-tier-that-does-not-exist"] });
    await expect(handleCreateWorkspace(reqFor("u1", { name: "Second" }), d))
      .rejects.toMatchObject({ code: "resource-exhausted" });
    expect(d.writeWorkspace).not.toHaveBeenCalled();
  });

  it("fails closed on an owned workspace whose plan field is absent entirely", async () => {
    // `countOwnedWorkspaces` drops a missing `plan` from `plans` but still
    // counts the document, so this is an owner of one on the free cap.
    const d = deps({ owned: [undefined] });
    await expect(handleCreateWorkspace(reqFor("u1", { name: "Second" }), d))
      .rejects.toMatchObject({ code: "resource-exhausted" });
  });

  it("counts against the caller's own uid, not anything in req.data", async () => {
    const d = deps({ owned: [] });
    await handleCreateWorkspace(reqFor("u1", { name: "W", ownerId: "victim" }), d);
    expect(d.countOwnedWorkspaces).toHaveBeenCalledWith("u1");
  });

  it("derives ownerId/members/memberIds from the auth token, ignoring client-supplied values", async () => {
    const d = deps({ owned: [] });
    await handleCreateWorkspace(
      reqFor("u1", { name: "W", ownerId: "victim", members: { victim: "owner" }, memberIds: ["victim"] }),
      d
    );
    // Assert on what was actually written — that is what makes this a real
    // spoofing test rather than a test of the response shape.
    const written = d.writeWorkspace.mock.calls[0][0];
    expect(written.ownerId).toBe("u1");
    expect(written.members).toEqual({ u1: "owner" });
    expect(written.memberIds).toEqual(["u1"]);
    expect(written.ownerId).not.toBe("victim");
  });

  it("forces plan to \"free\" even when the client asks for pro", async () => {
    // A client that could mint a pro workspace would hand itself every gate at
    // once: every other quota reads `plan` off the containing workspace.
    const d = deps({ owned: [] });
    await handleCreateWorkspace(reqFor("u1", { name: "W", plan: "pro" }), d);
    expect(d.writeWorkspace.mock.calls[0][0].plan).toBe("free");
  });

  it("forces plan to \"free\" even when the client asks for edu", async () => {
    const d = deps({ owned: [] });
    await handleCreateWorkspace(reqFor("u1", { name: "W", plan: "edu" }), d);
    expect(d.writeWorkspace.mock.calls[0][0].plan).toBe("free");
  });

  it("writes the same field set the client used to write directly", async () => {
    // Pins the document shape against src/services/workspaceService.ts's prior
    // `addDoc` payload — a field dropped here would silently break readers
    // (`mapWorkspace`, `getUserWorkspaces`'s `memberIds` query) rather than
    // failing any type check.
    const d = deps({ owned: [] });
    await handleCreateWorkspace(reqFor("u1", { name: "  Personal  " }), d);
    const written = d.writeWorkspace.mock.calls[0][0];
    expect(Object.keys(written).sort()).toEqual(
      ["createdAt", "members", "memberIds", "name", "ownerId", "plan"].sort()
    );
    expect(written.name).toBe("Personal");
    expect(written.createdAt).toBeDefined();
  });
});
