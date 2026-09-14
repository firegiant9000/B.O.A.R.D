import { HttpsError } from "firebase-functions/v2/https";
import { handleCreateSession, makeRunCreate } from "../callable/createSession";
import { currentPeriod } from "../ai/usage";
import type { SessionUsageDoc } from "../billing/usage";
import type { Plan } from "../billing/limits";

const base = { workspaceId: "ws1", boardId: "b1", title: "Study", scheduledAtMs: 1_760_000_000_000, durationMinutes: 60 };

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

const deps = (opts: {
  plan?: string;
  sessions?: number;
  member?: boolean;
  /** Month 6 — the workspace's stored `welcomeSessionGrantUsed` marker.
   *  Omitted (undefined) is the shape every pre-grant test already had: a
   *  workspace that has never taken the grant. */
  grantUsed?: boolean;
}) => {
  // Typed explicitly (mirrors createBoard.test.ts's `deps`) so the ternary's
  // `{}` branch doesn't widen to `{ u1?: undefined }` and fail to satisfy
  // CreateSessionDeps' `Record<string, string>` members type.
  const members: Record<string, string> = opts.member === false ? {} : { u1: "member" };
  return {
    getWorkspace: jest.fn(async () => ({
      plan: opts.plan ?? "free",
      members,
      welcomeSessionGrantUsed: opts.grantUsed,
    })),
    runCreate: jest.fn(async () => ({ sessionId: "s1", joinCode: "ABC123" })),
    readSessionCount: jest.fn(async () => opts.sessions ?? 0),
  };
};

describe("handleCreateSession", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(handleCreateSession(reqFor(undefined, base), deps({}), 0))
      .rejects.toBeInstanceOf(HttpsError);
  });

  it("rejects a non-member", async () => {
    await expect(handleCreateSession(reqFor("u1", base), deps({ member: false }), 0))
      .rejects.toThrow(/not a member/i);
  });

  it("creates when under the monthly cap", async () => {
    const d = deps({ sessions: 2 });
    await expect(handleCreateSession(reqFor("u1", base), d, 0))
      .resolves.toMatchObject({ sessionId: "s1" });
    expect(d.runCreate).toHaveBeenCalled();
  });

  it("blocks the 4th session in a period on free", async () => {
    const d = deps({ sessions: 3 });
    await expect(handleCreateSession(reqFor("u1", base), d, 0)).rejects.toThrow(/limit/i);
    expect(d.runCreate).not.toHaveBeenCalled();
  });

  it("allows the 4th session on pro", async () => {
    const d = deps({ plan: "pro", sessions: 3 });
    await expect(handleCreateSession(reqFor("u1", base), d, 0)).resolves.toMatchObject({ sessionId: "s1" });
  });

  it("requires a boardId", async () => {
    await expect(handleCreateSession(reqFor("u1", { ...base, boardId: "" }), deps({}), 0))
      .rejects.toThrow(/boardId/i);
  });

  // ── additional coverage beyond the brief's verbatim block ──────────────────

  it("rejects a request with no workspaceId", async () => {
    const d = deps({});
    await expect(handleCreateSession(reqFor("u1", { ...base, workspaceId: "" }), d, 0))
      .rejects.toMatchObject({ code: "invalid-argument" });
    expect(d.runCreate).not.toHaveBeenCalled();
  });

  it("rejects when the workspace does not exist", async () => {
    const d = deps({});
    d.getWorkspace.mockResolvedValueOnce(null as never);
    await expect(handleCreateSession(reqFor("u1", base), d, 0))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects a blank title", async () => {
    await expect(handleCreateSession(reqFor("u1", { ...base, title: "   " }), deps({}), 0))
      .rejects.toThrow(/title/i);
  });

  it("rejects a missing scheduledAtMs", async () => {
    const { scheduledAtMs: _omit, ...rest } = base;
    await expect(handleCreateSession(reqFor("u1", rest), deps({}), 0))
      .rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects a non-positive durationMinutes", async () => {
    await expect(handleCreateSession(reqFor("u1", { ...base, durationMinutes: 0 }), deps({}), 0))
      .rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects an implausible scheduledAtMs before it ever reaches Timestamp.fromMillis", async () => {
    // 1e18ms is nowhere near a real calendar date; unbounded, this would
    // reach `Timestamp.fromMillis` and throw a RangeError that surfaces as
    // an opaque "internal" error instead of a clean "invalid-argument".
    await expect(handleCreateSession(reqFor("u1", { ...base, scheduledAtMs: 1e18 }), deps({}), 0))
      .rejects.toMatchObject({ code: "invalid-argument" });
  });

  it('blocks the 4th session on a "__proto__" plan even genuinely under the real free cap', async () => {
    // Same fail-open PLAN_LIMITS["__proto__"] === Object.prototype trap as
    // handleCreateBoard's gate (functions/src/callable/createBoard.ts):
    // limitFor("__proto__", ...) resolves through the object's own
    // prototype chain rather than the `?? free` fallback, so
    // `["sessionsPerPeriod"]` off it is `undefined`. `used` here is a genuine
    // 2 — under the real free cap of 3 — so the old `used >= limit` form
    // (`2 >= undefined` -> `false`) would have created the session; only the
    // negated `!(used < limit)` form denies.
    const d = deps({ plan: "__proto__", sessions: 2 });
    await expect(handleCreateSession(reqFor("u1", base), d, 0))
      .rejects.toMatchObject({ code: "resource-exhausted" });
    expect(d.runCreate).not.toHaveBeenCalled();
  });

  // Reads a call's sessionDoc argument as `Record<string, unknown>` regardless
  // of the mock factory's inferred (parameter-less) call-tuple type — the
  // runtime array always holds the real arguments handleCreateSession passed.
  function sessionDocArgOf(mock: jest.Mock, callIndex = 0): Record<string, unknown> {
    return mock.mock.calls[callIndex][1] as Record<string, unknown>;
  }

  it("derives createdById from the auth token, ignoring any client-supplied value", async () => {
    const d = deps({ sessions: 0 });
    await handleCreateSession(reqFor("u1", { ...base, createdById: "victim" }), d, 0);
    const sessionDoc = sessionDocArgOf(d.runCreate);
    expect(sessionDoc.createdById).toBe("u1");
    expect(sessionDoc.createdById).not.toBe("victim");
  });

  it("never forwards a client-supplied joinCode into the session document handed to runCreate", async () => {
    const d = deps({ sessions: 0 });
    await handleCreateSession(reqFor("u1", { ...base, joinCode: "HACKED" }), d, 0);
    const sessionDoc = sessionDocArgOf(d.runCreate);
    expect(sessionDoc).not.toHaveProperty("joinCode");
  });

  it("stamps startedAt when created already active, omits it otherwise", async () => {
    const d = deps({ sessions: 0 });
    await handleCreateSession(reqFor("u1", { ...base, status: "active" }), d, 0);
    let sessionDoc = sessionDocArgOf(d.runCreate);
    expect(sessionDoc).toHaveProperty("startedAt");
    expect(sessionDoc.status).toBe("active");

    d.runCreate.mockClear();
    await handleCreateSession(reqFor("u1", base), d, 0);
    sessionDoc = sessionDocArgOf(d.runCreate);
    expect(sessionDoc).not.toHaveProperty("startedAt");
    expect(sessionDoc.status).toBe("scheduled");
  });

  it("sanitizes participantIds: drops non-string/empty entries and caps the list at 100", async () => {
    const d = deps({ sessions: 0 });
    const garbage = [
      "u1",
      42,
      null,
      "",
      "   ",
      "u2",
      ...Array.from({ length: 150 }, (_, i) => `filler-${i}`),
    ];
    await handleCreateSession(reqFor("u1", { ...base, participantIds: garbage }), d, 0);
    const sessionDoc = sessionDocArgOf(d.runCreate);
    const participantIds = sessionDoc.participantIds as unknown[];

    expect(participantIds.every((p) => typeof p === "string" && p.trim().length > 0)).toBe(true);
    expect(participantIds.length).toBeLessThanOrEqual(100);
    expect(participantIds).toContain("u1");
    expect(participantIds).toContain("u2");
  });

  // ── Month 6: the welcome-session grant, at the handler level ───────────────
  //
  // The handler does not DECIDE the grant — `runCreate`'s transaction does, by
  // re-reading the workspace. What the handler owns is two things worth
  // pinning: it forwards the request faithfully, and it skips its own fail-fast
  // cap pre-check when the grant looks available, because that pre-check would
  // otherwise deny a never-seeded workspace sitting at 3/3 before the
  // transaction ever got the chance to honour the grant.

  /** Reads the 5th positional argument (`welcomeSessionGrant`) off a runCreate
   *  call, as `unknown`, for the same reason `sessionDocArgOf` above reads the
   *  2nd: the mock factory's inferred (parameter-less) call-tuple type doesn't
   *  describe the real runtime arguments. */
  function grantArgOf(mock: jest.Mock, callIndex = 0): unknown {
    return mock.mock.calls[callIndex][4];
  }

  it("forwards a welcomeSessionGrant request to runCreate", async () => {
    const d = deps({ sessions: 0 });
    await handleCreateSession(reqFor("u1", { ...base, welcomeSessionGrant: true }), d, 0);
    expect(grantArgOf(d.runCreate)).toBe(true);
  });

  it("tells runCreate an ordinary create is NOT a grant request", async () => {
    const d = deps({ sessions: 0 });
    await handleCreateSession(reqFor("u1", base), d, 0);
    expect(grantArgOf(d.runCreate)).toBe(false);
  });

  it("treats a non-`true` welcomeSessionGrant as no request at all", async () => {
    // The check is `=== true`, not truthiness: a string, a 1, or an object
    // smuggled into `req.data` must not read as a request for a free session.
    const d = deps({ sessions: 3 });
    await expect(
      handleCreateSession(reqFor("u1", { ...base, welcomeSessionGrant: "yes" }), d, 0)
    ).rejects.toMatchObject({ code: "resource-exhausted" });
    expect(d.runCreate).not.toHaveBeenCalled();
  });

  it("skips the fail-fast cap pre-check when the grant looks available — a workspace AT the cap is still seedable", async () => {
    // The whole point of the grant: 3/3 on free, never seeded, must still get
    // its demo session. `readSessionCount` is not even consulted, so this
    // cannot be an accident of the count happening to pass.
    const d = deps({ sessions: 3 });
    await expect(
      handleCreateSession(reqFor("u1", { ...base, welcomeSessionGrant: true }), d, 0)
    ).resolves.toMatchObject({ sessionId: "s1" });
    expect(d.readSessionCount).not.toHaveBeenCalled();
    expect(grantArgOf(d.runCreate)).toBe(true);
  });

  it("still runs the cap pre-check when the workspace has already used its grant", async () => {
    // Second ask on the same workspace: the grant is gone, so this is an
    // ordinary create and the ordinary cap applies, fail-fast and all.
    const d = deps({ sessions: 3, grantUsed: true });
    await expect(
      handleCreateSession(reqFor("u1", { ...base, welcomeSessionGrant: true }), d, 0)
    ).rejects.toMatchObject({ code: "resource-exhausted" });
    expect(d.readSessionCount).toHaveBeenCalled();
    expect(d.runCreate).not.toHaveBeenCalled();
  });

  it("still creates for a used-grant workspace that is genuinely under the cap", async () => {
    // The marker must cost nothing but the grant itself — a workspace that has
    // spent it is an ordinary workspace, not a penalised one.
    const d = deps({ sessions: 1, grantUsed: true });
    await expect(
      handleCreateSession(reqFor("u1", { ...base, welcomeSessionGrant: true }), d, 0)
    ).resolves.toMatchObject({ sessionId: "s1" });
    // Still forwarded: the handler's read of the marker is a stale pre-flight,
    // so the transaction — not this — makes the final call.
    expect(grantArgOf(d.runCreate)).toBe(true);
  });

  it("never writes welcomeSessionGrant onto the session document", async () => {
    // It is a request about METERING, not a property of the session. A session
    // document must not be readable later as "this one was free".
    const d = deps({ sessions: 0 });
    await handleCreateSession(reqFor("u1", { ...base, welcomeSessionGrant: true }), d, 0);
    expect(sessionDocArgOf(d.runCreate)).not.toHaveProperty("welcomeSessionGrant");
  });
});

// ── the real transactional core ───────────────────────────────────────────────
//
// `handleCreateSession`'s tests above mock `runCreate` entirely, so they can't
// prove the counter increment and the session write actually share one
// transaction, or that `prev` really comes from `tx.get` rather than some
// other source. This block exercises the production `makeRunCreate` against a
// fake Firestore-like `db`/`tx` (mirroring the fake used in
// functions/src/__tests__/billingUsage.test.ts) to prove exactly that.
//
// The fake `tx` below DOES enforce Firestore's real "all reads before any
// write" transaction rule (`get` throws once a `set` has happened) — so a
// regression that read after writing would fail these tests, not just a
// hand-inspection of the implementation.

const T = Date.UTC(2026, 8, 9, 12, 0, 0); // 2026-09-09

function fakeTransactionalDb(
  usage: SessionUsageDoc | undefined,
  // Month 6 — the workspace document the grant branch reads. Defaults to an
  // existing workspace with no marker, which is what every pre-grant test
  // already implied; `null` models a workspace deleted between the handler's
  // pre-flight and this transaction. `tx.get` now dispatches on the ref path
  // instead of answering every read with the usage doc, so the two reads can
  // differ — no pre-existing test reads the workspace ref at all, since none
  // of them request the grant.
  workspace: Record<string, unknown> | null = {}
) {
  let writesStarted = false;
  const tx = {
    get: jest.fn(async (ref: { path: string }) => {
      if (writesStarted) {
        throw new Error("fake tx: read attempted after a write — violates Firestore's ordering rule");
      }
      if (ref.path.includes("/usage/")) {
        return usage === undefined ? { exists: false } : { exists: true, data: () => usage };
      }
      return workspace === null ? { exists: false } : { exists: true, data: () => workspace };
    }),
    set: jest.fn((_ref: { path: string }, _data: unknown, _options?: unknown) => {
      writesStarted = true;
    }),
  };
  let autoId = 0;
  const db = {
    doc: (path: string) => ({ path }),
    collection: (name: string) => ({
      doc: () => {
        autoId += 1;
        return { id: `auto${autoId}`, path: `${name}/auto${autoId}` };
      },
    }),
    runTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, tx };
}

const sessionDocFixture = {
  workspaceId: "ws1",
  boardId: "b1",
  title: "Study",
  durationMinutes: 60,
  createdById: "u1",
  status: "scheduled",
};

describe("makeRunCreate (the real transactional core)", () => {
  it("writes the session doc and bumps the counter inside ONE transaction", async () => {
    const { db, tx } = fakeTransactionalDb({ sessions: 2, updatedAt: 0 });
    const runCreate = makeRunCreate(db);

    const res = await runCreate("ws1", sessionDocFixture, T, "free");

    expect(db.runTransaction).toHaveBeenCalledTimes(1);
    expect(tx.set).toHaveBeenCalledTimes(2);
    const paths = tx.set.mock.calls.map(([ref]) => ref.path);
    expect(paths.some((p: string) => p.startsWith("sessions/"))).toBe(true);
    expect(paths).toContain(`workspaces/ws1/usage/${currentPeriod(T)}`);
    expect(res.sessionId).toBeTruthy();
  });

  it("derives `prev`/`used` from tx.get on the usage ref — a free workspace genuinely AT the cap is denied", async () => {
    // makeRunCreate never receives readSessionCount at all, so this denial
    // can only come from the value tx.get returned inside this transaction.
    const { tx, db } = fakeTransactionalDb({ sessions: 3, updatedAt: 0 });
    const runCreate = makeRunCreate(db);

    await expect(runCreate("ws1", sessionDocFixture, T, "free")).rejects.toMatchObject({
      code: "resource-exhausted",
    });
    expect(tx.set).not.toHaveBeenCalled();
  });

  it("allows a genuinely-under-cap free workspace (2 of 3)", async () => {
    const { db } = fakeTransactionalDb({ sessions: 2, updatedAt: 0 });
    const runCreate = makeRunCreate(db);
    await expect(runCreate("ws1", sessionDocFixture, T, "free")).resolves.toMatchObject({
      sessionId: expect.any(String),
      joinCode: expect.stringMatching(/^[A-Z0-9]{6}$/),
    });
  });

  it('fails closed on a "__proto__" plan even genuinely under the real free cap', async () => {
    const { db, tx } = fakeTransactionalDb({ sessions: 2, updatedAt: 0 });
    const runCreate = makeRunCreate(db);
    await expect(
      runCreate("ws1", sessionDocFixture, T, "__proto__" as Plan)
    ).rejects.toMatchObject({ code: "resource-exhausted" });
    expect(tx.set).not.toHaveBeenCalled();
  });

  it("generates its own join code, ignoring any joinCode already present on the incoming sessionDoc", async () => {
    const { db, tx } = fakeTransactionalDb(undefined);
    const runCreate = makeRunCreate(db);

    const res = await runCreate("ws1", { ...sessionDocFixture, joinCode: "HACKED" }, T, "pro");

    expect(res.joinCode).not.toBe("HACKED");
    expect(res.joinCode).toMatch(/^[A-Z0-9]{6}$/);
    const sessionSetCall = tx.set.mock.calls.find(([ref]) => ref.path.startsWith("sessions/"));
    const written = sessionSetCall?.[1] as Record<string, unknown> | undefined;
    expect(written?.joinCode).toBe(res.joinCode);
    expect(written?.joinCode).not.toBe("HACKED");
  });

  it("increments the counter using applySessionUsage's math on the tx.get'd prev", async () => {
    const { db, tx } = fakeTransactionalDb({ sessions: 1, updatedAt: 0 });
    const runCreate = makeRunCreate(db);

    await runCreate("ws1", sessionDocFixture, T, "free");

    const usageSetCall = tx.set.mock.calls.find(
      ([ref]) => ref.path === `workspaces/ws1/usage/${currentPeriod(T)}`
    );
    expect(usageSetCall?.[1]).toEqual({ sessions: 2, updatedAt: T });
  });

  it("allows unlimited sessions on pro even past the free cap", async () => {
    const { db } = fakeTransactionalDb({ sessions: 50, updatedAt: 0 });
    const runCreate = makeRunCreate(db);
    await expect(runCreate("ws1", sessionDocFixture, T, "pro")).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
  });

  it("treats a corrupt (NaN) stored counter as 0 rather than denying — the Number.isFinite guard", async () => {
    // A NaN `sessions` value is a legal Firestore double, so a typeof-only
    // check would let it through as-is and a downstream `NaN < 3` comparison
    // is false, which would wrongly deny. The guard resets it to 0 instead,
    // which must actually ALLOW the create on free (the fail-open this guard
    // exists to prevent is denying a workspace that's really at zero usage).
    const { db, tx } = fakeTransactionalDb({ sessions: NaN, updatedAt: 0 });
    const runCreate = makeRunCreate(db);

    await expect(runCreate("ws1", sessionDocFixture, T, "free")).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    const usageSetCall = tx.set.mock.calls.find(
      ([ref]) => ref.path === `workspaces/ws1/usage/${currentPeriod(T)}`
    );
    // Counted up from the guarded 0, not from NaN (which would poison the sum).
    expect(usageSetCall?.[1]).toEqual({ sessions: 1, updatedAt: T });
  });

  it("allows creation on free when no usage doc exists yet (missing doc + free plan)", async () => {
    // Previously only exercised with plan "pro" (where any `used` value
    // passes anyway) — pinned here specifically on "free" so a regression
    // that mis-derives `used` from a missing doc as something other than 0
    // would show up as a wrongful denial on the plan that actually enforces.
    const { db } = fakeTransactionalDb(undefined);
    const runCreate = makeRunCreate(db);
    await expect(runCreate("ws1", sessionDocFixture, T, "free")).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
  });

  it("does not read the workspace document at all on an ordinary create", async () => {
    // The grant's extra read is conditional on the request, so every ordinary
    // create keeps costing exactly one transactional read — the usage doc.
    const { db, tx } = fakeTransactionalDb({ sessions: 1, updatedAt: 0 });
    const runCreate = makeRunCreate(db);

    await runCreate("ws1", sessionDocFixture, T, "free");

    expect(tx.get).toHaveBeenCalledTimes(1);
    expect(tx.get.mock.calls[0][0].path).toBe(`workspaces/ws1/usage/${currentPeriod(T)}`);
  });
});

// ── Month 6: the welcome-session grant, in the transaction that decides it ────
//
// This is where the grant is actually adjudicated (the handler only forwards
// the request), so this is where the two properties that matter have to be
// proved: the grant does not touch the counter, and it can be taken AT MOST
// ONCE per workspace — because the marker recording it is written in the same
// transaction as the un-metered session, not after it.

const USAGE_PATH = `workspaces/ws1/usage/${currentPeriod(T)}`;
const WORKSPACE_PATH = "workspaces/ws1";

const pathsSetBy = (tx: { set: jest.Mock }): string[] =>
  tx.set.mock.calls.map(([ref]) => (ref as { path: string }).path);

const setCallFor = (tx: { set: jest.Mock }, path: string) =>
  tx.set.mock.calls.find(([ref]) => (ref as { path: string }).path === path);

describe("makeRunCreate — the welcome-session grant", () => {
  it("creates the session, skips the counter, and marks the workspace — all in ONE transaction", async () => {
    const { db, tx } = fakeTransactionalDb({ sessions: 0, updatedAt: 0 }, {});
    const runCreate = makeRunCreate(db);

    const res = await runCreate("ws1", sessionDocFixture, T, "free", true);

    expect(res.sessionId).toBeTruthy();
    expect(db.runTransaction).toHaveBeenCalledTimes(1);

    const paths = pathsSetBy(tx);
    expect(paths.some((p) => p.startsWith("sessions/"))).toBe(true);
    // The counter is the whole point: it must NOT move.
    expect(paths).not.toContain(USAGE_PATH);
    // ...and the marker must land, in this same transaction, alongside the
    // session write. Both `tx.set`s happen inside the one `runTransaction`
    // callback above, which is what makes "two concurrent requests cannot both
    // claim the grant" true rather than merely intended.
    expect(paths).toContain(WORKSPACE_PATH);
    expect(paths).toHaveLength(2);

    const markerCall = setCallFor(tx, WORKSPACE_PATH);
    expect(markerCall?.[1]).toEqual({ welcomeSessionGrantUsed: true });
    // Merged, not overwritten: this transaction owns one field of a document
    // full of things (name, members, plan, ownerId, sampleSeededAt) it must
    // not destroy.
    expect(markerCall?.[2]).toEqual({ merge: true });
  });

  it("grants to a free workspace already AT the cap — the case the grant exists for", async () => {
    // 3/3 on free. The ordinary path denies this (see "derives `prev`/`used`
    // from tx.get..." above, same fixture); the grant must not.
    const { db, tx } = fakeTransactionalDb({ sessions: 3, updatedAt: 0 }, {});
    const runCreate = makeRunCreate(db);

    await expect(runCreate("ws1", sessionDocFixture, T, "free", true)).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(pathsSetBy(tx)).not.toContain(USAGE_PATH);
  });

  it("meters normally once the marker is set — a second request for the grant is an ordinary create", async () => {
    const { db, tx } = fakeTransactionalDb(
      { sessions: 0, updatedAt: 0 },
      { welcomeSessionGrantUsed: true }
    );
    const runCreate = makeRunCreate(db);

    await expect(runCreate("ws1", sessionDocFixture, T, "free", true)).resolves.toMatchObject({
      sessionId: expect.any(String),
    });

    const paths = pathsSetBy(tx);
    expect(paths).toContain(USAGE_PATH);
    // No second marker write: nothing to record, and nothing to re-grant.
    expect(paths).not.toContain(WORKSPACE_PATH);
    expect(setCallFor(tx, USAGE_PATH)?.[1]).toEqual({ sessions: 1, updatedAt: T });
  });

  it("denies a second grant request on a workspace that is also at the cap", async () => {
    // Marker set AND 3/3: the grant is spent, so the ordinary cap decides, and
    // the ordinary cap says no. Nothing is written.
    const { db, tx } = fakeTransactionalDb(
      { sessions: 3, updatedAt: 0 },
      { welcomeSessionGrantUsed: true }
    );
    const runCreate = makeRunCreate(db);

    await expect(runCreate("ws1", sessionDocFixture, T, "free", true)).rejects.toMatchObject({
      code: "resource-exhausted",
    });
    expect(tx.set).not.toHaveBeenCalled();
  });

  it("reads the marker strictly — only a literal `true` withholds the grant", async () => {
    // A workspace whose marker is `false` (or any other non-`true` value a
    // migration or a half-write could leave) has not spent its grant. The
    // asymmetry is deliberate: only the value this code itself writes counts
    // as spent.
    const { db, tx } = fakeTransactionalDb(
      { sessions: 3, updatedAt: 0 },
      { welcomeSessionGrantUsed: false }
    );
    const runCreate = makeRunCreate(db);

    await expect(runCreate("ws1", sessionDocFixture, T, "free", true)).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(pathsSetBy(tx)).toContain(WORKSPACE_PATH);
  });

  it("falls back to the metered path when the workspace no longer exists", async () => {
    // Deleted between the handler's pre-flight read and this transaction. The
    // marker write is a merging `set`, which would otherwise resurrect the
    // document as a stub holding nothing but the marker — so `exists` gates it.
    const { db, tx } = fakeTransactionalDb({ sessions: 0, updatedAt: 0 }, null);
    const runCreate = makeRunCreate(db);

    await runCreate("ws1", sessionDocFixture, T, "free", true);

    const paths = pathsSetBy(tx);
    expect(paths).toContain(USAGE_PATH);
    expect(paths).not.toContain(WORKSPACE_PATH);
  });

  it("reads the workspace before it writes anything — the marker is not a post-hoc write", async () => {
    // The fake `tx` throws on any read after a write, so this passing at all
    // proves the workspace read is inside the transaction's read phase rather
    // than tacked on after the session was already created.
    const { db, tx } = fakeTransactionalDb({ sessions: 0, updatedAt: 0 }, {});
    const runCreate = makeRunCreate(db);

    await runCreate("ws1", sessionDocFixture, T, "free", true);

    expect(tx.get).toHaveBeenCalledTimes(2);
    expect(pathsSetBy(tx)).toHaveLength(2);
  });

  it("still meters an ordinary create on a workspace that never took the grant", async () => {
    // Guards the branch from the other side: the grant is opt-in, so a
    // never-marked workspace creating a session WITHOUT asking must behave
    // exactly as it did before the grant existed.
    const { db, tx } = fakeTransactionalDb({ sessions: 2, updatedAt: 0 }, {});
    const runCreate = makeRunCreate(db);

    await runCreate("ws1", sessionDocFixture, T, "free");

    expect(setCallFor(tx, USAGE_PATH)?.[1]).toEqual({ sessions: 3, updatedAt: T });
    expect(pathsSetBy(tx)).not.toContain(WORKSPACE_PATH);
  });
});

// ── At most once per workspace, proved end-to-end ─────────────────────────────
//
// Every test above feeds `makeRunCreate` a fixed workspace state. This block
// instead lets the marker the FIRST transaction writes be what the SECOND
// transaction reads, which is the property the whole design rests on: the
// grant is self-extinguishing. A stateful fake, mirroring the stateful
// workspace fake in src/services/__tests__/onboardingService.test.ts.

function statefulGrantDb(
  usage: SessionUsageDoc | undefined,
  workspace: Record<string, unknown>
) {
  const store = { usage, workspace };
  let autoId = 0;
  const sessionWrites: Array<Record<string, unknown>> = [];

  const db = {
    doc: (path: string) => ({ path }),
    collection: (name: string) => ({
      doc: () => {
        autoId += 1;
        return { id: `auto${autoId}`, path: `${name}/auto${autoId}` };
      },
    }),
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) => {
      let writesStarted = false;
      const tx = {
        get: async (ref: { path: string }) => {
          if (writesStarted) throw new Error("fake tx: read after write");
          if (ref.path.includes("/usage/")) {
            return store.usage === undefined
              ? { exists: false }
              : { exists: true, data: () => store.usage };
          }
          return { exists: true, data: () => store.workspace };
        },
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          writesStarted = true;
          if (ref.path.includes("/usage/")) {
            store.usage = data as unknown as SessionUsageDoc;
          } else if (ref.path.startsWith("sessions/")) {
            sessionWrites.push(data);
          } else {
            store.workspace = options?.merge ? { ...store.workspace, ...data } : data;
          }
        },
      };
      return fn(tx);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { db, store, sessionWrites };
}

describe("the welcome-session grant is claimable at most once per workspace", () => {
  it("the first request is free, the second is metered — the marker the first wrote is what stops it", async () => {
    const { db, store, sessionWrites } = statefulGrantDb(undefined, { name: "Personal" });
    const runCreate = makeRunCreate(db);

    // First ask: un-metered. No usage document is even created.
    await runCreate("ws1", sessionDocFixture, T, "free", true);
    expect(store.usage).toBeUndefined();
    expect(store.workspace).toEqual({ name: "Personal", welcomeSessionGrantUsed: true });

    // Second ask, same workspace, same flag: metered like anything else.
    await runCreate("ws1", sessionDocFixture, T, "free", true);
    expect(store.usage).toEqual({ sessions: 1, updatedAt: T });

    // Third and fourth: still metered, and the free cap still bites at 3.
    await runCreate("ws1", sessionDocFixture, T, "free", true);
    await runCreate("ws1", sessionDocFixture, T, "free", true);
    expect(store.usage).toEqual({ sessions: 3, updatedAt: T });
    await expect(runCreate("ws1", sessionDocFixture, T, "free", true)).rejects.toMatchObject({
      code: "resource-exhausted",
    });

    // Four sessions exist, three were charged: the grant is worth exactly one
    // extra session per workspace, ever — the bound the design accepts.
    expect(sessionWrites).toHaveLength(4);
    expect(store.usage).toEqual({ sessions: 3, updatedAt: T });
  });

  it("the marker survives as the only thing that changed on the workspace document", async () => {
    // The merging write must not clobber the fields the workspace actually
    // needs — the pinned ones especially.
    const { db, store } = statefulGrantDb(undefined, {
      name: "Personal",
      ownerId: "u1",
      plan: "free",
      members: { u1: "owner" },
    });
    const runCreate = makeRunCreate(db);

    await runCreate("ws1", sessionDocFixture, T, "free", true);

    expect(store.workspace).toEqual({
      name: "Personal",
      ownerId: "u1",
      plan: "free",
      members: { u1: "owner" },
      welcomeSessionGrantUsed: true,
    });
  });
});
