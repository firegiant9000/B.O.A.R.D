import {
  collection,
  doc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { CommentAnchorKind, Reaction, ReactionEmoji, REACTION_EMOJIS } from "../types";

// Month 6 — reactions on canvas elements (👍 ❤️ ❓ ⭐ 💡). Mirrors
// commentService's subcollection pattern (one doc per reaction under a
// board's `reactions` subcollection, a realtime subscription, a mapper that
// defaults/validates a raw doc so the rest of the app treats every returned
// Reaction as well-formed) — see Comment/Reaction's shared anchoring
// discussion in types/index.ts.
//
// Storage: `boards/{id}/reactions/{elementId}_{emoji}_{userId}`. The document
// id is the UNIQUENESS constraint: one user reacting twice with the same
// emoji on the same element addresses the same doc (a denied re-create or an
// intentional delete — see `addReaction`'s own comment), never a second row,
// so "one reaction per user per emoji per element" holds without a query.
//
// Role authorization is the `userId` FIELD (firestore.rules' `reactions`
// match checks `request.resource.data.userId == request.auth.uid`, exactly
// like comments' `authorId`), but the id is not left unchecked either: that
// same rule also requires the id to equal the fields' own
// `anchorElementId + '_' + emoji + '_' + userId`, by exact-match
// concatenation, never by splitting the id apart (a fixed segment count
// would break the moment any segment contains an underscore). This is what
// stops a caller who legitimately owns `userId` from still writing
// `el1_👍_me_2`/`x`/etc. — ids that would each pass the field check alone and
// inflate a badge's count without limit.

const ANCHOR_KINDS: CommentAnchorKind[] = ["path", "shape", "text", "note", "image"];

/** Unlike commentService's `readAnchorKind`, a missing/invalid value maps to
 *  `undefined`, never to a guessed default kind — see Reaction's type
 *  comment for why a wrong hint is worse than no hint at all. */
function readAnchorKind(v: any): CommentAnchorKind | undefined {
  return ANCHOR_KINDS.includes(v) ? v : undefined;
}

function mapReactionDoc(id: string, data: any): Reaction | null {
  if (!data || !data.anchorElementId || !REACTION_EMOJIS.includes(data.emoji)) return null;
  return {
    id,
    schemaVersion: 1,
    boardId: data.boardId ?? "",
    anchorElementId: data.anchorElementId,
    anchorKind: readAnchorKind(data.anchorKind),
    emoji: data.emoji,
    userId: data.userId ?? "",
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

/** `boards/{boardId}/reactions/{elementId}_{emoji}_{userId}` — see this
 *  module's header for why the id (not a query) is the uniqueness
 *  constraint. */
export function reactionDocId(anchorElementId: string, emoji: ReactionEmoji, userId: string): string {
  return `${anchorElementId}_${emoji}_${userId}`;
}

export interface NewReaction {
  anchorElementId: string;
  /** Omit when the caller doesn't know the anchor's kind (e.g. reacting from
   *  the current selection, which tracks ids only) — see Reaction's type
   *  comment. Never pass a guessed value. */
  anchorKind?: CommentAnchorKind;
  emoji: ReactionEmoji;
  userId: string;
}

function reactionPayload(boardId: string, input: NewReaction) {
  return {
    schemaVersion: 1 as const,
    boardId,
    anchorElementId: input.anchorElementId,
    anchorKind: input.anchorKind ?? null,
    emoji: input.emoji,
    userId: input.userId,
    createdAt: serverTimestamp(),
  };
}

/** Creates the caller's reaction on an element. NOT idempotent under
 *  firestore.rules: `allow update: if false` on `reactions` means a second
 *  call at the same doc id is denied outright — Firestore rules evaluate a
 *  `setDoc` against an ALREADY-EXISTING doc as an `update`, regardless of
 *  the client SDK method name, so this throws rather than silently
 *  overwriting. A caller that might already have reacted (the normal case
 *  for a UI toggle) should call `toggleReaction` instead, which checks
 *  first. */
export async function addReaction(boardId: string, input: NewReaction): Promise<void> {
  const id = reactionDocId(input.anchorElementId, input.emoji, input.userId);
  await setDoc(doc(db, "boards", boardId, "reactions", id), reactionPayload(boardId, input));
}

export async function removeReaction(
  boardId: string,
  anchorElementId: string,
  emoji: ReactionEmoji,
  userId: string
): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId, "reactions", reactionDocId(anchorElementId, emoji, userId)));
}

/**
 * Adds the caller's reaction if absent, removes it if present. One extra
 * round trip versus a blind write (a `getDoc` first) because a reaction is
 * exactly the low-frequency case where "tap to react, tap again to un-react"
 * is the whole UX contract — a blind overwrite could never toggle off.
 */
export async function toggleReaction(
  boardId: string,
  input: NewReaction
): Promise<"added" | "removed"> {
  const ref = doc(
    db,
    "boards",
    boardId,
    "reactions",
    reactionDocId(input.anchorElementId, input.emoji, input.userId)
  );
  const existing = await getDoc(ref);
  if (existing.exists()) {
    await deleteDoc(ref);
    return "removed";
  }
  await setDoc(ref, reactionPayload(boardId, input));
  return "added";
}

/** Realtime subscription to a board's reactions. Unordered — callers group by
 *  `anchorElementId` for a badge count, where creation order doesn't matter. */
export function subscribeToBoardReactions(
  boardId: string,
  onChange: (reactions: Reaction[]) => void
): () => void {
  const ref = collection(db, "boards", boardId, "reactions");
  return onSnapshot(ref, (snapshot: any) => {
    const reactions = snapshot.docs
      .map((d: any) => mapReactionDoc(d.id, d.data()))
      .filter((r: Reaction | null): r is Reaction => r !== null);
    onChange(reactions);
  });
}

/** Deletes every reaction on a board, in 500-doc batches (board clear/delete),
 *  mirroring commentService.clearBoardComments. */
export async function clearBoardReactions(boardId: string): Promise<void> {
  const snap = await getDocs(collection(db, "boards", boardId, "reactions"));
  for (let i = 0; i < snap.docs.length; i += 500) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 500).forEach((d: any) => batch.delete(d.ref));
    await batch.commit();
  }
}
