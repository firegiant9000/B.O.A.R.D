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

  // Fix round 3, D — classDoc no longer carries a joinCode field at all
  // (makeWriteClass is the sole place that stamps it, via the second
  // argument); this proves that directly rather than just checking the
  // response, so a future regression that reintroduces a stale field in
  // classDoc would be caught here.
  it("ignores any client-supplied joinCode, generates its own, and never puts it in classDoc", async () => {
    const d = deps();
    const res = await handleCreateClass(
      reqFor("instructor1", { name: "CS 101", joinCode: "HACKED" }),
      d,
      0
    );
    expect(res.joinCode).not.toBe("HACKED");
    expect(res.joinCode).toMatch(/^[A-Z0-9]{6}$/);
    const written = d.writeClass.mock.calls[0][0];
    expect(written).not.toHaveProperty("joinCode");
    expect(d.writeClass.mock.calls[0][1]).toBe(res.joinCode);
    expect(d.writeClass.mock.calls[0][1]).not.toBe("HACKED");
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

  /** Makes every `batch()` call's `commit()` reject with `err`. */
  function failEveryCommitWith(fakeDb: ReturnType<typeof makeFakeDb>["fakeDb"], batches: ReturnType<typeof makeFakeDb>["batches"], err: unknown) {
    (fakeDb.batch as jest.Mock).mockImplementation(() => {
      const b = { create: jest.fn(), set: jest.fn(), commit: jest.fn(async () => { throw err; }) };
      batches.push(b);
      return b;
    });
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
    // Fix round 3, D — the retried batch's WRITTEN classDoc must carry the
    // NEW code, not the stale original ("ABC123") that just collided. This
    // is what makes the `{...classDoc, joinCode: code}` spread load-bearing
    // rather than decorative; a future regression that forgot to override
    // it here would still return the right `res.joinCode` (the return
    // value is independent) but would write the WRONG one to Firestore.
    expect(batches[1].set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ joinCode: res.joinCode })
    );
    expect(res.joinCode).not.toBe("ABC123");
  });

  it("gives up after MAX_JOIN_CODE_ATTEMPTS (3) collisions, surfacing a friendly error rather than the raw one", async () => {
    const { fakeDb, batches } = makeFakeDb();
    failEveryCommitWith(fakeDb, batches, alreadyExistsError());
    const writeClass = makeWriteClass(fakeDb as never);

    // Fix round 3, D — the tail error is now genuinely reachable (an
    // earlier version re-threw the raw ALREADY_EXISTS error on the final
    // attempt instead, making this HttpsError dead code). Asserting on
    // `code: "internal"` here — not `{code: 6}` — is what actually proves
    // that.
    await expect(writeClass({ name: "CS 101" }, "ABC123")).rejects.toMatchObject({
      code: "internal",
    });
    // Exactly 3 attempts — bounded, not 2, not unbounded.
    expect(batches).toHaveLength(3);
  });

  // Fix round 3, C — nothing previously pinned that a NON-collision
  // failure propagates immediately (no retry spent on an unrelated
  // problem) rather than being swallowed into the retry loop. Each case
  // below is a shape `isAlreadyExistsError` must NOT match.
  describe("does not retry a non-collision failure", () => {
    it("propagates a different gRPC code (7, PERMISSION_DENIED) after exactly one attempt", async () => {
      const { fakeDb, batches } = makeFakeDb();
      const err = Object.assign(new Error("7 PERMISSION_DENIED"), { code: 7 });
      failEveryCommitWith(fakeDb, batches, err);
      const writeClass = makeWriteClass(fakeDb as never);

      await expect(writeClass({ name: "CS 101" }, "ABC123")).rejects.toBe(err);
      expect(batches).toHaveLength(1);
    });

    it("propagates a bare Error with no `.code` at all after exactly one attempt", async () => {
      const { fakeDb, batches } = makeFakeDb();
      const err = new Error("network down");
      failEveryCommitWith(fakeDb, batches, err);
      const writeClass = makeWriteClass(fakeDb as never);

      await expect(writeClass({ name: "CS 101" }, "ABC123")).rejects.toBe(err);
      expect(batches).toHaveLength(1);
    });

    it("propagates a STRING-coded error (the client SDK's shape, e.g. \"already-exists\") after exactly one attempt", async () => {
      const { fakeDb, batches } = makeFakeDb();
      const err = Object.assign(new Error("already-exists"), { code: "already-exists" });
      failEveryCommitWith(fakeDb, batches, err);
      const writeClass = makeWriteClass(fakeDb as never);

      await expect(writeClass({ name: "CS 101" }, "ABC123")).rejects.toBe(err);
      expect(batches).toHaveLength(1);
    });
  });
});
