jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, makeDocSnap, ts } from "../../test-utils/firestoreMock";
import * as sessionService from "../sessionService";
import { Session } from "../../types";

const addDoc = fs.addDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;

const baseSession: Omit<Session, "id" | "createdAt"> = {
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
});

describe("updateSession", () => {
  it("converts a scheduledAt Date to a Timestamp", async () => {
    await sessionService.updateSession("sess-1", {
      scheduledAt: new Date("2026-09-09T09:00:00Z"),
    });
    expect(updateDoc.mock.calls[0][1].scheduledAt).toMatchObject({ __type: "timestamp" });
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
