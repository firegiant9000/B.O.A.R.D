import { HttpsError } from "firebase-functions/v2/https";
import { handleCreateBoard, generateInviteCode } from "../callable/createBoard";

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

const deps = (opts: { plan?: unknown; boardCount?: number; isMember?: boolean }) => {
  // `plan` is deliberately `unknown` so a test can hand in a garbage runtime
  // value (e.g. a number) to exercise limitFor()'s fail-closed fallback; cast
  // at the boundary so the mock still satisfies CreateBoardDeps's shape.
  const plan = (opts.plan ?? "free") as string;
  const members: Record<string, string> = opts.isMember === false ? {} : { u1: "member" };
  return {
    getWorkspace: jest.fn(async () => ({ plan, members })),
    countBoards: jest.fn(async () => opts.boardCount ?? 0),
    writeBoard: jest.fn(async (_doc: Record<string, unknown>) => "board123"),
  };
};

describe("handleCreateBoard", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(handleCreateBoard(reqFor(undefined, { workspaceId: "ws1", title: "T" }), deps({}), 0))
      .rejects.toBeInstanceOf(HttpsError);
  });

  it("rejects a non-member of the workspace", async () => {
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), deps({ isMember: false }), 0))
      .rejects.toThrow(/not a member/i);
  });

  it("rejects when the workspace does not exist", async () => {
    const d = deps({});
    d.getWorkspace.mockResolvedValueOnce(null as never);
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), d, 0))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("creates a board when under the free limit", async () => {
    const d = deps({ boardCount: 4 });
    const res = await handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), d, 0);
    expect(res.boardId).toBe("board123");
    expect(res.inviteCode).toHaveLength(6);
    expect(d.writeBoard).toHaveBeenCalled();
  });

  it("blocks the 6th board on the free plan", async () => {
    const d = deps({ boardCount: 5 });
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), d, 0))
      .rejects.toThrow(/limit/i);
    expect(d.writeBoard).not.toHaveBeenCalled();
  });

  it("blocking the 6th board throws resource-exhausted so a later upsell can catch it", async () => {
    const d = deps({ boardCount: 5 });
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), d, 0))
      .rejects.toMatchObject({ code: "resource-exhausted" });
  });

  it("allows the 6th board on pro", async () => {
    const d = deps({ plan: "pro", boardCount: 5 });
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), d, 0))
      .resolves.toMatchObject({ boardId: "board123" });
  });

  it("fails closed on a garbage plan value: still denies at the free cap", async () => {
    // A corrupt/unexpected `plan` (not a recognized string) must not fall through
    // to "unlimited" — limitFor()'s own free-fallback must still bite here.
    const d = deps({ plan: 12345, boardCount: 5 });
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), d, 0))
      .rejects.toThrow(/limit/i);
    expect(d.writeBoard).not.toHaveBeenCalled();
  });

  it("rejects a blank title", async () => {
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "   " }), deps({}), 0))
      .rejects.toThrow(/title/i);
  });

  it("ignores any client-supplied inviteCode and generates its own", async () => {
    const d = deps({ boardCount: 0 });
    const res = await handleCreateBoard(
      reqFor("u1", { workspaceId: "ws1", title: "T", inviteCode: "HACKED" }),
      d,
      0
    );
    expect(res.inviteCode).not.toBe("HACKED");
    expect(res.inviteCode).toMatch(/^[A-Z0-9]{6}$/);
    // The doc handed to writeBoard must carry the server-generated code too,
    // never whatever the client attempted to smuggle in.
    const written = d.writeBoard.mock.calls[0][0];
    expect(written.inviteCode).toBe(res.inviteCode);
    expect(written.inviteCode).not.toBe("HACKED");
  });
});

describe("generateInviteCode", () => {
  it("returns six characters from the expected alphabet", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateInviteCode()).toMatch(/^[A-Z0-9]{6}$/);
    }
  });

  it("does not always return the same code (drawn from the RNG, not hardcoded)", () => {
    const codes = new Set(Array.from({ length: 25 }, () => generateInviteCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});
