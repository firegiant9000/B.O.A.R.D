import { HttpsError } from "firebase-functions/v2/https";
import { handleCreateClass, makeWriteClass } from "../callable/createClass";

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

function deps() {
  return {
    // Echoes the join code it was handed — no collision simulated at this
    // layer; makeWriteClass's own describe block below covers the retry.
    writeClass: jest.fn(async (_doc: Record<string, unknown>, joinCode: string) => ({
      classId: "class123",
      joinCode,
    })),
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
  /** A fake Firestore-like db whose `batch()` calls are individually
   *  inspectable (`batches[i]`), so a test can make ONLY the first
   *  commit() fail — real collision-then-retry behavior, not just a
   *  globally-failing mock. */
  function makeFakeDb() {
    const batches: { create: jest.Mock; set: jest.Mock; commit: jest.Mock }[] = [];
    const fakeDb = {
      collection: jest.fn((name: string) => ({
        doc: jest.fn((id?: string) => ({ id: id ?? `auto-${batches.length}`, __collection: name })),
      })),
      batch: jest.fn(() => {
        const b = { create: jest.fn(), set: jest.fn(), commit: jest.fn(async () => undefined) };
        batches.push(b);
        return b;
      }),
    };
    return { fakeDb, batches };
  }

  function alreadyExistsError() {
    const err: { code: number } & Error = Object.assign(new Error("6 ALREADY_EXISTS"), { code: 6 });
    return err;
  }

  // Fix round 1, I4 — the class doc and its joinCodes lookup entry must be
  // written atomically (one batch), never as two independent writes that
  // could diverge if the second failed. Fix round 2 — the lookup entry
  // uses `create`, never `set`: `set` silently overwrites a real collision
  // (see this file's own header for the consequence), `create` fails the
  // whole batch instead.
  it("writes the class doc and a matching joinCodes/{code} doc in ONE batch, via create() for the lookup entry", async () => {
    const { fakeDb, batches } = makeFakeDb();
    const writeClass = makeWriteClass(fakeDb as never);
    const classDoc = { name: "CS 101", instructorId: "instructor1" };

    const res = await writeClass(classDoc, "ABC123");

    expect(res.joinCode).toBe("ABC123");
    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ABC123" }),
      { classId: res.classId }
    );
    expect(batch.set).toHaveBeenCalledWith(
      expect.objectContaining({ id: res.classId }),
      { ...classDoc, joinCode: "ABC123" }
    );
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  // Fix round 2 — the bounded regenerate-and-retry the review asked for,
  // pairing with `create()`: a real (if astronomically rare) collision
  // should surface as a transparent retry, not an error thrown at an
  // instructor who did nothing wrong.
  it("regenerates the join code and retries after a simulated ALREADY_EXISTS collision", async () => {
    const { fakeDb, batches } = makeFakeDb();
    (fakeDb.batch as jest.Mock).mockImplementationOnce(() => {
      const b = { create: jest.fn(), set: jest.fn(), commit: jest.fn(async () => { throw alreadyExistsError(); }) };
      batches.push(b);
      return b;
    });
    const writeClass = makeWriteClass(fakeDb as never);

    const res = await writeClass({ name: "CS 101" }, "ABC123");

    expect(batches).toHaveLength(2);
    expect(batches[0].commit).toHaveBeenCalledTimes(1);
    expect(batches[1].commit).toHaveBeenCalledTimes(1);
    // The retried code is genuinely regenerated (generateInviteCode is
    // real, not mocked here) — can't pin an exact value, only its shape,
    // and that the SECOND batch is the one that actually committed.
    expect(res.joinCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(res.classId).toBeTruthy();
  });

  it("gives up after MAX_JOIN_CODE_ATTEMPTS (3) collisions rather than retrying forever", async () => {
    const { fakeDb, batches } = makeFakeDb();
    (fakeDb.batch as jest.Mock).mockImplementation(() => {
      const b = { create: jest.fn(), set: jest.fn(), commit: jest.fn(async () => { throw alreadyExistsError(); }) };
      batches.push(b);
      return b;
    });
    const writeClass = makeWriteClass(fakeDb as never);

    await expect(writeClass({ name: "CS 101" }, "ABC123")).rejects.toMatchObject({ code: 6 });
    // Exactly 3 attempts — bounded, not 2, not unbounded.
    expect(batches).toHaveLength(3);
  });
});
