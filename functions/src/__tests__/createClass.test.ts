import { HttpsError } from "firebase-functions/v2/https";
import { handleCreateClass } from "../callable/createClass";

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

function deps() {
  return {
    writeClass: jest.fn(async (_doc: Record<string, unknown>) => "class123"),
  };
}

describe("handleCreateClass", () => {
  it("rejects an unauthenticated caller", async () => {
    const d = deps();
    await expect(handleCreateClass(reqFor(undefined, { name: "CS 101" }), d, 0))
      .rejects.toBeInstanceOf(HttpsError);
    expect(d.writeClass).not.toHaveBeenCalled();
  });

  it("rejects a blank name", async () => {
    const d = deps();
    await expect(handleCreateClass(reqFor("instructor1", { name: "   " }), d, 0))
      .rejects.toThrow(/name/i);
    expect(d.writeClass).not.toHaveBeenCalled();
  });

  it("rejects a request with no name at all", async () => {
    const d = deps();
    await expect(handleCreateClass(reqFor("instructor1", {}), d, 0))
      .rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("creates a class and returns a 6-char join code", async () => {
    const d = deps();
    const res = await handleCreateClass(reqFor("instructor1", { name: "CS 101" }), d, 0);
    expect(res.classId).toBe("class123");
    expect(res.joinCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(d.writeClass).toHaveBeenCalled();
  });

  it("derives instructorId from the auth token, ignoring any client-supplied value", async () => {
    const d = deps();
    await handleCreateClass(
      reqFor("instructor1", { name: "CS 101", instructorId: "victim" }),
      d,
      0
    );
    const written = d.writeClass.mock.calls[0][0];
    expect(written.instructorId).toBe("instructor1");
    expect(written.instructorId).not.toBe("victim");
  });

  it("ignores any client-supplied joinCode and generates its own", async () => {
    const d = deps();
    const res = await handleCreateClass(
      reqFor("instructor1", { name: "CS 101", joinCode: "HACKED" }),
      d,
      0
    );
    expect(res.joinCode).not.toBe("HACKED");
    const written = d.writeClass.mock.calls[0][0];
    expect(written.joinCode).toBe(res.joinCode);
    expect(written.joinCode).not.toBe("HACKED");
  });

  it("ignores any client-supplied studentIds — a class always starts with none enrolled", async () => {
    const d = deps();
    await handleCreateClass(
      reqFor("instructor1", { name: "CS 101", studentIds: ["stranger1", "stranger2"] }),
      d,
      0
    );
    const written = d.writeClass.mock.calls[0][0];
    expect(written.studentIds).toEqual([]);
  });

  it("stamps schemaVersion 1", async () => {
    const d = deps();
    await handleCreateClass(reqFor("instructor1", { name: "CS 101" }), d, 0);
    const written = d.writeClass.mock.calls[0][0];
    expect(written.schemaVersion).toBe(1);
  });

  it("trims and truncates an overlong name rather than rejecting it", async () => {
    const d = deps();
    const longName = "A".repeat(500);
    await handleCreateClass(reqFor("instructor1", { name: `  ${longName}  ` }), d, 0);
    const written = d.writeClass.mock.calls[0][0];
    expect((written.name as string).length).toBe(200);
  });
});
