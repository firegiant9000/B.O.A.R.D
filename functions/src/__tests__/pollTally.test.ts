import { computeTally, handlePollVoteWrite, type PollTallyDeps } from "../triggers/pollTally";

describe("computeTally", () => {
  it("counts each vote's optionIndices into the matching bucket, keyed by index-as-string", () => {
    const tally = computeTally([
      { optionIndices: [0] },
      { optionIndices: [0, 1] },
      { optionIndices: [2] },
    ]);
    expect(tally).toEqual({ counts: { "0": 2, "1": 1, "2": 1 }, totalVotes: 3 });
  });

  it("counts VOTERS (doc count) for totalVotes, not the sum of dot placements", () => {
    // A dots-mode poll: 2 voters, one of whom placed 2 dots — totalVotes must
    // stay 2 ("how many people voted"), even though counts sums to 3.
    const tally = computeTally([{ optionIndices: [0, 1] }, { optionIndices: [1] }]);
    expect(tally.totalVotes).toBe(2);
    expect(tally.counts).toEqual({ "0": 1, "1": 2 });
  });

  it("returns an empty tally for zero votes, never throwing", () => {
    expect(computeTally([])).toEqual({ counts: {}, totalVotes: 0 });
  });

  it("tolerates a missing/malformed optionIndices — contributes to totalVotes but not counts", () => {
    const tally = computeTally([{}, { optionIndices: "not-an-array" as any }, { optionIndices: [0] }]);
    expect(tally).toEqual({ counts: { "0": 1 }, totalVotes: 3 });
  });

  it("drops a non-integer, negative, or non-numeric entry within optionIndices rather than throwing", () => {
    const tally = computeTally([{ optionIndices: [0, -1, 1.5, "x" as any, 2] }]);
    expect(tally).toEqual({ counts: { "0": 1, "2": 1 }, totalVotes: 1 });
  });
});

describe("handlePollVoteWrite", () => {
  function makeDeps(overrides: Partial<PollTallyDeps> = {}): PollTallyDeps {
    return {
      getPollAnonymous: jest.fn(async () => true),
      listVotes: jest.fn(async () => [{ optionIndices: [0] }]),
      writeTally: jest.fn(async () => undefined),
      ...overrides,
    };
  }

  it("re-tallies and writes for an anonymous poll", async () => {
    const deps = makeDeps();
    await handlePollVoteWrite("b1", "p1", deps);
    expect(deps.listVotes).toHaveBeenCalledWith("b1", "p1");
    expect(deps.writeTally).toHaveBeenCalledWith("b1", "p1", { counts: { "0": 1 }, totalVotes: 1 });
  });

  it("skips entirely for a non-anonymous poll — no read of votes, no write", async () => {
    const deps = makeDeps({ getPollAnonymous: jest.fn(async () => false) });
    await handlePollVoteWrite("b1", "p1", deps);
    expect(deps.listVotes).not.toHaveBeenCalled();
    expect(deps.writeTally).not.toHaveBeenCalled();
  });

  it("skips when the poll doc no longer exists (deleted poll, orphaned vote write)", async () => {
    const deps = makeDeps({ getPollAnonymous: jest.fn(async () => null) });
    await handlePollVoteWrite("b1", "p1", deps);
    expect(deps.listVotes).not.toHaveBeenCalled();
    expect(deps.writeTally).not.toHaveBeenCalled();
  });

  it("re-tallies on a vote DELETE too (a removed vote must not stay counted forever)", async () => {
    // Simulates the trigger firing after the last vote doc was deleted: the
    // poll is still anonymous, but listVotes now returns nothing.
    const deps = makeDeps({ listVotes: jest.fn(async () => []) });
    await handlePollVoteWrite("b1", "p1", deps);
    expect(deps.writeTally).toHaveBeenCalledWith("b1", "p1", { counts: {}, totalVotes: 0 });
  });
});
