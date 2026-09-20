import { onDocumentDeleted, onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

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
// EVENTUALLY CONSISTENT (lag, not loss): this runs AFTER the triggering vote
// write commits, as a SEPARATE function invocation — there is no way to make
// a voter's own vote land in this document atomically with their own write.
// A voter may briefly see their vote accepted (the write itself resolves)
// before this tally reflects it. Never claim otherwise in UI copy (no
// "results update instantly" claim for an anonymous poll) — see PollTally's
// type comment for where this is documented on the client side.
//
// TRANSACTIONAL BY NECESSITY (fix round 1, item 2): the full read-every-vote-
// then-write-the-total shape is what makes this design immune to counter
// drift in the first place — a voter switching A→B, a retried delivery, and
// a deleted vote are all correct by construction, because there is no
// decrement path to get wrong, and `tx.set()` means an option that falls to
// zero disappears from `counts` rather than leaving a stale key behind. But
// that same shape is a lost-update race if the read and the write are two
// separate, un-synchronized Firestore calls: two votes arriving within the
// same second — the ORDINARY case for a live poll, not an edge case — can
// interleave as (A reads [v1]) (B reads [v1,v2]) (B commits "2") (A commits
// "1", clobbering B's newer, correct total), and because the poll is
// anonymous NOBODY can look at the votes to notice or fix it. Wrapping the
// read and the write in one `db.runTransaction` closes this: Firestore
// tracks every document the transaction's `tx.get` touched (a query read
// included) and aborts + retries the whole callback if any of them changed
// before commit, so a losing writer re-reads the fresh state instead of
// overwriting it. This keeps the full-recompute idempotency above — it does
// not turn this into a delta/increment counter, which would reintroduce the
// exact drift class this design exists to avoid.
//
// Fix round 3 — this file ALSO owns poll-deletion cleanup (`onPollDeleted`,
// below) for the same reason it owns the tally: both need the Admin SDK's
// unrestricted access, which firestore.rules deliberately never grants to a
// client. `pollService.deletePoll` used to batch-delete a poll's votes AND
// its tally doc together from the client — but `tally/{tallyId}`'s rule is
// `allow write: if false` unconditionally (no client may ever delete it),
// and Firestore batched writes are atomic, so that batch failed WHENEVER
// the poll being deleted had a tally doc — i.e. every anonymous poll that
// had ever been voted on. Not an edge case: the routine "delete my poll"
// action, for the one poll kind (anonymous, voted-on) this whole file
// exists to serve. `onPollDeleted` is what the client hands off to instead:
// `deletePoll` now only ever deletes the poll doc itself (something it IS
// permitted to do), and this trigger — via the Admin SDK, which bypasses
// the very rule that made client-side cleanup impossible — removes the
// tally and every vote doc (anonymous or not) once the poll is gone.

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
 * contributes nothing bad to `counts`, matching this codebase's standing
 * "readers tolerate missing fields" convention rather than throwing on a
 * half-written doc. Also de-duplicates a single vote's OWN repeated index
 * (`[0,0,0]` counts once toward option 0, not three times) — defense in
 * depth alongside firestore.rules' own `idx.toSet().size() == idx.size()`
 * create/update check (fix round 1, item 5): this function has no way to
 * know whether a stored doc predates that rule or was written by some other
 * trusted path, so it does not assume the invariant holds.
 */
export function computeTally(votes: RawPollVote[]): PollTallyDoc {
  const counts: Record<string, number> = {};
  for (const v of votes) {
    const indices = Array.isArray(v.optionIndices) ? v.optionIndices : [];
    const validIndices = indices.filter(
      (idx): idx is number => typeof idx === "number" && Number.isInteger(idx) && idx >= 0
    );
    for (const idx of new Set(validIndices)) {
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
  /** Reads the FULL votes collection and writes the freshly recomputed tally
   *  ATOMICALLY (fix round 1, item 2 — see this file's header for why a
   *  separate read-then-write would lose updates under concurrent votes).
   *  The real implementation (`makeRecomputeTally`) is a `db.runTransaction`
   *  call; nothing about this interface requires that on its own, which is
   *  exactly why `makeRecomputeTally` has its own dedicated tests against a
   *  fake transactional `db` rather than relying on `handlePollVoteWrite`'s
   *  mocked-away version to prove it. */
  recomputeTally(boardId: string, pollId: string): Promise<void>;
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
  await deps.recomputeTally(boardId, pollId);
}

/**
 * The real transactional core, split out so it unit-tests against a fake
 * Firestore-like object without the emulator — mirrors
 * callable/createSession.ts's `makeRunCreate`. Reads the ENTIRE votes
 * collection and writes the freshly recomputed tally inside ONE
 * transaction: if another vote is written between this transaction's read
 * and its commit, Firestore aborts and retries the whole function body with
 * a fresh read, rather than committing a tally computed from already-stale
 * data over a newer one (see this file's header for the concrete
 * interleaving this closes).
 *
 * Deliberately does NOT stamp an `updatedAt` on the written doc (fix round
 * 1, item 10) — nothing reads it (`useBoardPolls` uses only `counts`/
 * `totalVotes`), and on an anonymity feature a timing side channel a member
 * could correlate against presence ("the count moved while only Alice was
 * here") is not worth keeping around for free.
 */
export function makeRecomputeTally(db: Firestore): PollTallyDeps["recomputeTally"] {
  return (boardId, pollId) =>
    db.runTransaction(async (tx) => {
      const votesRef = db.collection(`boards/${boardId}/polls/${pollId}/votes`);
      const snap = await tx.get(votesRef);
      const votes = snap.docs.map((d) => d.data() as RawPollVote);
      const tallyRef = db.doc(`boards/${boardId}/polls/${pollId}/tally/summary`);
      tx.set(tallyRef, computeTally(votes));
    });
}

function makeDeps(db: Firestore): PollTallyDeps {
  return {
    getPollAnonymous: async (boardId, pollId) => {
      const snap = await db.doc(`boards/${boardId}/polls/${pollId}`).get();
      if (!snap.exists) return null;
      return snap.data()?.anonymous === true;
    },
    recomputeTally: makeRecomputeTally(db),
  };
}

// Bound to every write (create/update/DELETE) on a poll's votes
// subcollection. Delete must re-tally too — un-voting (or the admin-
// moderation delete arm firestore.rules grants) that never re-ran this would
// leave a removed vote counted forever. `onDocumentWritten`, never
// `onDocumentCreated` — see this file's own test suite, which pins the
// registered event type so swapping this back to create-only (which would
// leave every un-vote counted forever, silently) fails a test rather than
// only a manual QA pass.
export const onPollVoteWritten = onDocumentWritten(
  "boards/{boardId}/polls/{pollId}/votes/{voteId}",
  async (event) => {
    const { boardId, pollId } = event.params;
    await handlePollVoteWrite(boardId, pollId, makeDeps(getFirestore()));
  }
);

// ─────────────────────────────────────────────────────────────────────────
// Poll-deletion cleanup (fix round 3) — see this file's header for why this
// has to be server-side at all: firestore.rules denies every client delete
// of a `tally` doc, unconditionally, so pollService.deletePoll can no
// longer attempt it. This trigger is the replacement.

/**
 * Injected so `handlePollDeleted` unit-tests without the Functions runtime
 * or a real Firestore instance — same split as `PollTallyDeps` above.
 */
export interface PollCleanupDeps {
  /** Deletes EVERY vote doc under the poll (anonymous or not — the Admin
   *  SDK bypasses firestore.rules, so there is no "which votes can I even
   *  see" question here the way there is on the client) and the tally doc,
   *  in ≤500-doc batches. The real implementation
   *  (`makeDeletePollSubcollections`) is the thing that actually needs
   *  Firestore; this interface doesn't, which is why `handlePollDeleted`
   *  below unit-tests against a bare mock of it. */
  deletePollSubcollections(boardId: string, pollId: string): Promise<void>;
}

/**
 * The trigger's actual work, independent of the firebase-functions runtime
 * event shape — always runs (unlike `handlePollVoteWrite`, there is no
 * "skip for non-anonymous" branch here: a non-anonymous poll's votes still
 * need cleaning up now that `pollService.deletePoll` no longer attempts any
 * subcollection deletes itself, anonymous or not).
 */
export async function handlePollDeleted(
  boardId: string,
  pollId: string,
  deps: PollCleanupDeps
): Promise<void> {
  await deps.deletePollSubcollections(boardId, pollId);
}

/**
 * The real cleanup core, split out so it unit-tests against a fake
 * Firestore-like object without the emulator — mirrors
 * `makeRecomputeTally`'s own split above. Reads the full votes collection
 * (no `where` filter needed — the Admin SDK isn't subject to
 * firestore.rules' per-document read gate the client-side equivalent
 * needs; see `pollService.subscribeToVotes`'s own comment — the only one of
 * the two that still adds such a filter, since `deletePoll` no longer
 * queries votes at all) plus the tally doc, and deletes everything found in
 * ≤500-doc batches — same chunking `pollService.deletePoll` used to do
 * client-side.
 */
export function makeDeletePollSubcollections(db: Firestore): PollCleanupDeps["deletePollSubcollections"] {
  return async (boardId, pollId) => {
    const votesSnap = await db.collection(`boards/${boardId}/polls/${pollId}/votes`).get();
    const tallyRef = db.doc(`boards/${boardId}/polls/${pollId}/tally/summary`);
    const tallySnap = await tallyRef.get();

    const refsToDelete = votesSnap.docs.map((d) => d.ref);
    if (tallySnap.exists) refsToDelete.push(tallyRef);

    for (let i = 0; i < refsToDelete.length; i += 500) {
      const batch = db.batch();
      refsToDelete.slice(i, i + 500).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
  };
}

function makeCleanupDeps(db: Firestore): PollCleanupDeps {
  return { deletePollSubcollections: makeDeletePollSubcollections(db) };
}

// Bound to the poll doc's own delete — NOT the votes subcollection
// (`onPollVoteWritten` above already owns that path). Fires once per
// deleted poll, regardless of anonymity: see `handlePollDeleted`'s comment
// for why there is no skip branch here.
export const onPollDeleted = onDocumentDeleted(
  "boards/{boardId}/polls/{pollId}",
  async (event) => {
    const { boardId, pollId } = event.params;
    await handlePollDeleted(boardId, pollId, makeCleanupDeps(getFirestore()));
  }
);
