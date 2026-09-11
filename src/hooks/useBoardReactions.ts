import { useCallback, useEffect, useMemo, useState } from "react";
import * as reactionService from "../services/reactionService";
import { captureException } from "../lib/errorReporting";
import { CommentAnchorKind, Reaction, ReactionEmoji, REACTION_EMOJIS } from "../types";

/**
 * Board reactions (Month 6). Mirrors useBoardComments.ts's shape closely: one
 * hook owns the realtime reaction set and the write path, the screen supplies
 * the viewer identity, and the join against live element geometry (resolving
 * a badge's on-screen position) stays the CALLER's job — this hook never
 * reads `boxOfElement` itself, exactly like `useBoardComments.pinsFrom` takes
 * a resolver rather than owning one.
 *
 * Unlike comments, this hook does NOT expose a `pinsFrom`-style resolver:
 * BoardCanvas already needs the current *selection* (to offer a first-react
 * entry point on an element with zero reactions yet, mirroring
 * AudioAffordance's own "record" vs. "existing note" split) which this hook
 * has no business knowing about, so the box-resolution join lives there
 * instead — see BoardCanvas.tsx's `positionedReactionBadges`.
 */

/** The minimum shape this hook needs from the signed-in auth user. */
export interface ReactionsUser {
  uid: string;
}

export interface ReactionCount {
  emoji: ReactionEmoji;
  count: number;
  /** Whether the CURRENT viewer is one of the users behind this count. */
  reactedByMe: boolean;
}

export interface BoardReactionsOptions {
  user: ReactionsUser | null;
  /** Surface a user-facing failure in the screen's error banner. */
  onError: (message: string) => void;
}

export interface BoardReactions {
  reactions: Reaction[];
  /** Ids of every element with at least one live reaction, from any user. */
  elementIdsWithReactions: string[];
  /** All 5 emoji for one element, zero-count entries included, counted from
   *  the live subscription. */
  countsFor: (elementId: string) => ReactionCount[];
  /** The anchor kind of an EXISTING reaction on this element, if any — reused
   *  as the render hint when toggling one more reaction onto the same
   *  element (see Reaction's type comment for why a wrong hint is worse
   *  than none: this only ever returns a kind actually read back from a
   *  stored doc, never a guess). `undefined` when the element has no
   *  reaction yet. */
  anchorKindOf: (elementId: string) => CommentAnchorKind | undefined;
  /** Adds the caller's own reaction if absent, removes it if present. Pass
   *  `anchorKind` when known (`anchorKindOf`); omit it for a brand-new
   *  reaction whose element kind the caller doesn't know (e.g. reacting from
   *  the current selection, which tracks ids only). */
  toggle: (elementId: string, emoji: ReactionEmoji, anchorKind?: CommentAnchorKind) => Promise<void>;
  /** Delete every reaction on the board (composed with the element clear). */
  clearBoardReactions: () => Promise<void>;
  /** Drop the local reaction set (after a successful clear). */
  resetLocal: () => void;
}

export function useBoardReactions(boardId: string, opts: BoardReactionsOptions): BoardReactions {
  const { user, onError } = opts;
  const [reactions, setReactions] = useState<Reaction[]>([]);

  useEffect(() => {
    if (!boardId) return;
    return reactionService.subscribeToBoardReactions(boardId, setReactions);
  }, [boardId]);

  const elementIdsWithReactions = useMemo(() => {
    const ids = new Set<string>();
    reactions.forEach((r) => ids.add(r.anchorElementId));
    return Array.from(ids);
  }, [reactions]);

  const countsFor = useCallback(
    (elementId: string): ReactionCount[] => {
      return REACTION_EMOJIS.map((emoji) => {
        const withEmoji = reactions.filter(
          (r) => r.anchorElementId === elementId && r.emoji === emoji
        );
        return {
          emoji,
          count: withEmoji.length,
          reactedByMe: !!user && withEmoji.some((r) => r.userId === user.uid),
        };
      });
    },
    [reactions, user]
  );

  const anchorKindOf = useCallback(
    (elementId: string): CommentAnchorKind | undefined => {
      // Prefers a reaction that actually carries a kind over one that
      // doesn't (an element's very first reaction, from the selection entry
      // point, may have none — see Reaction's type comment) so a later
      // reaction on the same element isn't stuck re-omitting the hint
      // forever just because an earlier doc happened to lack one.
      return reactions.find((r) => r.anchorElementId === elementId && r.anchorKind)?.anchorKind;
    },
    [reactions]
  );

  const toggle = useCallback(
    async (elementId: string, emoji: ReactionEmoji, anchorKind?: CommentAnchorKind) => {
      if (!user) return;
      try {
        await reactionService.toggleReaction(boardId, {
          anchorElementId: elementId,
          anchorKind,
          emoji,
          userId: user.uid,
        });
      } catch (e) {
        captureException(e, { op: "board.toggleReaction" });
        onError("Failed to update reaction.");
      }
    },
    [boardId, user, onError]
  );

  const clearBoardReactions = () => reactionService.clearBoardReactions(boardId);

  const resetLocal = () => setReactions([]);

  return {
    reactions,
    elementIdsWithReactions,
    countsFor,
    anchorKindOf,
    toggle,
    clearBoardReactions,
    resetLocal,
  };
}
