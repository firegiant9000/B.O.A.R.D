import { onDocumentWritten, onDocumentDeleted } from "firebase-functions/v2/firestore";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import {
  embedElement,
  getStoredEmbedding,
  SESSION_ELEMENT_TYPE,
  type EmbeddingProvider,
} from "../ai/embeddings";
import { OpenAIEmbeddingProvider } from "../ai/openai";
import { consumeToken } from "../ai/rateLimit";
import { checkFeatureOnlyQuota, recordAiUsage } from "../ai/usage";
import {
  handleElementWrite,
  handleElementDeleted,
  type ExtractedElement,
  type EmbeddingTriggerDeps,
  type CleanupDeps,
} from "./embeddings";
import { OPENAI_API_KEY } from "../config";

// Month 6 — board Q&A over SESSION SUMMARIES, the seventh indexed source and
// the first that does not live under `boards/`.
//
// SUMMARIES ONLY. NOT TRANSCRIPTS, NOT `canvasSnapshot`. That is a decision,
// not a stopping point someone should "finish": a summary is an artifact the
// product already generated and already shows the participants on the recap
// screen, while a raw transcript is every word anyone said in the room. Sending
// the second to an embeddings provider is a materially larger privacy surface
// and it was explicitly declined. `Session.canvasSnapshot` is out for a duller
// reason on top of that one: it is a serialized canvas, not prose, and
// embedding it would index markup.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SEPARATE FILE FROM triggers/embeddings.ts
//
// Not a parallel implementation — a second BINDING onto the same machinery.
// Everything that makes the board trigger correct (the hash-skip before any
// spending, the rate-limit and quota gates in that order, the legacy-board
// bucket fallback, the metering carve-out, the write/delete race guard) lives
// in `handleElementWrite`, which this file calls unchanged. Deletion cleanup
// likewise goes through `handleElementDeleted`. What is NOT reused is the part
// that genuinely cannot be:
//
//   `Collection` and both trigger factories in that file are built around the
//   literal path `boards/{boardId}/<collection>/{elementId}`. A Firestore
//   trigger binds a document PATH PATTERN, and `sessions/{sessionId}` has a
//   different shape and a different depth — there is no value of `<collection>`
//   that produces it. Extending the union would make `makeWriteTrigger`,
//   `makeDeleteTrigger` and `makeDeps` each need a "unless it is this one" arm,
//   which is three special cases to save one file.
//
// So: minimum separate path. One extractor, one deps factory, two bindings.
//
// ─────────────────────────────────────────────────────────────────────────
// WHERE THE EMBEDDING GOES, AND WHY THE BOARD PAYS
//
// `boards/{boardId}/embeddings/{sessionId}` — the same collection board element
// embeddings live in, because askBoard's `findNearest` is board-scoped BY PATH
// (that is its whole board filter; see its own comment). An embedding written
// anywhere else would simply never be retrieved.
//
// The session → board resolution needs no lookup: `Session.boardId` is a field
// on the session document itself (src/types/index.ts). Read it.
//
// Metering resolves the workspace from the BOARD, via the same
// `getBoardWorkspaceId` shape the board trigger uses — NOT from
// `Session.workspaceId`. Two reasons, and they agree: the embedding is a board
// artifact and the board's plan is what its index costs against; and
// `Session.workspaceId` is migration-tolerant (legacy sessions carry `""` or
// lack the field), so trusting it would invent a second convention for exactly
// the case the board trigger already answers — `getBoardWorkspaceId` returns
// `""` for a legacy board and `handleElementWrite` buckets that under
// `solo-${authorUid}`. Note that `Session.workspaceId` IS still load-bearing,
// just not here: it is one of the disjuncts the RETRIEVAL-side readership check
// applies (askBoard.ts's `sessionReadableBy`).
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATELY NOT HERE
//
// No readership filter. A session summary is indexed for its board regardless
// of who can read the session, and the gate is applied at RETRIEVAL time
// instead — see askBoard.ts. Filtering here would be wrong in both directions:
// the index is per-board and shared by every asker, so there is no single
// "reader" to filter for at write time, and session readership can change after
// the summary is written (a participant is added, a workspace membership is
// revoked) without the session document's summary text changing at all, which
// means the hash-skip would keep a stale decision forever.

/**
 * A session's summary as indexable text — tolerating BOTH shapes on disk.
 *
 * `Session.summary` is `string | SessionSummary` (src/types/index.ts): sessions
 * summarised before Phase 3 carry a plain string, newer ones carry the
 * structured artifact. This is schema-version tolerance, not a migration in
 * progress — there is no backfill planned and the plain-string form is not
 * going away, so reading only one shape would silently stop indexing every
 * older session.
 *
 * The structured form is flattened to labelled prose rather than JSON. What is
 * embedded is what the retrieval prompt will quote back as a chunk, so it has
 * to read like something a person wrote; `{"tldr":"...","actionItems":[...]}`
 * embeds the punctuation of a data format alongside the words.
 *
 * Returns `""` for anything that is not a usable summary — absent, empty,
 * whitespace, a structured artifact with nothing in any of its four fields, or
 * a shape that is neither (a number, a null, an array). The caller turns that
 * into "index nothing", which is NOT the same as writing an empty embedding: a
 * zero-content vector would match every question weakly and cite a session that
 * says nothing.
 */
export function summaryTextOf(summary: unknown): string {
  if (typeof summary === "string") return summary.trim();
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return "";

  const s = summary as {
    tldr?: unknown;
    actionItems?: unknown;
    decisions?: unknown;
    openQuestions?: unknown;
  };

  const lines: string[] = [];
  if (typeof s.tldr === "string" && s.tldr.trim()) lines.push(s.tldr.trim());

  // Field order mirrors `SessionSummary`'s declaration order, so the joined
  // text — and therefore the content hash — is stable across runs rather than
  // depending on key iteration order. An unstable order would re-embed (and
  // re-bill) a session on every write that changed nothing.
  const sections: Array<[string, unknown]> = [
    ["Action items", s.actionItems],
    ["Decisions", s.decisions],
    ["Open questions", s.openQuestions],
  ];
  for (const [label, value] of sections) {
    if (!Array.isArray(value)) continue;
    const items = value
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => `- ${v.trim()}`);
    if (items.length > 0) lines.push(`${label}:`, ...items);
  }

  return lines.join("\n").trim();
}

/**
 * One session document → the embeddable unit, or `null` when there is nothing
 * to index.
 *
 * `authorUid` is `createdById` — the session's own creator field, NOT `userId`
 * (which a session document does not have). This mirrors the comment
 * extractor's divergence for the same reason: the wrong field name here does
 * not fail, it silently attributes every session's spend to "unknown" and, on a
 * legacy board, collapses every creator's rate limit into one shared bucket.
 */
export function extractSessionSummary(
  sessionId: string,
  data: FirebaseFirestore.DocumentData
): ExtractedElement | null {
  const text = summaryTextOf(data.summary);
  if (!text) return null;
  return {
    element: { id: sessionId, elementType: SESSION_ELEMENT_TYPE, text },
    authorUid:
      typeof data.createdById === "string" && data.createdById ? data.createdById : "unknown",
  };
}

/** The session's board, or `null` when the document does not name one. A
 *  session with no `boardId` has no index to belong to — there is nothing to
 *  resolve a workspace, a plan or a retrieval scope against, so it is skipped
 *  rather than guessed at. */
export function boardIdOf(data: FirebaseFirestore.DocumentData): string | null {
  return typeof data.boardId === "string" && data.boardId ? data.boardId : null;
}

/**
 * Real Firestore wiring for one session's embed. Exported for the same reason
 * `makeDeps` in triggers/embeddings.ts is: the paths are the whole of what
 * could silently go wrong. `elementStillExists` must read the SESSION
 * (`sessions/{sessionId}`, top-level) while `deleteEmbedding` must write under
 * the BOARD (`boards/{boardId}/embeddings/{sessionId}`) — point either at the
 * other's shape and the race guard never fires, with every test still green.
 */
export function makeSessionDeps(
  db: Firestore,
  provider: EmbeddingProvider,
  sessionId: string
): EmbeddingTriggerDeps {
  return {
    // Identical to the board trigger's own: resolved from the BOARD, so a
    // legacy board reads `""` and buckets under `solo-${authorUid}` exactly as
    // a note on that board would. See this file's header.
    getBoardWorkspaceId: async (bId) => {
      const snap = await db.doc(`boards/${bId}`).get();
      if (!snap.exists) return null;
      const workspaceId = snap.data()?.workspaceId;
      return typeof workspaceId === "string" ? workspaceId : "";
    },
    getStoredEmbedding: (bId, elId) => getStoredEmbedding(db, bId, elId),
    consumeToken: (bucketKey, now) => consumeToken(db, bucketKey, now),
    checkQuota: (workspaceId, now) =>
      checkFeatureOnlyQuota(db, workspaceId, "embeddings", "embeddingsPerPeriod", now),
    embed: (bId, element, now) => embedElement(db, bId, element, provider, now),
    recordUsage: ({ workspaceId, uid, model, usage, now }) =>
      recordAiUsage(db, {
        workspaceId,
        uid,
        feature: "embeddings",
        model,
        usage: { promptTokens: usage.promptTokens, completionTokens: 0, totalTokens: usage.totalTokens },
        now,
        // Same pairing as the board trigger: automated spend is reported in
        // full but never charged against the interactive `aiCallsPerPeriod`
        // cap, which is why the gate above is `checkFeatureOnlyQuota`.
        countsTowardAiCap: false,
      }).then(() => undefined),
    // The race guard, mirrored rather than omitted: `embedElement` is a real
    // network round trip, and the session can be deleted while it is in flight.
    // Existence is the right question here, exactly as it is for an element — a
    // RE-SUMMARISATION mid-flight needs no guard, because the write that
    // changed the summary fires this trigger again and the new text's hash
    // differs, so it re-embeds and overwrites. What cannot be recovered from is
    // a delete whose cleanup ran before this write landed.
    elementStillExists: async () => {
      const snap = await db.doc(`sessions/${sessionId}`).get();
      return snap.exists;
    },
    deleteEmbedding: async (bId, elId) => {
      await db.doc(`boards/${bId}/embeddings/${elId}`).delete();
    },
  };
}

export const onSessionWritten = onDocumentWritten(
  { document: "sessions/{sessionId}", secrets: [OPENAI_API_KEY] },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return; // a delete — onSessionDeleted below owns cleanup.

    const { sessionId } = event.params as { sessionId: string };
    const data = after.data() ?? {};

    const boardId = boardIdOf(data);
    if (!boardId) return; // nothing to index this against.

    // Extract BEFORE constructing a provider: a session write is overwhelmingly
    // a lifecycle change (scheduled → active → ended, a participant joining, an
    // agenda edit) that carries no summary at all, and none of those should
    // cost anything. A session that has never been summarised returns null here
    // and nothing further runs — no embedding document is written.
    const extracted = extractSessionSummary(sessionId, data);
    if (!extracted) return;

    const db = getFirestore();
    const provider = new OpenAIEmbeddingProvider(OPENAI_API_KEY.value());
    await handleElementWrite(
      boardId,
      extracted,
      makeSessionDeps(db, provider, sessionId),
      Date.now()
    );
  }
);

/** Deletion cleanup — the paired binding every indexed source has. A surviving
 *  embedding for a deleted session is a retrieval hit (and, if it were citable,
 *  a citation) pointing at a session that no longer exists, and the retrieval
 *  side's own readership check would refuse it anyway, turning it into a chunk
 *  that costs a read on every question and can never be used.
 *
 *  The board id comes from the DELETED document's own data — the only place it
 *  still exists at this point. `onDocumentDeleted` delivers that snapshot; a
 *  session written before `boardId` existed, or a partial document, simply has
 *  no embedding to clean up. */
export const onSessionDeleted = onDocumentDeleted("sessions/{sessionId}", async (event) => {
  const { sessionId } = event.params as { sessionId: string };
  const boardId = boardIdOf(event.data?.data() ?? {});
  if (!boardId) {
    logger.warn("session embeddings: deleted session names no board, nothing to clean up", {
      sessionId,
    });
    return;
  }
  const db = getFirestore();
  const deps: CleanupDeps = {
    deleteEmbedding: async (bId, elId) => {
      await db.doc(`boards/${bId}/embeddings/${elId}`).delete();
    },
  };
  await handleElementDeleted(boardId, sessionId, deps);
});
