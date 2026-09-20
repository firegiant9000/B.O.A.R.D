jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

import * as fs from "firebase/firestore";
import * as nodeFs from "fs";
import * as nodePath from "path";
import { makeQuerySnap, makeDocSnap } from "../../test-utils/firestoreMock";
import * as pollService from "../pollService";
import { PollElement } from "../../types";

const setDoc = fs.setDoc as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const addDoc = fs.addDoc as jest.Mock;
const onSnapshot = fs.onSnapshot as jest.Mock;
const writeBatch = fs.writeBatch as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

const basePoll = {
  question: "Favorite color?",
  options: ["Red", "Blue", "Green"],
  anonymous: false,
  mode: "single" as const,
  x: 10,
  y: 20,
  createdById: "u1",
};

function makePollElement(overrides: Partial<PollElement> = {}): PollElement {
  return {
    id: "p1",
    schemaVersion: 1,
    boardId: "b1",
    question: "Q",
    options: ["A", "B"],
    anonymous: false,
    mode: "single",
    x: 0,
    y: 0,
    createdById: "u1",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("createPoll", () => {
  it("rejects fewer than 2 options before any write", async () => {
    await expect(pollService.createPoll("b1", { ...basePoll, options: ["Only one"] })).rejects.toThrow(
      /2.*6|options/i
    );
    expect(addDoc).not.toHaveBeenCalled();
  });

  it("rejects more than 6 options before any write", async () => {
    await expect(
      pollService.createPoll("b1", { ...basePoll, options: ["A", "B", "C", "D", "E", "F", "G"] })
    ).rejects.toThrow(/2.*6|options/i);
    expect(addDoc).not.toHaveBeenCalled();
  });

  it("writes schemaVersion, question, options, mode and a server timestamp, returning the new id", async () => {
    addDoc.mockResolvedValueOnce({ id: "newPoll1" });

    const id = await pollService.createPoll("b1", basePoll);

    expect(id).toBe("newPoll1");
    expect((fs.collection as jest.Mock).mock.calls.at(-1)).toEqual([{}, "boards", "b1", "polls"]);
    const payload = addDoc.mock.calls[0][1];
    expect(payload).toMatchObject({
      schemaVersion: 1,
      boardId: "b1",
      question: "Favorite color?",
      options: ["Red", "Blue", "Green"],
      anonymous: false,
      mode: "single",
      x: 10,
      y: 20,
      createdById: "u1",
    });
    expect(payload.createdAt).toBe("__serverTimestamp__");
    expect(payload.quizId).toBeUndefined();
  });

  it("stamps quizIndex 0 as active when creating the first quiz question", async () => {
    addDoc.mockResolvedValueOnce({ id: "q0" });
    await pollService.createPoll("b1", { ...basePoll, quizId: "quiz1", quizIndex: 0 });
    const payload = addDoc.mock.calls[0][1];
    expect(payload).toMatchObject({ quizId: "quiz1", quizIndex: 0, active: true });
  });

  it("does not activate a later quiz question on create", async () => {
    addDoc.mockResolvedValueOnce({ id: "q1" });
    await pollService.createPoll("b1", { ...basePoll, quizId: "quiz1", quizIndex: 1 });
    const payload = addDoc.mock.calls[0][1];
    expect(payload).toMatchObject({ quizId: "quiz1", quizIndex: 1, active: false });
  });
});

describe("subscribeToBoardPolls", () => {
  it("subscribes and maps incoming docs, dropping ones with no question or options", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_q, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    const unsub = pollService.subscribeToBoardPolls("b1", onChange);
    captured(
      makeQuerySnap([
        ["p1", { question: "Q1", options: ["A", "B"], anonymous: false, mode: "single", createdById: "u1" }],
        ["bad1", { options: ["A", "B"] }], // dropped: no question
        ["bad2", { question: "Q2" }], // dropped: options not an array
      ])
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg).toHaveLength(1);
    expect(arg[0]).toMatchObject({ id: "p1", question: "Q1", options: ["A", "B"], mode: "single" });
    expect(typeof unsub).toBe("function");
  });

  it("defaults mode to 'single' and anonymous to TRUE (fail closed, matching isAnonymousPoll's rules default) when missing, never throwing", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_q, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    pollService.subscribeToBoardPolls("b1", onChange);
    captured(makeQuerySnap([["p1", { question: "Q", options: ["A", "B"] }]]));

    expect(onChange.mock.calls[0][0][0]).toMatchObject({ mode: "single", anonymous: true, x: 0, y: 0 });
  });

  it("also defaults anonymous to true for a non-boolean value, not just a missing field", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_q, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    pollService.subscribeToBoardPolls("b1", onChange);
    captured(makeQuerySnap([["p1", { question: "Q", options: ["A", "B"], anonymous: "no" }]]));

    expect(onChange.mock.calls[0][0][0].anonymous).toBe(true);
  });

  it("respects an explicit anonymous: false, never overriding a real value with the fail-closed default", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_q, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    pollService.subscribeToBoardPolls("b1", onChange);
    captured(makeQuerySnap([["p1", { question: "Q", options: ["A", "B"], anonymous: false }]]));

    expect(onChange.mock.calls[0][0][0].anonymous).toBe(false);
  });
});

describe("castVote", () => {
  it("writes the vote at the deterministic {uid} doc id, first vote and revote alike, stamping the caller-supplied anonymous flag", async () => {
    await pollService.castVote("b1", "p1", "u1", [0], false);

    expect((fs.doc as jest.Mock).mock.calls.at(-1)).toEqual([
      {},
      "boards",
      "b1",
      "polls",
      "p1",
      "votes",
      "u1",
    ]);
    expect(setDoc).toHaveBeenCalledTimes(1);
    const payload = setDoc.mock.calls[0][1];
    expect(payload).toMatchObject({ userId: "u1", optionIndices: [0], anonymous: false });
    expect(payload.createdAt).toBe("__serverTimestamp__");

    // Changing your mind is the SAME call shape — a second castVote at the
    // same (boardId, pollId, userId) addresses the identical doc id, which is
    // what firestore.rules' "allow update" for the voter's own doc is FOR
    // (see PollElement's type comment) — never a second row.
    await pollService.castVote("b1", "p1", "u1", [2], false);
    expect(setDoc).toHaveBeenCalledTimes(2);
    expect((fs.doc as jest.Mock).mock.calls.at(-1)).toEqual([
      {},
      "boards",
      "b1",
      "polls",
      "p1",
      "votes",
      "u1",
    ]);
    expect(setDoc.mock.calls[1][1]).toMatchObject({ optionIndices: [2], anonymous: false });
  });

  it("stamps anonymous: true when the caller passes it, for an anonymous poll's first vote", async () => {
    await pollService.castVote("b1", "pAnon", "u1", [0], true);
    expect(setDoc.mock.calls[0][1]).toMatchObject({ anonymous: true });
  });
});

describe("castSingleVote", () => {
  it("wraps a lone index in an array and delegates to castVote's write shape, including the anonymous stamp", async () => {
    await pollService.castSingleVote("b1", "p1", "u1", 1, false);
    expect(setDoc.mock.calls[0][1]).toMatchObject({ optionIndices: [1], anonymous: false });
  });
});

describe("toggleDotVote", () => {
  it("adds the option when the caller has no existing vote, stamping the caller-supplied anonymous flag", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));

    const result = await pollService.toggleDotVote("b1", "p1", "u1", 0, false);

    expect(result).toEqual([0]);
    expect(setDoc).toHaveBeenCalledTimes(1);
    expect(setDoc.mock.calls[0][1]).toMatchObject({ optionIndices: [0], anonymous: false });
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it("adds a second dot alongside an existing one", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", { userId: "u1", optionIndices: [0], anonymous: false }));

    const result = await pollService.toggleDotVote("b1", "p1", "u1", 1, false);

    expect(result).toEqual([0, 1]);
    expect(setDoc.mock.calls[0][1]).toMatchObject({ optionIndices: [0, 1] });
  });

  it("removes an option already selected", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", { userId: "u1", optionIndices: [0, 1], anonymous: false }));

    const result = await pollService.toggleDotVote("b1", "p1", "u1", 0, false);

    expect(result).toEqual([1]);
    expect(setDoc.mock.calls[0][1]).toMatchObject({ optionIndices: [1] });
  });

  it("deletes the vote doc entirely when removing the last dot, rather than writing an empty array", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", { userId: "u1", optionIndices: [0], anonymous: false }));

    const result = await pollService.toggleDotVote("b1", "p1", "u1", 0, false);

    expect(result).toEqual([]);
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(setDoc).not.toHaveBeenCalled();
  });

  it("is a no-op once the caller is already at MAX_DOT_VOTES and tries to add another", async () => {
    const atCap = Array.from({ length: pollService.MAX_DOT_VOTES }, (_, i) => i);
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", { userId: "u1", optionIndices: atCap, anonymous: false }));

    const result = await pollService.toggleDotVote("b1", "p1", "u1", pollService.MAX_DOT_VOTES, false);

    expect(result).toEqual(atCap);
    expect(setDoc).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  // Fix round 2 — firestore.rules pins a vote doc's `anonymous` immutable on
  // update, so this function must never let a caller-supplied value
  // override an EXISTING doc's original stamp (which could legitimately
  // differ from the poll's CURRENT value after a poll delete-then-recreate
  // — see firestore.rules' votes-read header). This is what makes that true
  // regardless of what the caller passes.
  it("preserves the EXISTING doc's own stamped anonymous value on update, ignoring a different caller-supplied value", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("u1", { userId: "u1", optionIndices: [0], anonymous: true })
    );

    // Caller passes `false` (e.g. what the poll's CURRENT doc now says,
    // post-recreate) — the existing doc's own `true` must win instead.
    await pollService.toggleDotVote("b1", "p1", "u1", 1, false);

    expect(setDoc.mock.calls[0][1]).toMatchObject({ anonymous: true });
  });
});

describe("subscribeToVotes", () => {
  it("subscribes and maps incoming vote docs", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_q, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    pollService.subscribeToVotes("b1", "p1", onChange);
    captured(
      makeQuerySnap([
        ["u1", { userId: "u1", optionIndices: [0] }],
        ["u2", { userId: "u2", optionIndices: [1, 2] }],
      ])
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg).toHaveLength(2);
    expect(arg[0]).toMatchObject({ id: "u1", userId: "u1", optionIndices: [0] });
  });

  it("drops non-numeric/negative entries from optionIndices rather than throwing", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_q, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    pollService.subscribeToVotes("b1", "p1", onChange);
    captured(makeQuerySnap([["u1", { userId: "u1", optionIndices: [0, "bogus", -1, 1.5, 2] }]]));

    expect(onChange.mock.calls[0][0][0].optionIndices).toEqual([0, 2]);
  });

  // Fix round 2 (CRITICAL) — REQUIRED, not an optimization: firestore.rules
  // now gates votes-read on each vote doc's OWN `anonymous` field, a
  // per-document condition Firestore can only allow for an unfiltered list
  // query if the query itself constrains that field — an unfiltered
  // `collection(...)` listen would be rejected outright by the real rules,
  // even against an ordinary non-anonymous poll. See firestore.rules'
  // votes-read header for the full reasoning.
  it("filters where('anonymous', '==', false) — a bare unfiltered collection listen would be rejected by the real rules", () => {
    onSnapshot.mockReturnValueOnce(() => {});
    pollService.subscribeToVotes("b1", "p1", jest.fn());

    expect(fs.where).toHaveBeenCalledWith("anonymous", "==", false);
    const queryArgs = (fs.query as jest.Mock).mock.calls.at(-1);
    expect(queryArgs).toContainEqual(expect.objectContaining({ field: "anonymous", op: "==", value: false }));
  });
});

describe("subscribeToTally", () => {
  it("maps an existing tally doc", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_ref, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    pollService.subscribeToTally("b1", "p1", onChange);
    captured(makeDocSnap("summary", { counts: { "0": 3, "1": 1 }, totalVotes: 4 }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { "0": 3, "1": 1 }, totalVotes: 4 })
    );
  });

  it("reports null when the trigger has not written a tally yet, rather than throwing", () => {
    let captured: any;
    onSnapshot.mockImplementationOnce((_ref, cb) => {
      captured = cb;
      return () => {};
    });
    const onChange = jest.fn();

    pollService.subscribeToTally("b1", "p1", onChange);
    captured(makeDocSnap("summary", null));

    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe("countVotes", () => {
  it("counts each vote's indices into the matching option bucket", () => {
    const votes = [
      { id: "u1", userId: "u1", optionIndices: [0], createdAt: new Date() },
      { id: "u2", userId: "u2", optionIndices: [0, 1], createdAt: new Date() },
      { id: "u3", userId: "u3", optionIndices: [2], createdAt: new Date() },
    ];
    expect(pollService.countVotes(votes, 3)).toEqual({ counts: [2, 1, 1], totalVotes: 3 });
  });

  it("ignores an out-of-range index rather than throwing", () => {
    const votes = [{ id: "u1", userId: "u1", optionIndices: [99], createdAt: new Date() }];
    expect(pollService.countVotes(votes, 2)).toEqual({ counts: [0, 0], totalVotes: 1 });
  });
});

describe("deletePoll", () => {
  // Fix round 3 — deletePoll used to ALSO batch-delete the poll's votes/
  // tally docs itself, but `tally`'s firestore.rules is `allow write: if
  // false` unconditionally, and a Firestore batched write is atomic, so
  // that batch failed outright whenever the poll being deleted had a tally
  // doc (i.e. every anonymous poll that had been voted on) — see this
  // function's own header. Cleanup of votes/tally is entirely server-side
  // now (functions/src/triggers/pollTally.ts's onPollDeleted); this
  // function deletes ONLY the poll doc.
  it("deletes only the poll doc — no votes/tally reads or batches at all", async () => {
    await pollService.deletePoll("b1", "p1");

    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect((fs.doc as jest.Mock).mock.calls.at(-1)).toEqual([{}, "boards", "b1", "polls", "p1"]);
    expect(getDocs).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

describe("clearBoardPolls", () => {
  it("deletes every poll doc on the board via deletePoll", async () => {
    // deletePoll no longer reads anything of its own (fix round 3) — this
    // one getDocs call enumerates the polls collection itself.
    getDocs.mockResolvedValueOnce(makeQuerySnap([["p1", {}], ["p2", {}]]));

    await pollService.clearBoardPolls("b1");

    expect(getDocs).toHaveBeenCalledTimes(1);
    expect(deleteDoc).toHaveBeenCalledTimes(2);
  });

  it("is a no-op on a board with no polls", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    await pollService.clearBoardPolls("b1");
    expect(deleteDoc).not.toHaveBeenCalled();
  });
});

describe("advanceQuiz", () => {
  it("activates quizIndex 0 when nothing is active yet", async () => {
    const batch = { delete: jest.fn(), set: jest.fn(), update: jest.fn(), commit: jest.fn(async () => undefined) };
    writeBatch.mockReturnValueOnce(batch);
    const polls = [
      makePollElement({ id: "q0", quizId: "quiz1", quizIndex: 0 }),
      makePollElement({ id: "q1", quizId: "quiz1", quizIndex: 1 }),
    ];

    await pollService.advanceQuiz("b1", polls);

    expect(batch.update).toHaveBeenCalledTimes(1);
    expect(batch.update.mock.calls[0][0]).toMatchObject({ path: ["boards", "b1", "polls", "q0"] });
    expect(batch.update.mock.calls[0][1]).toEqual({ active: true });
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("deactivates the current question and activates the next one in one batch", async () => {
    const batch = { delete: jest.fn(), set: jest.fn(), update: jest.fn(), commit: jest.fn(async () => undefined) };
    writeBatch.mockReturnValueOnce(batch);
    const polls = [
      makePollElement({ id: "q0", quizId: "quiz1", quizIndex: 0, active: true }),
      makePollElement({ id: "q1", quizId: "quiz1", quizIndex: 1 }),
      makePollElement({ id: "q2", quizId: "quiz1", quizIndex: 2 }),
    ];

    await pollService.advanceQuiz("b1", polls);

    expect(batch.update).toHaveBeenCalledTimes(2);
    expect(batch.update.mock.calls[0][0]).toMatchObject({ path: ["boards", "b1", "polls", "q0"] });
    expect(batch.update.mock.calls[0][1]).toEqual({ active: false });
    expect(batch.update.mock.calls[1][0]).toMatchObject({ path: ["boards", "b1", "polls", "q1"] });
    expect(batch.update.mock.calls[1][1]).toEqual({ active: true });
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("is a no-op past the last question", async () => {
    const polls = [
      makePollElement({ id: "q0", quizId: "quiz1", quizIndex: 0 }),
      makePollElement({ id: "q1", quizId: "quiz1", quizIndex: 1, active: true }),
    ];

    await pollService.advanceQuiz("b1", polls);

    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("is a no-op given an empty quiz", async () => {
    await pollService.advanceQuiz("b1", []);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("sorts by quizIndex regardless of input order — advances to q1, not q2", async () => {
    const batch = { delete: jest.fn(), set: jest.fn(), update: jest.fn(), commit: jest.fn(async () => undefined) };
    writeBatch.mockReturnValueOnce(batch);
    const polls = [
      makePollElement({ id: "q2", quizId: "quiz1", quizIndex: 2 }),
      makePollElement({ id: "q0", quizId: "quiz1", quizIndex: 0, active: true }),
      makePollElement({ id: "q1", quizId: "quiz1", quizIndex: 1 }),
    ];

    await pollService.advanceQuiz("b1", polls);

    expect(batch.update).toHaveBeenCalledTimes(2);
    // Deactivates the CURRENT question (q0, by quizIndex, not array position)...
    expect(batch.update.mock.calls[0][0]).toMatchObject({ path: ["boards", "b1", "polls", "q0"] });
    expect(batch.update.mock.calls[0][1]).toEqual({ active: false });
    // ...and activates the NEXT-BY-INDEX question (q1), never q2 even though
    // q2 appeared first in the input array.
    expect(batch.update.mock.calls[1][0]).toMatchObject({ path: ["boards", "b1", "polls", "q1"] });
    expect(batch.update.mock.calls[1][1]).toEqual({ active: true });
  });
});

// Fix round 1, item 3 — MAX_DOT_VOTES is duplicated between this module (the
// TS source of truth) and firestore.rules' `isValidVotePayload`
// (`idx.size() <= 3`, a plain literal — rules cannot import TypeScript).
// Mirrors src/lib/__tests__/planLimits.test.ts's own cross-package mirror
// (which reads functions/src/billing/limits.ts as TEXT rather than
// importing it, for the identical reason: the two files are physically
// separate, and Jest can't type-check across the app/functions package
// boundary either) and functions/src/__tests__/limits.test.ts's "firestore
// .rules seat-cap mirror" — same technique, this repo's third instance of
// it. A guard fails the test if the parse matches nothing, so a drift test
// that silently stops matching doesn't pass forever.
describe("firestore.rules dot-vote cap mirror", () => {
  it("keeps isValidVotePayload's dots-mode bound in firestore.rules in sync with MAX_DOT_VOTES", () => {
    const rulesPath = nodePath.join(__dirname, "../../../firestore.rules");
    const rules = nodeFs.readFileSync(rulesPath, "utf8");

    const fnStart = rules.indexOf("function isValidVotePayload(");
    expect(fnStart).toBeGreaterThanOrEqual(0); // guard: the helper must still exist
    const fnEnd = rules.indexOf("\n    }", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart); // guard: we actually captured a body
    const body = rules.slice(fnStart, fnEnd);

    const match = body.match(/idx\.size\(\)\s*<=\s*(\d+)/);
    expect(match).not.toBeNull(); // guard: an empty/failed parse must not pass vacuously
    expect(Number(match![1])).toBe(pollService.MAX_DOT_VOTES);
  });
});
