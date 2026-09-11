import { useCallback, useEffect, useMemo, useState } from "react";
import * as pollService from "../services/pollService";
import { captureException } from "../lib/errorReporting";
import { PollElement, PollTally, PollVote } from "../types";

/**
 * Board polls, quiz sequencing and dot voting (Month 6). Mirrors
 * useBoardReactions.ts's shape: one hook owns the realtime poll set and the
 * write path, the screen supplies the viewer identity, and the canvas
 * position join (unlike reactions, a poll needs NO join — it renders at its
 * own persisted x/y, like a shape or sticky note) stays trivial enough that
 * the caller (BoardCanvas) just reads `poll.x`/`poll.y` directly.
 *
 * Unlike reactions, this hook ALSO manages a second layer of subscriptions —
 * one votes-or-tally listener per live poll, added/removed as the board's
 * poll SET changes (never on a vote-count change alone) — because a poll's
 * results live in a different place depending on its `anonymous` flag (see
 * PollElement/PollTally's type comments, src/types/index.ts):
 *   - non-anonymous: `pollService.subscribeToVotes` (member-readable, member
 *     counts client-side).
 *   - anonymous: `pollService.subscribeToTally` (the Admin-SDK-only,
 *     trigger-maintained, eventually-consistent count — votes themselves
 *     stay unreadable to every member, including the voter).
 */

export interface BoardPollsUser {
  uid: string;
}

export interface BoardPollsOptions {
  user: BoardPollsUser | null;
  /** Surface a user-facing failure in the screen's error banner. */
  onError: (message: string) => void;
}

export interface PollResults {
  /** Vote count per option, in `poll.options` order. */
  counts: number[];
  totalVotes: number;
  /** True when this came from the eventually-consistent trigger-maintained
   *  tally (an anonymous poll) rather than a live client-side count of the
   *  votes subcollection — a UI should hedge language accordingly ("results
   *  may take a moment to update") rather than implying live results. */
  fromTally: boolean;
}

export interface BoardPolls {
  polls: PollElement[];
  /** `null` before any result is available yet — an anonymous poll with no
   *  tally written (no votes cast, or the trigger hasn't run), or an unknown
   *  poll id. Never throws. */
  resultsFor: (pollId: string) => PollResults | null;
  /**
   * The CALLER's own current selection for a poll — `[]` if they haven't
   * voted (or the hook doesn't know). For a NON-anonymous poll this is read
   * live off the votes subcollection, so it survives a refresh. For an
   * ANONYMOUS poll it is tracked ONLY from this session's own successful
   * vote/toggle calls: firestore.rules denies even the voter reading their
   * own anonymous vote back (see that rule's comment in firestore.rules), so
   * this deliberately does NOT survive a refresh for an anonymous poll —
   * that is the honest cost of "anonymous to every user", not a bug.
   */
  myVoteFor: (pollId: string) => number[];
  /** Creates a poll; `createdById` is stamped from the signed-in user, never
   *  accepted from the caller. Returns the new poll's id, or `undefined` if
   *  creation failed (surfaced via `onError`) or no user is signed in. */
  create: (input: Omit<pollService.NewPoll, "createdById">) => Promise<string | undefined>;
  /** Casts (or changes) a single-choice vote. */
  vote: (pollId: string, optionIndex: number) => Promise<void>;
  /** Adds/removes one dot in a dots-mode poll. */
  toggleDot: (pollId: string, optionIndex: number) => Promise<void>;
  deletePoll: (pollId: string) => Promise<void>;
  /** Advances the quiz sharing `quizId` to its next question. Filters the
   *  live poll list down to that quiz's own questions itself (by `quizId`),
   *  so the caller never has to hold that filtered list. */
  advanceQuiz: (quizId: string) => Promise<void>;
  /** Deletes every poll on the board (composed with the element/comment/
   *  reaction clear — app/board/[id].tsx's `handleClear`). */
  clearBoardPolls: () => Promise<void>;
  /** Drops the local poll/vote/tally state (after a successful clear) —
   *  mirrors useBoardReactions.resetLocal. */
  resetLocal: () => void;
}

export function useBoardPolls(boardId: string, opts: BoardPollsOptions): BoardPolls {
  const { user, onError } = opts;
  const [polls, setPolls] = useState<PollElement[]>([]);
  const [votesByPoll, setVotesByPoll] = useState<Record<string, PollVote[]>>({});
  const [tallyByPoll, setTallyByPoll] = useState<Record<string, PollTally | null>>({});
  // Anonymous-poll-only fallback (see `myVoteFor`'s doc comment) — this
  // session's own casts, keyed by pollId. Never read for a non-anonymous
  // poll, where the live votes subcollection is the source of truth instead.
  const [myLocalVotes, setMyLocalVotes] = useState<Record<string, number[]>>({});

  useEffect(() => {
    if (!boardId) return;
    return pollService.subscribeToBoardPolls(boardId, setPolls);
  }, [boardId]);

  // Re-subscribe votes/tally only when the board's poll SET (ids + anonymity)
  // changes — a vote-count change alone must never tear down and reattach
  // these listeners, or every cast vote would cause a visible flicker.
  const pollKey = polls.map((p) => `${p.id}:${p.anonymous ? 1 : 0}`).join(",");
  useEffect(() => {
    if (!boardId) return;
    const unsubs = polls.map((p) =>
      p.anonymous
        ? pollService.subscribeToTally(boardId, p.id, (tally) =>
            setTallyByPoll((prev) => ({ ...prev, [p.id]: tally }))
          )
        : pollService.subscribeToVotes(boardId, p.id, (votes) =>
            setVotesByPoll((prev) => ({ ...prev, [p.id]: votes }))
          )
    );
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, pollKey]);

  const pollsById = useMemo(() => {
    const m = new Map<string, PollElement>();
    polls.forEach((p) => m.set(p.id, p));
    return m;
  }, [polls]);

  const resultsFor = useCallback(
    (pollId: string): PollResults | null => {
      const poll = pollsById.get(pollId);
      if (!poll) return null;
      if (poll.anonymous) {
        const tally = tallyByPoll[pollId];
        if (!tally) return null;
        const counts = poll.options.map((_, i) => tally.counts[String(i)] ?? 0);
        return { counts, totalVotes: tally.totalVotes, fromTally: true };
      }
      const votes = votesByPoll[pollId] ?? [];
      const { counts, totalVotes } = pollService.countVotes(votes, poll.options.length);
      return { counts, totalVotes, fromTally: false };
    },
    [pollsById, tallyByPoll, votesByPoll]
  );

  const myVoteFor = useCallback(
    (pollId: string): number[] => {
      const poll = pollsById.get(pollId);
      if (poll && !poll.anonymous && user) {
        const mine = (votesByPoll[pollId] ?? []).find((v) => v.userId === user.uid);
        if (mine) return mine.optionIndices;
      }
      return myLocalVotes[pollId] ?? [];
    },
    [pollsById, votesByPoll, user, myLocalVotes]
  );

  const create = useCallback(
    async (input: Omit<pollService.NewPoll, "createdById">): Promise<string | undefined> => {
      if (!user) return undefined;
      try {
        return await pollService.createPoll(boardId, { ...input, createdById: user.uid });
      } catch (e) {
        captureException(e, { op: "board.createPoll" });
        onError(e instanceof Error ? e.message : "Failed to create poll.");
        return undefined;
      }
    },
    [boardId, user, onError]
  );

  const vote = useCallback(
    async (pollId: string, optionIndex: number) => {
      if (!user) return;
      try {
        await pollService.castSingleVote(boardId, pollId, user.uid, optionIndex);
        setMyLocalVotes((prev) => ({ ...prev, [pollId]: [optionIndex] }));
      } catch (e) {
        captureException(e, { op: "board.castVote" });
        onError("Failed to cast vote.");
      }
    },
    [boardId, user, onError]
  );

  const toggleDot = useCallback(
    async (pollId: string, optionIndex: number) => {
      if (!user) return;
      try {
        const next = await pollService.toggleDotVote(boardId, pollId, user.uid, optionIndex);
        setMyLocalVotes((prev) => ({ ...prev, [pollId]: next }));
      } catch (e) {
        captureException(e, { op: "board.toggleDotVote" });
        onError("Failed to update vote.");
      }
    },
    [boardId, user, onError]
  );

  const deletePoll = useCallback(
    async (pollId: string) => {
      try {
        await pollService.deletePoll(boardId, pollId);
      } catch (e) {
        captureException(e, { op: "board.deletePoll" });
        onError("Failed to delete poll.");
      }
    },
    [boardId, onError]
  );

  const advanceQuiz = useCallback(
    async (quizId: string) => {
      try {
        await pollService.advanceQuiz(boardId, polls.filter((p) => p.quizId === quizId));
      } catch (e) {
        captureException(e, { op: "board.advanceQuiz" });
        onError("Failed to advance the quiz.");
      }
    },
    [boardId, polls, onError]
  );

  const clearBoardPolls = () => pollService.clearBoardPolls(boardId);

  const resetLocal = () => {
    setPolls([]);
    setVotesByPoll({});
    setTallyByPoll({});
    setMyLocalVotes({});
  };

  return {
    polls,
    resultsFor,
    myVoteFor,
    create,
    vote,
    toggleDot,
    deletePoll,
    advanceQuiz,
    clearBoardPolls,
    resetLocal,
  };
}
