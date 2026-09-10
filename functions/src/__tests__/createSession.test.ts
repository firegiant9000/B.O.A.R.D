import { HttpsError } from "firebase-functions/v2/https";
import { handleCreateSession, makeRunCreate } from "../callable/createSession";
import { currentPeriod } from "../ai/usage";
import type { SessionUsageDoc } from "../billing/usage";
import type { Plan } from "../billing/limits";

const base = { workspaceId: "ws1", boardId: "b1", title: "Study", scheduledAtMs: 1_760_000_000_000, durationMinutes: 60 };

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

const deps = (opts: { plan?: string; sessions?: number; member?: boolean }) => {
  // Typed explicitly (mirrors createBoard.test.ts's `deps`) so the ternary's
  // `{}` branch doesn't widen to `{ u1?: undefined }` and fail to satisfy
  // CreateSessionDeps' `Record<string, string>` members type.
  const members: Record<string, string> = opts.member === false ? {} : { u1: "member" };
  return {
    getWorkspace: jest.fn(async () => ({
      plan: opts.plan ?? "free",
      members,
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

function fakeTransactionalDb(usage: SessionUsageDoc | undefined) {
  let writesStarted = false;
  const tx = {
    get: jest.fn(async (_ref: { path: string }) => {
      if (writesStarted) {
        throw new Error("fake tx: read attempted after a write — violates Firestore's ordering rule");
      }
      return usage === undefined ? { exists: false } : { exists: true, data: () => usage };
    }),
    set: jest.fn((_ref: { path: string }, _data: unknown) => {
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
});
