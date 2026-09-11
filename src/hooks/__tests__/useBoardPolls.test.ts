// pollService is PARTIALLY mocked below (jest.requireActual keeps pure
// helpers like countVotes real) — its own real implementation imports
// firebase/firestore, so that must be mocked too, exactly like
// pollService.test.ts, or requireActual drags in the real (untransformable)
// Firestore ESM build.
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));

jest.mock("../../services/pollService", () => ({
  ...jest.requireActual("../../services/pollService"),
  subscribeToBoardPolls: jest.fn(),
  subscribeToVotes: jest.fn(),
  subscribeToTally: jest.fn(),
  createPoll: jest.fn(),
  castSingleVote: jest.fn(),
  toggleDotVote: jest.fn(),
  deletePoll: jest.fn(),
  advanceQuiz: jest.fn(),
  clearBoardPolls: jest.fn(),
}));

import { renderHook, act } from "@testing-library/react-native";
import { useBoardPolls } from "../useBoardPolls";
import * as pollService from "../../services/pollService";
import { PollElement, PollVote } from "../../types";

const subscribeToBoardPolls = pollService.subscribeToBoardPolls as jest.Mock;
const subscribeToVotes = pollService.subscribeToVotes as jest.Mock;
const subscribeToTally = pollService.subscribeToTally as jest.Mock;
const createPoll = pollService.createPoll as jest.Mock;
const castSingleVote = pollService.castSingleVote as jest.Mock;
const toggleDotVote = pollService.toggleDotVote as jest.Mock;
const deletePollMock = pollService.deletePoll as jest.Mock;
const advanceQuizMock = pollService.advanceQuiz as jest.Mock;
const clearBoardPollsMock = pollService.clearBoardPolls as jest.Mock;

const USER = { uid: "u1" };

function poll(overrides: Partial<PollElement> = {}): PollElement {
  return {
    id: "p1",
    schemaVersion: 1,
    boardId: "b1",
    question: "Q?",
    options: ["A", "B", "C"],
    anonymous: false,
    mode: "single",
    x: 0,
    y: 0,
    createdById: "someone",
    createdAt: new Date(),
    ...overrides,
  };
}

function vote(overrides: Partial<PollVote> = {}): PollVote {
  return { id: overrides.userId ?? "u1", userId: "u1", optionIndices: [0], createdAt: new Date(), ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  subscribeToBoardPolls.mockReturnValue(jest.fn());
  subscribeToVotes.mockReturnValue(jest.fn());
  subscribeToTally.mockReturnValue(jest.fn());
});

function renderPolls(user: { uid: string } | null = USER, onError = jest.fn()) {
  return renderHook(() => useBoardPolls("b1", { user, onError }));
}

describe("useBoardPolls — subscription", () => {
  it("subscribes to the board's polls on mount", () => {
    renderPolls();
    expect(subscribeToBoardPolls).toHaveBeenCalledWith("b1", expect.any(Function));
  });

  it("exposes incoming polls", () => {
    let cb: (p: PollElement[]) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      cb = onChange;
      return jest.fn();
    });
    const { result } = renderPolls();
    const seeded = poll();
    act(() => cb([seeded]));
    expect(result.current.polls).toEqual([seeded]);
  });

  it("subscribes to VOTES for a non-anonymous poll and to the TALLY for an anonymous one", () => {
    let pollsCb: (p: PollElement[]) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      pollsCb = onChange;
      return jest.fn();
    });
    renderPolls();
    act(() => pollsCb([poll({ id: "open", anonymous: false }), poll({ id: "secret", anonymous: true })]));

    expect(subscribeToVotes).toHaveBeenCalledWith("b1", "open", expect.any(Function));
    expect(subscribeToTally).toHaveBeenCalledWith("b1", "secret", expect.any(Function));
    expect(subscribeToVotes).not.toHaveBeenCalledWith("b1", "secret", expect.any(Function));
    expect(subscribeToTally).not.toHaveBeenCalledWith("b1", "open", expect.any(Function));
  });
});

describe("useBoardPolls — resultsFor", () => {
  it("counts a non-anonymous poll's LIVE votes client-side", () => {
    let pollsCb: (p: PollElement[]) => void = () => {};
    let votesCb: (v: PollVote[]) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      pollsCb = onChange;
      return jest.fn();
    });
    subscribeToVotes.mockImplementationOnce((_bid, _pid, onChange) => {
      votesCb = onChange;
      return jest.fn();
    });
    const { result } = renderPolls();
    act(() => pollsCb([poll({ id: "p1", options: ["A", "B"] })]));
    act(() => votesCb([vote({ userId: "u1", optionIndices: [0] }), vote({ userId: "u2", optionIndices: [1] })]));

    expect(result.current.resultsFor("p1")).toEqual({ counts: [1, 1], totalVotes: 2, fromTally: false });
  });

  it("returns null for an anonymous poll before the trigger has written a tally", () => {
    let pollsCb: (p: PollElement[]) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      pollsCb = onChange;
      return jest.fn();
    });
    const { result } = renderPolls();
    act(() => pollsCb([poll({ id: "p1", anonymous: true })]));

    expect(result.current.resultsFor("p1")).toBeNull();
  });

  it("reads an anonymous poll's results from the server-maintained tally once it arrives", () => {
    let pollsCb: (p: PollElement[]) => void = () => {};
    let tallyCb: (t: any) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      pollsCb = onChange;
      return jest.fn();
    });
    subscribeToTally.mockImplementationOnce((_bid, _pid, onChange) => {
      tallyCb = onChange;
      return jest.fn();
    });
    const { result } = renderPolls();
    act(() => pollsCb([poll({ id: "p1", anonymous: true, options: ["A", "B", "C"] })]));
    act(() => tallyCb({ counts: { "0": 2, "2": 1 }, totalVotes: 3, updatedAt: new Date() }));

    expect(result.current.resultsFor("p1")).toEqual({ counts: [2, 0, 1], totalVotes: 3, fromTally: true });
  });

  it("returns null for an unknown poll id", () => {
    const { result } = renderPolls();
    expect(result.current.resultsFor("nope")).toBeNull();
  });
});

describe("useBoardPolls — myVoteFor", () => {
  it("reads the caller's own selection live off the votes stream for a non-anonymous poll", () => {
    let pollsCb: (p: PollElement[]) => void = () => {};
    let votesCb: (v: PollVote[]) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      pollsCb = onChange;
      return jest.fn();
    });
    subscribeToVotes.mockImplementationOnce((_bid, _pid, onChange) => {
      votesCb = onChange;
      return jest.fn();
    });
    const { result } = renderPolls();
    act(() => pollsCb([poll({ id: "p1" })]));
    act(() => votesCb([vote({ userId: "u1", optionIndices: [1] }), vote({ userId: "other", optionIndices: [2] })]));

    expect(result.current.myVoteFor("p1")).toEqual([1]);
  });

  it("for an anonymous poll, tracks the caller's vote ONLY locally (never from a server read)", async () => {
    let pollsCb: (p: PollElement[]) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      pollsCb = onChange;
      return jest.fn();
    });
    const { result } = renderPolls();
    act(() => pollsCb([poll({ id: "p1", anonymous: true })]));

    expect(result.current.myVoteFor("p1")).toEqual([]);

    await act(async () => {
      await result.current.vote("p1", 2);
    });
    expect(result.current.myVoteFor("p1")).toEqual([2]);
  });
});

describe("useBoardPolls — create", () => {
  it("stamps createdById from the current user and delegates to pollService.createPoll", async () => {
    createPoll.mockResolvedValueOnce("newId");
    const { result } = renderPolls();

    let id: string | undefined;
    await act(async () => {
      id = await result.current.create({
        question: "Q?",
        options: ["A", "B"],
        anonymous: false,
        mode: "single",
        x: 1,
        y: 2,
      });
    });

    expect(id).toBe("newId");
    expect(createPoll).toHaveBeenCalledWith("b1", {
      question: "Q?",
      options: ["A", "B"],
      anonymous: false,
      mode: "single",
      x: 1,
      y: 2,
      createdById: "u1",
    });
  });

  it("surfaces a rejection through onError instead of throwing", async () => {
    createPoll.mockRejectedValueOnce(new Error("needs between 2 and 6 options"));
    const onError = jest.fn();
    const { result } = renderPolls(USER, onError);

    let id: string | undefined = "unset";
    await act(async () => {
      id = await result.current.create({
        question: "Q?",
        options: ["A"],
        anonymous: false,
        mode: "single",
        x: 0,
        y: 0,
      });
    });

    expect(id).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/2 and 6 options/));
  });

  it("does nothing when there is no signed-in user", async () => {
    const { result } = renderPolls(null);
    await act(async () => {
      await result.current.create({ question: "Q?", options: ["A", "B"], anonymous: false, mode: "single", x: 0, y: 0 });
    });
    expect(createPoll).not.toHaveBeenCalled();
  });
});

describe("useBoardPolls — vote / toggleDot / deletePoll", () => {
  it("vote() delegates to castSingleVote with the current user's uid and a fail-closed anonymous=true for an unknown poll", async () => {
    const { result } = renderPolls();
    await act(async () => {
      await result.current.vote("p1", 1);
    });
    // "p1" isn't in this hook's live poll list (no subscribeToBoardPolls
    // callback fired) — fix round 2's fail-closed default applies.
    expect(castSingleVote).toHaveBeenCalledWith("b1", "p1", "u1", 1, true);
  });

  it("toggleDot() delegates to toggleDotVote and records the returned selection locally", async () => {
    toggleDotVote.mockResolvedValueOnce([0, 2]);
    const { result } = renderPolls();
    await act(async () => {
      await result.current.toggleDot("p1", 2);
    });
    expect(toggleDotVote).toHaveBeenCalledWith("b1", "p1", "u1", 2, true);
    expect(result.current.myVoteFor("p1")).toEqual([0, 2]);
  });

  // Fix round 2 — the poll's OWN current anonymous value must reach the
  // service call, not just the fail-closed default; this is what a
  // delete-then-recreated poll's anonymity guarantee ultimately rests on
  // (see pollService.castVote/toggleDotVote and firestore.rules' votes-read
  // header).
  it("vote() looks up the poll's OWN anonymous flag and passes it through, for both true and false", async () => {
    let pollsCb: (p: PollElement[]) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      pollsCb = onChange;
      return jest.fn();
    });
    const { result } = renderPolls();
    act(() =>
      pollsCb([
        poll({ id: "open", anonymous: false }),
        poll({ id: "secret", anonymous: true }),
      ])
    );

    await act(async () => {
      await result.current.vote("open", 0);
    });
    expect(castSingleVote).toHaveBeenCalledWith("b1", "open", "u1", 0, false);

    await act(async () => {
      await result.current.vote("secret", 0);
    });
    expect(castSingleVote).toHaveBeenCalledWith("b1", "secret", "u1", 0, true);
  });

  it("toggleDot() looks up the poll's OWN anonymous flag too", async () => {
    let pollsCb: (p: PollElement[]) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      pollsCb = onChange;
      return jest.fn();
    });
    const { result } = renderPolls();
    act(() => pollsCb([poll({ id: "open", anonymous: false, mode: "dots" })]));

    await act(async () => {
      await result.current.toggleDot("open", 0);
    });
    expect(toggleDotVote).toHaveBeenCalledWith("b1", "open", "u1", 0, false);
  });

  it("deletePoll() delegates to pollService.deletePoll", async () => {
    const { result } = renderPolls();
    await act(async () => {
      await result.current.deletePoll("p1");
    });
    expect(deletePollMock).toHaveBeenCalledWith("b1", "p1");
  });
});

describe("useBoardPolls — advanceQuiz", () => {
  it("filters the live poll list down to the named quiz before delegating", async () => {
    let pollsCb: (p: PollElement[]) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      pollsCb = onChange;
      return jest.fn();
    });
    const { result } = renderPolls();
    const q0 = poll({ id: "q0", quizId: "quiz1", quizIndex: 0 });
    const q1 = poll({ id: "q1", quizId: "quiz1", quizIndex: 1 });
    const standalone = poll({ id: "standalone" });
    act(() => pollsCb([q0, q1, standalone]));

    await act(async () => {
      await result.current.advanceQuiz("quiz1");
    });

    expect(advanceQuizMock).toHaveBeenCalledWith("b1", [q0, q1]);
  });
});

describe("useBoardPolls — clearBoardPolls / resetLocal", () => {
  it("clearBoardPolls() delegates to pollService.clearBoardPolls", async () => {
    const { result } = renderPolls();
    await act(async () => {
      await result.current.clearBoardPolls();
    });
    expect(clearBoardPollsMock).toHaveBeenCalledWith("b1");
  });

  it("resetLocal() drops the local poll list", () => {
    let cb: (p: PollElement[]) => void = () => {};
    subscribeToBoardPolls.mockImplementationOnce((_id, onChange) => {
      cb = onChange;
      return jest.fn();
    });
    const { result } = renderPolls();
    act(() => cb([poll()]));
    expect(result.current.polls).toHaveLength(1);

    act(() => result.current.resetLocal());
    expect(result.current.polls).toEqual([]);
  });
});
