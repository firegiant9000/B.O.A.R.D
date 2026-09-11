import {
  computeTally,
  handlePollVoteWrite,
  makeRecomputeTally,
  onPollVoteWritten,
  type PollTallyDeps,
} from "../triggers/pollTally";

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

  // Fix round 1, item 5's defense-in-depth counterpart — firestore.rules now
  // rejects a NEW vote doc with duplicate indices, but this function reads
  // whatever is actually stored (which could predate that rule, or arrive
  // via some other trusted path) and must not let one voter's repeated
  // index inflate a single option's count.
  it("counts a single vote's own repeated index only once, not once per repetition", () => {
    const tally = computeTally([{ optionIndices: [0, 0, 0] }]);
    expect(tally).toEqual({ counts: { "0": 1 }, totalVotes: 1 });
  });
});

describe("handlePollVoteWrite", () => {
  function makeDeps(overrides: Partial<PollTallyDeps> = {}): PollTallyDeps {
    return {
      getPollAnonymous: jest.fn(async () => true),
      recomputeTally: jest.fn(async () => undefined),
      ...overrides,
    };
  }

  it("recomputes the tally for an anonymous poll", async () => {
    const deps = makeDeps();
    await handlePollVoteWrite("b1", "p1", deps);
    expect(deps.recomputeTally).toHaveBeenCalledWith("b1", "p1");
  });

  it("skips entirely for a non-anonymous poll — no recompute at all", async () => {
    const deps = makeDeps({ getPollAnonymous: jest.fn(async () => false) });
    await handlePollVoteWrite("b1", "p1", deps);
    expect(deps.recomputeTally).not.toHaveBeenCalled();
  });

  it("skips when the poll doc no longer exists (deleted poll, orphaned vote write)", async () => {
    const deps = makeDeps({ getPollAnonymous: jest.fn(async () => null) });
    await handlePollVoteWrite("b1", "p1", deps);
    expect(deps.recomputeTally).not.toHaveBeenCalled();
  });

  it("recomputes on a vote DELETE too (a removed vote must not stay counted forever) — proven by the event-type pin below, not by this mocked call alone", async () => {
    const deps = makeDeps();
    await handlePollVoteWrite("b1", "p1", deps);
    expect(deps.recomputeTally).toHaveBeenCalledTimes(1);
  });
});

// Fix round 1, item 2 — the real transactional core. `handlePollVoteWrite`'s
// own tests above mock `recomputeTally` away entirely, so they cannot prove
// it actually uses a transaction; these do, against a fake Firestore-like
// `db`, mirroring callable/createSession.test.ts's `fakeTransactionalDb`
// pattern for `makeRunCreate`.
describe("makeRecomputeTally (the real transactional core)", () => {
  function fakeTransactionalDb(voteDocs: Array<Record<string, unknown>>) {
    const tx = {
      get: jest.fn(async (_query: unknown) => ({
        docs: voteDocs.map((data) => ({ data: () => data })),
      })),
      set: jest.fn((_ref: { path: string }, _data: unknown) => undefined),
    };
    const db = {
      doc: (p: string) => ({ path: p }),
      collection: (p: string) => ({ path: p }),
      runTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { db, tx };
  }

  it("reads the votes collection and writes the tally INSIDE one transaction", async () => {
    const { db, tx } = fakeTransactionalDb([{ optionIndices: [0] }, { optionIndices: [0, 1] }]);
    const recomputeTally = makeRecomputeTally(db);

    await recomputeTally("b1", "p1");

    expect(db.runTransaction).toHaveBeenCalledTimes(1);
    expect(tx.get).toHaveBeenCalledWith({ path: "boards/b1/polls/p1/votes" });
    expect(tx.set).toHaveBeenCalledWith(
      { path: "boards/b1/polls/p1/tally/summary" },
      { counts: { "0": 2, "1": 1 }, totalVotes: 2 }
    );
  });

  it("writes no updatedAt/timestamp field — nothing reads it, and it would be a needless side channel on an anonymity feature (fix round 1, item 10)", async () => {
    const { db, tx } = fakeTransactionalDb([{ optionIndices: [0] }]);
    await makeRecomputeTally(db)("b1", "p1");

    const written = tx.set.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(["counts", "totalVotes"]);
  });

  it("commits ZERO votes as an empty tally (the un-vote / deleted-last-vote case)", async () => {
    const { db, tx } = fakeTransactionalDb([]);
    await makeRecomputeTally(db)("b1", "p1");

    expect(tx.set).toHaveBeenCalledWith(expect.anything(), { counts: {}, totalVotes: 0 });
  });
});

// Fix round 1, item 7 — nothing previously pinned WHICH event type the
// trigger binds to. `handlePollVoteWrite`'s "re-tallies on a vote DELETE
// too" test injects deps directly and calls the handler function by hand, so
// it passes identically whether the real binding below used
// `onDocumentWritten` (create+update+delete) or `onDocumentCreated`
// (create-only) — swapping the import would leave every one of those tests
// green while silently breaking un-voting in production. This asserts the
// actual registered Cloud Event type instead.
describe("onPollVoteWritten — event type", () => {
  it("is bound to the 'written' event (create, update AND delete), not 'created' only", () => {
    const endpoint = (onPollVoteWritten as unknown as {
      __endpoint: { eventTrigger: { eventType: string } };
    }).__endpoint;
    expect(endpoint.eventTrigger.eventType).toBe("google.cloud.firestore.document.v1.written");
  });
});
