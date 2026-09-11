import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";

// Month 6 — anonymous-poll tallies. An anonymous poll's `votes` subcollection
// is unreadable to board members BY DESIGN (firestore.rules: even a LISTING
// reveals who voted, since the vote doc's id IS the voter's uid) — but
// Firestore's count() aggregation requires read permission on the collection
// it counts, so an anonymous poll cannot compute or display its own result
// client-side at all (rules-tested: "denies a count() aggregation on an
// anonymous poll's votes", firestore-tests/firestore.rules.test.js). This
// trigger is the resolution: it runs with the Admin SDK (which bypasses
// firestore.rules entirely) and maintains a vote-COUNT-ONLY tally at
// `boards/{boardId}/polls/{pollId}/tally/summary`, which members CAN read —
// it carries no voter identity, just counts (PollTally, src/types/index.ts).
//
// Non-anonymous polls never need this: their `votes` subcollection is
// member-readable directly, and the client counts it live instead
// (src/services/pollService.ts's `subscribeToVotes` + `countVotes`) — the
// `anonymous` check in `handlePollVoteWrite` below is what skips the extra
// read+write for them on every single vote.
//
// EVENTUALLY CONSISTENT: this runs AFTER the triggering vote write commits,
// as a SEPARATE function invocation — there is no way to make a voter's own
// vote land in this document atomically with their own write. A voter may
// briefly see their vote accepted (the write itself resolves) before this
// tally reflects it. Never claim otherwise in UI copy (no "results update
// instantly" claim for an anonymous poll) — see PollTally's type comment for
// where this is documented on the client side.

export interface RawPollVote {
  optionIndices?: unknown;
}

export interface PollTallyDoc {
  counts: Record<string, number>;
  totalVotes: number;
}

/**
 * Pure aggregation, split out so it unit-tests without Firestore or the
 * Functions runtime. `counts` keys are option INDICES as strings (Firestore
 * map keys are always strings) — mirrors PollTally.counts. `totalVotes`
 * counts VOTE DOCS (voters), not the sum of every doc's `optionIndices`
 * length, so a "dots" poll's totalVotes answers "how many people voted", not
 * "how many dots were placed" (PollTally's type comment).
 *
 * Tolerant of a malformed/partial vote doc (a missing or non-array
 * `optionIndices`, or a non-integer/negative/non-numeric entry within it) —
 * such a doc still counts toward `totalVotes` (it IS a vote doc) but
 * contributes nothing to `counts`, matching this codebase's standing
 * "readers tolerate missing fields" convention rather than throwing on a
 * half-written doc.
 */
export function computeTally(votes: RawPollVote[]): PollTallyDoc {
  const counts: Record<string, number> = {};
  for (const v of votes) {
    const indices = Array.isArray(v.optionIndices) ? v.optionIndices : [];
    for (const idx of indices) {
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) continue;
      const key = String(idx);
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return { counts, totalVotes: votes.length };
}

/**
 * Injected so `handlePollVoteWrite` unit-tests without the Functions runtime
 * or a real Firestore instance — mirrors the `handleX(req, deps, now)` split
 * used for callables (functions/src/callable/*.ts), adapted to a trigger's
 * shape: there is no `req`/`now` here, just the board/poll ids every
 * votes-subcollection write path param carries.
 */
export interface PollTallyDeps {
  /** `null` when the poll doc no longer exists (e.g. deleted while a vote
   *  write was in flight) — distinct from `false` (an ordinary
   *  non-anonymous poll), though both currently skip the same way. */
  getPollAnonymous(boardId: string, pollId: string): Promise<boolean | null>;
  listVotes(boardId: string, pollId: string): Promise<RawPollVote[]>;
  writeTally(boardId: string, pollId: string, tally: PollTallyDoc): Promise<void>;
}

/**
 * The trigger's actual work, independent of the firebase-functions runtime
 * event shape. Skips entirely for a non-anonymous poll, or one that no
 * longer exists: neither ever reads this tally (see this file's header), so
 * maintaining it on every vote write would be pure wasted reads/writes.
 */
export async function handlePollVoteWrite(
  boardId: string,
  pollId: string,
  deps: PollTallyDeps
): Promise<void> {
  const anonymous = await deps.getPollAnonymous(boardId, pollId);
  if (!anonymous) return;
  const votes = await deps.listVotes(boardId, pollId);
  await deps.writeTally(boardId, pollId, computeTally(votes));
}

function makeDeps(db: Firestore): PollTallyDeps {
  return {
    getPollAnonymous: async (boardId, pollId) => {
      const snap = await db.doc(`boards/${boardId}/polls/${pollId}`).get();
      if (!snap.exists) return null;
      return snap.data()?.anonymous === true;
    },
    listVotes: async (boardId, pollId) => {
      const snap = await db.collection(`boards/${boardId}/polls/${pollId}/votes`).get();
      return snap.docs.map((d) => d.data() as RawPollVote);
    },
    writeTally: async (boardId, pollId, tally) => {
      await db.doc(`boards/${boardId}/polls/${pollId}/tally/summary`).set({
        ...tally,
        updatedAt: FieldValue.serverTimestamp(),
      });
    },
  };
}

// Bound to every write (create/update/DELETE) on a poll's votes
// subcollection. Delete must re-tally too — un-voting (or the admin-
// moderation delete arm firestore.rules grants) that never re-ran this would
// leave a removed vote counted forever.
export const onPollVoteWritten = onDocumentWritten(
  "boards/{boardId}/polls/{pollId}/votes/{voteId}",
  async (event) => {
    const { boardId, pollId } = event.params;
    await handlePollVoteWrite(boardId, pollId, makeDeps(getFirestore()));
  }
);
