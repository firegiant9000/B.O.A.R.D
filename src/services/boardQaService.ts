import { httpsCallable } from "firebase/functions";
import { functions } from "../config/firebase";
import { BOARD_QA_ENABLED, AI_GATEWAY_ENABLED } from "../lib/featureFlags";

// Month 6 — board Q&A (chat with your board). The client half of the `askBoard`
// callable: the panel calls this module, never the callable and never Firestore
// directly, same as every other service here.
//
// THERE IS NOTHING TO READ CLIENT-SIDE. The embeddings this feature searches
// live at `boards/{boardId}/embeddings` with no match block in
// firestore.rules, denied to every client by the file-level default deny.
// Retrieval runs entirely inside the function; what comes back is an answer
// plus the ids of the elements it was drawn from. If a future change here ever
// seems to need a client read of that collection, the design has gone wrong —
// a 1536-float vector has no client use, and shipping one would be pure cost.

export interface BoardQaCitation {
  elementId: string;
  /** The element's kind as the indexer stamped it (`note`, `textElement`, …).
   *  Needed to resolve the id back to a canvas element — ids are only unique
   *  within their own subcollection. */
  elementType: string;
  excerpt: string;
}

export interface BoardQaAnswer {
  answer: string;
  citations: BoardQaCitation[];
  model: string;
}

/** One turn in the thread. The thread itself lives in the panel's own state —
 *  see `askBoard`'s note on why it is not persisted. */
export interface BoardQaTurn {
  role: "user" | "assistant";
  text: string;
}

/** Whether the board Q&A affordance should be offered at all. Advisory: this
 *  only decides whether to draw the entry point. The callable enforces
 *  membership, the rate bucket and the plan cap server-side regardless of what
 *  this returns, and a patched bundle skips this check entirely. */
export function isBoardQaConfigured(): boolean {
  return BOARD_QA_ENABLED && AI_GATEWAY_ENABLED;
}

/**
 * The canvas element kind for an indexed `elementType`.
 *
 * The two vocabularies are close enough to look interchangeable and are not:
 * the indexer stamps `textElement` while the canvas calls the same thing
 * `text`. Exported and pinned by tests because it is what makes a citation
 * clickable — a wrong mapping here makes every text citation resolve to
 * nothing, which is indistinguishable, on screen, from the element having been
 * deleted.
 */
export const CITATION_KINDS: Record<string, string> = {
  note: "note",
  textElement: "text",
  path: "path",
  shape: "shape",
  image: "image",
  // Not a canvas element. A comment citation opens its thread rather than
  // selecting a shape, so the board screen branches on this kind — but it is
  // still a placeable, tappable citation, which is what matters here.
  comment: "comment",
};

/** The citation kinds that name a canvas element (so `boxOfElement` can resolve
 *  them). `"comment"` is deliberately absent: a comment thread is real and
 *  citable, but it is not on the canvas and must be resolved a different way.
 *
 *  The board screen branches on this list rather than on a literal, so a kind
 *  it cannot place falls through to an explicit "can't resolve" instead of
 *  being handed to `boxOfElement`, which would report it deleted. That makes
 *  this constant load-bearing rather than documentation — if `"comment"` ever
 *  drifted onto it, every comment citation would read as deleted. */
export const CANVAS_CITATION_KINDS = ["path", "shape", "text", "image", "note"];

/** The canvas kind for a citation, or `null` for a kind this build cannot
 *  place. Null means "don't offer this as clickable" — never "try them all",
 *  which would match the wrong element whenever two kinds shared an id. */
export function citationKind(elementType: string): string | null {
  return CITATION_KINDS[elementType] ?? null;
}

interface AskBoardCallableRequest {
  boardId: string;
  question: string;
  history?: BoardQaTurn[];
}

/**
 * Asks a question about a board and returns the answer plus the elements it
 * cites (Month 6).
 *
 * `history` is the panel's own in-memory thread, replayed so a follow-up like
 * "why?" resolves. The server bounds how much of it it is willing to pay to
 * replay, so sending a long thread costs the caller nothing extra — the bound
 * is not this module's to enforce and must not be duplicated here, where a
 * patched bundle would ignore it anyway.
 *
 * Preserves `.code` AND `.details` on a rejection. `askBoard` attaches
 * `details: { reason: "rate-limit" | "plan-quota" }` at every
 * `resource-exhausted` throw site, and callers route on
 * `quotaService.resourceExhaustedReason(err)` rather than inferring the reason
 * from the workspace's plan the way the four M4 callables' callers have to.
 * Dropping `.details` here would silently demote this callable to that older,
 * guessier behaviour — a free-tier user who merely asked twice quickly would be
 * shown an upgrade prompt.
 */
export async function askBoard(
  boardId: string,
  question: string,
  history: BoardQaTurn[] = []
): Promise<BoardQaAnswer> {
  const callable = httpsCallable<AskBoardCallableRequest, BoardQaAnswer>(
    functions,
    "askBoard"
  );

  try {
    const { data } = await callable({ boardId, question, history });
    return {
      answer: data?.answer ?? "",
      // Readers tolerate missing fields: an answer with no citations is a real
      // outcome (nothing on the board matched), not a malformed response.
      citations: Array.isArray(data?.citations) ? data.citations : [],
      model: data?.model ?? "",
    };
  } catch (e: any) {
    throw Object.assign(new Error(e?.message ?? "Couldn't answer that question."), {
      code: e?.code,
      details: e?.details,
    });
  }
}
