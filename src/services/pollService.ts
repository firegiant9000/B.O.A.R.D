import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "../config/firebase";
import {
  MAX_POLL_OPTIONS,
  MIN_POLL_OPTIONS,
  PollElement,
  PollMode,
  PollTally,
  PollVote,
} from "../types";

// Re-exported for existing/future callers of this module — the values
// themselves live in src/types/index.ts (see that file's comment) so a pure
// UI component can use them without importing this module's Firestore chain.
export { MIN_POLL_OPTIONS, MAX_POLL_OPTIONS };

// Month 6 — polls, quiz sequencing and dot voting. See PollElement/PollVote/
// PollTally's type comments (src/types/index.ts) for the storage shape and
// the anonymity/eventual-consistency reasoning; this module is the read/
// write surface over it, mirroring reactionService.ts's split (a mapper that
// defaults/validates a raw doc, a realtime subscription per collection, and
// write paths that are as close to one Firestore call as the rule they must
// satisfy allows).

/** Dot-voting cap — a member may spread their vote across at most this many
 *  options at once (PollElement's "mode" comment). Not specified by the
 *  brief; a deliberately small, fixed default. Mirrored in firestore.rules'
 *  `isValidVotePayload` — kept in sync by this file's own test suite's
 *  "firestore.rules dot-vote cap mirror" (fix round 1, item 3), so changing
 *  this number without also changing the rules literal fails a test instead
 *  of quietly turning the 4th dot into a permission-denied in production. */
export const MAX_DOT_VOTES = 3;

function mapPollDoc(id: string, data: any): PollElement | null {
  if (!data || !data.question || !Array.isArray(data.options)) return null;
  return {
    id,
    schemaVersion: 1,
    boardId: data.boardId ?? "",
    question: data.question,
    options: data.options,
    // Fix round 1, item 9 — defaults to TRUE (anonymous) on a
    // missing/malformed field, matching firestore.rules' isAnonymousPoll
    // fail-closed default exactly, rather than the opposite `!!data.anonymous`
    // (defaults to false) this used to read. The two used to disagree: a
    // poll written without the field would subscribe to the (member-
    // readable) votes collection here while the rule denied that same read
    // — a permanent "no votes yet" with a silent console permission error
    // and no visible cause. firestore.rules' create rule now also requires
    // `anonymous is bool`, so no NEW poll can ever be missing it; this
    // default only matters for data that predates that rule.
    anonymous: typeof data.anonymous === "boolean" ? data.anonymous : true,
    mode: data.mode === "dots" ? "dots" : "single",
    x: data.x ?? 0,
    y: data.y ?? 0,
    createdById: data.createdById ?? "",
    quizId: typeof data.quizId === "string" ? data.quizId : undefined,
    quizIndex: typeof data.quizIndex === "number" ? data.quizIndex : undefined,
    active: data.active === true ? true : undefined,
    createdAt: data.createdAt?.toDate?.() ?? new Date(),
  };
}

/** Drops any entry that isn't a non-negative integer, rather than trusting a
 *  vote doc's shape — mirrors PollVote's type comment: an out-of-range or
 *  malformed index is a correctness gap the READER absorbs, never a thrown
 *  error and never a security concern (the doc id / userId field is what
 *  actually enforces "one vote per user", not this array's contents). */
function readOptionIndices(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0);
}

function mapVoteDoc(id: string, data: any): PollVote | null {
  if (!data) return null;
  return {
    id,
    userId: data.userId ?? id,
    optionIndices: readOptionIndices(data.optionIndices),
    createdAt: data.createdAt?.toDate?.() ?? new Date(),
  };
}

function mapTallyDoc(data: any): PollTally {
  return {
    counts: data && typeof data.counts === "object" && data.counts !== null ? data.counts : {},
    totalVotes: typeof data?.totalVotes === "number" ? data.totalVotes : 0,
  };
}

export interface NewPoll {
  question: string;
  options: string[];
  anonymous: boolean;
  mode: PollMode;
  x: number;
  y: number;
  createdById: string;
  /** Set BOTH together to make this poll one question of a quiz sequence;
   *  omit both for a standalone poll. */
  quizId?: string;
  quizIndex?: number;
}

/**
 * Creates a new poll — genuinely new canvas content (editor-only under
 * firestore.rules, exactly like a shape or text element; see PollElement's
 * type comment). Rejects an out-of-bounds option count BEFORE any write —
 * defense in depth alongside firestore.rules' own [2,6] bound, so a caller
 * gets an immediate, specific error instead of an opaque permission-denied
 * from the rules engine.
 *
 * The first question of a quiz (`quizIndex === 0`) is stamped `active: true`
 * at create time, so a quiz has a current question the moment it exists
 * rather than requiring a separate `advanceQuiz` call just to show question
 * one. Every later question is created inactive; `advanceQuiz` is what moves
 * `active` forward from there.
 */
export async function createPoll(boardId: string, input: NewPoll): Promise<string> {
  if (input.options.length < MIN_POLL_OPTIONS || input.options.length > MAX_POLL_OPTIONS) {
    throw new Error(`A poll needs between ${MIN_POLL_OPTIONS} and ${MAX_POLL_OPTIONS} options.`);
  }
  const ref = collection(db, "boards", boardId, "polls");
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    boardId,
    question: input.question,
    options: input.options,
    anonymous: input.anonymous,
    mode: input.mode,
    x: input.x,
    y: input.y,
    createdById: input.createdById,
    createdAt: serverTimestamp(),
  };
  if (input.quizId) {
    payload.quizId = input.quizId;
    payload.quizIndex = input.quizIndex ?? 0;
    payload.active = (input.quizIndex ?? 0) === 0;
  }
  const docRef = await addDoc(ref, payload);
  return docRef.id;
}

/** Realtime subscription to every poll on a board — the canvas rendering
 *  join (positioning by the poll's own persisted x/y, unlike reactions'
 *  live-element-bounds join) happens in the caller, same division of labor
 *  as useBoardReactions/BoardCanvas. */
export function subscribeToBoardPolls(
  boardId: string,
  onChange: (polls: PollElement[]) => void
): () => void {
  const ref = collection(db, "boards", boardId, "polls");
  return onSnapshot(ref, (snapshot: any) => {
    const polls = snapshot.docs
      .map((d: any) => mapPollDoc(d.id, d.data()))
      .filter((p: PollElement | null): p is PollElement => p !== null);
    onChange(polls);
  });
}

/** Realtime subscription to a NON-anonymous poll's votes. firestore.rules
 *  denies this read outright for an anonymous poll (PollElement's type
 *  comment) — this function does not itself know a poll's `anonymous` flag,
 *  so calling it against one surfaces as an onSnapshot permission-denied
 *  error, never a thrown exception here. Callers must route an anonymous
 *  poll to `subscribeToTally` instead. */
export function subscribeToVotes(
  boardId: string,
  pollId: string,
  onChange: (votes: PollVote[]) => void
): () => void {
  const ref = collection(db, "boards", boardId, "polls", pollId, "votes");
  return onSnapshot(ref, (snapshot: any) => {
    const votes = snapshot.docs
      .map((d: any) => mapVoteDoc(d.id, d.data()))
      .filter((v: PollVote | null): v is PollVote => v !== null);
    onChange(votes);
  });
}

/** Realtime subscription to an ANONYMOUS poll's server-maintained tally (see
 *  PollTally's type comment for the eventual-consistency caveat — this is
 *  the ONLY way an anonymous poll's results reach the client at all).
 *  `onChange` fires with `null` before the trigger has written anything yet
 *  (no votes cast, or the very first vote hasn't been aggregated) — render a
 *  "no votes yet" state, never a crash. */
export function subscribeToTally(
  boardId: string,
  pollId: string,
  onChange: (tally: PollTally | null) => void
): () => void {
  const ref = doc(db, "boards", boardId, "polls", pollId, "tally", "summary");
  return onSnapshot(ref, (snapshot: any) => {
    onChange(snapshot.exists() ? mapTallyDoc(snapshot.data()) : null);
  });
}

/**
 * Casts or CHANGES the caller's vote. One function for both: `setDoc` at the
 * voter's own uid overwrites any existing doc rather than adding a row — a
 * Firestore `update` under firestore.rules once the doc exists, which
 * (unlike reactions, where react/un-react is create/delete only) the votes
 * rule explicitly allows for the voter's own doc. See PollElement's type
 * comment for why "the document id is the uid" is what makes this safe:
 * there is structurally only ever one vote doc per (poll, user).
 *
 * `optionIndices` is the caller's full new selection, not a delta — a
 * single-mode caller passes exactly one index (see `castSingleVote`); a
 * dots-mode caller wanting an add/remove toggle should use `toggleDotVote`
 * instead of computing the next array by hand.
 */
export async function castVote(
  boardId: string,
  pollId: string,
  userId: string,
  optionIndices: number[]
): Promise<void> {
  await setDoc(doc(db, "boards", boardId, "polls", pollId, "votes", userId), {
    userId,
    optionIndices,
    createdAt: serverTimestamp(),
  });
}

/** Single-choice convenience: casts exactly one option. */
export function castSingleVote(
  boardId: string,
  pollId: string,
  userId: string,
  optionIndex: number
): Promise<void> {
  return castVote(boardId, pollId, userId, [optionIndex]);
}

/**
 * Dot-voting toggle: adds `optionIndex` to the caller's existing selection if
 * absent (capped at MAX_DOT_VOTES — a no-op past the cap, never an error, so
 * a UI can leave every dot's tap handler wired up without checking the cap
 * itself), removes it if already present. Reads the caller's own vote doc
 * first — the same read-before-write shape as reactionService.toggleReaction,
 * for the same reason: a toggle cannot be a blind write.
 *
 * Removing the last remaining dot DELETES the vote doc entirely rather than
 * writing an empty array: firestore.rules requires `optionIndices` to be
 * non-empty, and a zero-length selection isn't a vote — it's the absence of
 * one, which the votes subcollection already represents by having no doc.
 *
 * Returns the caller's resulting selection (possibly empty), so a UI can
 * update its own state without a second read.
 */
export async function toggleDotVote(
  boardId: string,
  pollId: string,
  userId: string,
  optionIndex: number
): Promise<number[]> {
  const ref = doc(db, "boards", boardId, "polls", pollId, "votes", userId);
  const existing = await getDoc(ref);
  const current = existing.exists() ? readOptionIndices((existing.data() as any)?.optionIndices) : [];
  const already = current.includes(optionIndex);

  let next: number[];
  if (already) {
    next = current.filter((i) => i !== optionIndex);
  } else if (current.length >= MAX_DOT_VOTES) {
    return current; // at the cap; no-op
  } else {
    next = [...current, optionIndex];
  }

  if (next.length === 0) {
    await deleteDoc(ref);
  } else {
    await setDoc(ref, { userId, optionIndices: next, createdAt: serverTimestamp() });
  }
  return next;
}

/**
 * Local (non-persisted) tally for a NON-anonymous poll — counts the live,
 * member-readable votes subcollection client-side rather than reading the
 * trigger-maintained `tally` doc, which only anonymous polls rely on (see
 * PollTally's type comment). Never throws on an out-of-range index — it is
 * simply excluded from `counts`, matching PollVote's tolerant-reader
 * contract.
 */
export function countVotes(
  votes: PollVote[],
  optionCount: number
): { counts: number[]; totalVotes: number } {
  const counts = new Array(optionCount).fill(0);
  for (const v of votes) {
    for (const idx of v.optionIndices) {
      if (idx >= 0 && idx < optionCount) counts[idx]++;
    }
  }
  return { counts, totalVotes: votes.length };
}

/**
 * Deletes a poll and its votes/tally subcollections, in 500-doc batches —
 * mirrors reactionService.clearBoardReactions/commentService's own cleanup.
 * Firestore never cascade-deletes subcollections on its own; left alone, a
 * deleted poll's votes would become permanently orphaned — and for an
 * anonymous poll, permanently UNREADABLE under firestore.rules' fail-closed
 * default once the parent poll doc is gone (see that rule's comment), so
 * this is the only path that ever reclaims them.
 */
export async function deletePoll(boardId: string, pollId: string): Promise<void> {
  const pollRef = doc(db, "boards", boardId, "polls", pollId);
  const votesRef = collection(db, "boards", boardId, "polls", pollId, "votes");
  const tallyRef = collection(db, "boards", boardId, "polls", pollId, "tally");
  const [votesSnap, tallySnap] = await Promise.all([getDocs(votesRef), getDocs(tallyRef)]);
  const allDocs = [...votesSnap.docs, ...tallySnap.docs];
  for (let i = 0; i < allDocs.length; i += 500) {
    const batch = writeBatch(db);
    allDocs.slice(i, i + 500).forEach((d: any) => batch.delete(d.ref));
    await batch.commit();
  }
  await deleteDoc(pollRef);
}

/** Deletes every poll on a board (each via `deletePoll`'s own votes/tally
 *  cleanup) — the "clear board" composition point, mirroring
 *  reactionService.clearBoardReactions/commentService's board-clear
 *  functions. Run in parallel: unlike `deletePoll`'s own internal batching
 *  (which must serialize across 500-doc chunks of ONE poll's subcollections),
 *  separate polls share no batch and have no ordering constraint between
 *  them. */
export async function clearBoardPolls(boardId: string): Promise<void> {
  const snap = await getDocs(collection(db, "boards", boardId, "polls"));
  await Promise.all(snap.docs.map((d: any) => deletePoll(boardId, d.id)));
}

/**
 * Advances a quiz sequence to its next question. `quizPolls` must be every
 * PollElement sharing one `quizId` — the caller (the board-polls hook)
 * already holds this from its live subscription, filtered by quizId; this
 * function does no querying of its own.
 *
 * Deactivates the currently-active question and activates the next one (by
 * `quizIndex`, NOT array position — the caller's array may arrive in any
 * order) in a single batch, so a viewer's realtime listener never observes
 * an intermediate state with either zero or two active questions. A no-op
 * once the sequence has reached its last question, and a no-op on an empty
 * list. If no question is active yet (a quiz that has never been advanced —
 * though `createPoll` normally stamps its first question active already),
 * this activates the FIRST question by `quizIndex` order (not necessarily
 * the literal value 0, and not necessarily array position 0 either).
 */
export async function advanceQuiz(boardId: string, quizPolls: PollElement[]): Promise<void> {
  const ordered = [...quizPolls].sort((a, b) => (a.quizIndex ?? 0) - (b.quizIndex ?? 0));
  if (ordered.length === 0) return;

  const currentIdx = ordered.findIndex((p) => p.active);
  const nextIdx = currentIdx === -1 ? 0 : currentIdx + 1;
  if (nextIdx >= ordered.length) return;

  const batch = writeBatch(db);
  if (currentIdx !== -1) {
    batch.update(doc(db, "boards", boardId, "polls", ordered[currentIdx].id), { active: false });
  }
  batch.update(doc(db, "boards", boardId, "polls", ordered[nextIdx].id), { active: true });
  await batch.commit();
}
