import { HttpsError } from "firebase-functions/v2/https";
import { handleCreateClass, makeWriteClass } from "../callable/createClass";

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

function deps() {
  return {
    writeClass: jest.fn(async (_doc: Record<string, unknown>, _joinCode: string) => "class123"),
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

  it("passes the same join code as the second argument, for the joinCodes lookup write", async () => {
    const d = deps();
    const res = await handleCreateClass(reqFor("instructor1", { name: "CS 101" }), d, 0);
    expect(d.writeClass.mock.calls[0][1]).toBe(res.joinCode);
  });
});

describe("makeWriteClass", () => {
  // Fix round 1, I4 — the class doc and its joinCodes lookup entry must be
  // written atomically (one batch), never as two independent writes that
  // could diverge if the second failed.
  it("writes the class doc and a matching joinCodes/{code} doc in ONE batch", async () => {
    const classRef = { id: "class123" };
    const joinCodeRef = { id: "ABC123" };
    const batchSet = jest.fn();
    const batchCommit = jest.fn(async () => undefined);
    const classesDoc = jest.fn(() => classRef);
    const joinCodesDoc = jest.fn(() => joinCodeRef);
    const fakeDb = {
      collection: jest.fn((name: string) => ({
        doc: name === "classes" ? classesDoc : joinCodesDoc,
      })),
      batch: jest.fn(() => ({ set: batchSet, commit: batchCommit })),
    } as never;

    const writeClass = makeWriteClass(fakeDb);
    const classDoc = { name: "CS 101", instructorId: "instructor1" };
    const classId = await writeClass(classDoc, "ABC123");

    expect(classId).toBe("class123");
    expect(joinCodesDoc).toHaveBeenCalledWith("ABC123");
    expect(batchSet).toHaveBeenCalledWith(classRef, classDoc);
    expect(batchSet).toHaveBeenCalledWith(joinCodeRef, { classId: "class123" });
    expect(batchCommit).toHaveBeenCalledTimes(1);
  });
});
