jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, makeDocSnap, ts } from "../../test-utils/firestoreMock";
import * as sessionService from "../sessionService";
import * as quotaService from "../quotaService";
import { Session } from "../../types";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;

const baseSession: Omit<Session, "id" | "createdAt"> = {
  workspaceId: "ws-1",
  boardId: "board-1",
  boardTitle: "Board",
  title: "Study",
  description: "",
  scheduledAt: new Date("2026-06-10T15:00:00Z"),
  durationMinutes: 60,
  createdById: "u1",
  createdByName: "Arlo",
  participantIds: [],
  status: "scheduled",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("createSession", () => {
  it("generates a SESS- join code, converts scheduledAt, and stamps createdAt", async () => {
    addDoc.mockResolvedValueOnce({ id: "sess-1" });

    const id = await sessionService.createSession(baseSession);

    expect(id).toBe("sess-1");
    const payload = addDoc.mock.calls[0][1];
    expect(payload.joinCode).toMatch(/^SESS-[A-Z0-9]{6}$/);
    expect(payload.scheduledAt).toMatchObject({ __type: "timestamp" });
    expect(payload.createdAt).toBe("__serverTimestamp__");
  });

  it("omits summary when undefined", async () => {
    addDoc.mockResolvedValueOnce({ id: "sess-1" });
    await sessionService.createSession(baseSession);
    expect(addDoc.mock.calls[0][1]).not.toHaveProperty("summary");
  });

  it("stamps the inherited workspaceId onto the session (Phase 4)", async () => {
    addDoc.mockResolvedValueOnce({ id: "sess-1" });
    await sessionService.createSession(baseSession);
    expect(addDoc.mock.calls[0][1].workspaceId).toBe("ws-1");
  });

  it("invokes the quota choke point with the inherited workspace (Phase 5)", async () => {
    const spy = jest.spyOn(quotaService, "assertQuota");
    addDoc.mockResolvedValueOnce({ id: "sess-1" });

    await sessionService.createSession(baseSession);

    expect(spy).toHaveBeenCalledWith("ws-1", "session");
    spy.mockRestore();
  });
});

describe("joinSessionByCode", () => {
  it("returns null when the code matches nothing", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    expect(await sessionService.joinSessionByCode("SESS-XXXXXX", "u1")).toBeNull();
  });

  it("reports alreadyJoined for an existing participant without writing", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["sess-1", { participantIds: ["u1"], createdById: "u9" }]])
    );
    const res = await sessionService.joinSessionByCode("sess-aaaaaa", "u1");
    expect(res).toEqual({ sessionId: "sess-1", alreadyJoined: true });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("adds a new participant", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["sess-1", { participantIds: [], createdById: "u9" }]])
    );
    const res = await sessionService.joinSessionByCode("sess-aaaaaa", "u1");
    expect(res).toEqual({ sessionId: "sess-1", alreadyJoined: false });
    expect(updateDoc).toHaveBeenCalledTimes(1);
  });
});

describe("getSessionsForUser", () => {
  it("dedupes across creator/participant queries and sorts descending by scheduledAt", async () => {
    const t1 = new Date("2026-01-01");
    const t2 = new Date("2026-03-01");
    getDocs
      .mockResolvedValueOnce(
        makeQuerySnap([["s1", { title: "A", scheduledAt: ts(t1), createdById: "u1" }]])
      )
      .mockResolvedValueOnce(
        makeQuerySnap([
          ["s1", { title: "A", scheduledAt: ts(t1), createdById: "u1" }], // dup
          ["s2", { title: "B", scheduledAt: ts(t2), createdById: "u9" }],
        ])
      );

    const sessions = await sessionService.getSessionsForUser("u1");

    expect(sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });
});

describe("getEndedSessions (Phase 5)", () => {
  it("filters to status=ended, merges/dedupes both queries, sorts descending", async () => {
    const t1 = new Date("2026-01-01");
    const t2 = new Date("2026-03-01");
    getDocs
      .mockResolvedValueOnce(
        makeQuerySnap([
          ["s1", { scheduledAt: ts(t1), createdById: "u1", status: "ended" }],
        ])
      )
      .mockResolvedValueOnce(
        makeQuerySnap([
          ["s1", { scheduledAt: ts(t1), createdById: "u1", status: "ended" }], // dup
          ["s2", { scheduledAt: ts(t2), createdById: "u9", status: "ended" }],
        ])
      );

    const page = await sessionService.getEndedSessions("u1");

    expect(page.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    // The status==ended clause is sent to both underlying queries.
    const endedClauses = (fs.where as jest.Mock).mock.calls.filter(
      ([field, op, value]) => field === "status" && op === "==" && value === "ended"
    );
    expect(endedClauses.length).toBe(2);
  });

  it("scopes to the active workspace but keeps legacy (unscoped) sessions", async () => {
    const t1 = new Date("2026-01-01");
    const t2 = new Date("2026-02-01");
    const t3 = new Date("2026-03-01");
    getDocs
      .mockResolvedValueOnce(
        makeQuerySnap([
          ["s1", { scheduledAt: ts(t1), createdById: "u1", status: "ended", workspaceId: "ws-1" }],
          ["s2", { scheduledAt: ts(t2), createdById: "u1", status: "ended", workspaceId: "ws-2" }],
          ["s3", { scheduledAt: ts(t3), createdById: "u1", status: "ended" }], // legacy
        ])
      )
      .mockResolvedValueOnce(makeQuerySnap([]));

    const page = await sessionService.getEndedSessions("u1", { workspaceId: "ws-1" });

    expect(page.sessions.map((s) => s.id)).toEqual(["s3", "s1"]);
  });

  it("reports hasMore and a cursor when a query fills the page", async () => {
    const dates = Array.from({ length: 2 }, (_, i) => new Date(2026, 0, i + 1));
    getDocs
      .mockResolvedValueOnce(
        makeQuerySnap(
          dates.map((d, i) => [
            `s${i}`,
            { scheduledAt: ts(d), createdById: "u1", status: "ended" },
          ])
        )
      )
      .mockResolvedValueOnce(makeQuerySnap([]));

    const page = await sessionService.getEndedSessions("u1", { pageSize: 2 });

    expect(page.hasMore).toBe(true); // creator query returned a full page
    expect(page.nextCursor).toEqual(dates[0]); // oldest of the descending page
  });

  it("passes the before-cursor as a scheduledAt upper bound", async () => {
    getDocs.mockResolvedValue(makeQuerySnap([]));
    const before = new Date("2026-05-01");

    await sessionService.getEndedSessions("u1", { before });

    const cursorClauses = (fs.where as jest.Mock).mock.calls.filter(
      ([field, op]) => field === "scheduledAt" && op === "<"
    );
    expect(cursorClauses.length).toBe(2); // applied to both underlying queries
  });
});

describe("getUpcomingSessions", () => {
  it("merges both queries (creator wins on dupes) and sorts ascending", async () => {
    const t1 = new Date("2026-07-01");
    const t2 = new Date("2026-08-01");
    getDocs
      .mockResolvedValueOnce(
        makeQuerySnap([["s2", { title: "B", scheduledAt: ts(t2), createdById: "u1" }]])
      )
      .mockResolvedValueOnce(
        makeQuerySnap([["s1", { title: "A", scheduledAt: ts(t1), createdById: "u9" }]])
      );

    const sessions = await sessionService.getUpcomingSessions("u1");

    expect(sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("scopes to the active workspace but keeps legacy (unscoped) sessions (Phase 4)", async () => {
    const t1 = new Date("2026-07-01");
    const t2 = new Date("2026-08-01");
    const t3 = new Date("2026-09-01");
    getDocs
      .mockResolvedValueOnce(
        makeQuerySnap([
          ["s1", { scheduledAt: ts(t1), createdById: "u1", workspaceId: "ws-1" }],
          ["s2", { scheduledAt: ts(t2), createdById: "u1", workspaceId: "ws-2" }], // other ws
          ["s3", { scheduledAt: ts(t3), createdById: "u1" }], // legacy, no workspaceId
        ])
      )
      .mockResolvedValueOnce(makeQuerySnap([]));

    const sessions = await sessionService.getUpcomingSessions("u1", "ws-1");

    expect(sessions.map((s) => s.id)).toEqual(["s1", "s3"]);
  });
});

describe("updateSession", () => {
  it("converts a scheduledAt Date to a Timestamp", async () => {
    await sessionService.updateSession("sess-1", {
      scheduledAt: new Date("2026-09-09T09:00:00Z"),
    });
    expect(updateDoc.mock.calls[0][1].scheduledAt).toMatchObject({ __type: "timestamp" });
  });
});

describe("createSession lifecycle (Phase 4)", () => {
  it("stamps startedAt when created already active", async () => {
    addDoc.mockResolvedValueOnce({ id: "sess-1" });
    await sessionService.createSession({ ...baseSession, status: "active" });
    expect(addDoc.mock.calls[0][1].startedAt).toBe("__serverTimestamp__");
  });

  it("omits startedAt and agenda for a plain scheduled session", async () => {
    addDoc.mockResolvedValueOnce({ id: "sess-1" });
    await sessionService.createSession(baseSession);
    expect(addDoc.mock.calls[0][1]).not.toHaveProperty("startedAt");
    expect(addDoc.mock.calls[0][1]).not.toHaveProperty("agenda");
  });
});

describe("startSession (Phase 4)", () => {
  it("sets status active and stamps startedAt", async () => {
    await sessionService.startSession("sess-1");
    expect(updateDoc.mock.calls[0][1]).toEqual({
      status: "active",
      startedAt: "__serverTimestamp__",
    });
  });
});

describe("endSession (Phase 4)", () => {
  it("stamps endedAt and writes participants + snapshot when provided", async () => {
    const participants = [{ uid: "u1", displayName: "Arlo", email: "a@x.io" }];
    await sessionService.endSession("sess-1", { participants, snapshot: "data:image/png;base64,AAA" });
    const payload = updateDoc.mock.calls[0][1];
    expect(payload.status).toBe("ended");
    expect(payload.endedAt).toBe("__serverTimestamp__");
    expect(payload.participants).toBe(participants);
    expect(payload.canvasSnapshot).toBe("data:image/png;base64,AAA");
  });

  it("omits participants and snapshot when not supplied", async () => {
    await sessionService.endSession("sess-1");
    const payload = updateDoc.mock.calls[0][1];
    expect(payload).toEqual({ status: "ended", endedAt: "__serverTimestamp__" });
  });
});

describe("resolveParticipantSnapshot (Phase 4)", () => {
  it("includes the creator first, dedupes, and resolves names", async () => {
    getDoc
      .mockResolvedValueOnce(makeDocSnap("u1", { displayName: "Arlo", email: "a@x.io" }))
      .mockResolvedValueOnce(makeDocSnap("u2", { displayName: "Sam", email: "s@x.io" }));
    const snap = await sessionService.resolveParticipantSnapshot({
      createdById: "u1",
      createdByName: "Arlo",
      participantIds: ["u2", "u1"], // u1 dup with creator
    });
    expect(snap).toEqual([
      { uid: "u1", displayName: "Arlo", email: "a@x.io" },
      { uid: "u2", displayName: "Sam", email: "s@x.io" },
    ]);
  });
});

describe("getSession mapping (Phase 4 fields)", () => {
  it("maps agenda, startedAt, endedAt, and participants", async () => {
    const started = new Date("2026-06-10T15:00:00Z");
    const ended = new Date("2026-06-10T16:00:00Z");
    getDoc.mockResolvedValueOnce(
      makeDocSnap("sess-1", {
        boardId: "b1",
        title: "Study",
        createdById: "u1",
        status: "ended",
        agenda: "Review chapter 4",
        startedAt: ts(started),
        endedAt: ts(ended),
        participants: [{ uid: "u1", displayName: "Arlo", email: "a@x.io" }],
      })
    );
    const s = await sessionService.getSession("sess-1");
    expect(s?.agenda).toBe("Review chapter 4");
    expect(s?.startedAt?.getTime()).toBe(started.getTime());
    expect(s?.endedAt?.getTime()).toBe(ended.getTime());
    expect(s?.participants).toEqual([{ uid: "u1", displayName: "Arlo", email: "a@x.io" }]);
  });
});

describe("getParticipantPushTokens", () => {
  it("short-circuits on an empty list", async () => {
    expect(await sessionService.getParticipantPushTokens([])).toEqual([]);
    expect(getDoc).not.toHaveBeenCalled();
  });

  it("collects only the tokens that exist", async () => {
    getDoc
      .mockResolvedValueOnce(makeDocSnap("u1", { pushToken: "tok-1" }))
      .mockResolvedValueOnce(makeDocSnap("u2", {})); // no token
    const tokens = await sessionService.getParticipantPushTokens(["u1", "u2"]);
    expect(tokens).toEqual(["tok-1"]);
  });
});
