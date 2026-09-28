import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { OpenAIProvider, OpenAIEmbeddingProvider } from "../ai/openai";
import {
  buildBoardQaMessages,
  boundHistory,
  parseCitedIds,
  stripCitationMarkers,
  MAX_QUESTION_CHARS,
  RETRIEVAL_TOP_K,
  type RetrievedChunk,
} from "../ai/boardQaPrompt";
import { consumeToken, type BucketConfig } from "../ai/rateLimit";
import { recordAiUsage, checkFeatureQuota, estimateCostUsd } from "../ai/usage";
import { resolveBoardAccess, type BoardAccess } from "../lib/board";
import { OPENAI_API_KEY } from "../config";
import type { AIProvider, ChatUsage } from "../ai/provider";
import { SESSION_ELEMENT_TYPE, type EmbeddingProvider } from "../ai/embeddings";

// Month 6 — board Q&A retrieval + chat: the READ half of the embeddings the
// element-write trigger maintains. Reads `boards/{boardId}/embeddings`, which
// has no match block in firestore.rules and is denied to every client by the
// file-level default deny. That is not an oversight to work around — it is the
// design. Retrieval runs here, on the Admin SDK, and what goes back to the
// client is an answer plus the element ids it was drawn from. A raw 1536-float
// vector never leaves the function, so there is no client read to grant.
//
// WHY THIS CALLABLE IS SHAPED MORE DEFENSIVELY THAN THE OTHERS. Every other AI
// callable in this directory is triggered by a person clicking a button on a
// selection they made: summaries fire once per session, OCR and explain once
// per selection. A question fires as often as someone types one, over content
// that is already indexed, with nothing to memoize against (two people asking
// the same board the same question in different words share no cache key). It
// is the feature ROADMAP.md names as the first UNBOUNDED one and the reason it
// asks for both of the following, not either:
//
//   1. ITS OWN RATE BUCKET, tighter than the shared one — `QA_BUCKET` below,
//      under its own key so the tighter capacity is not fighting the shared
//      bucket's document (see `qaBucketKey`).
//   2. ITS OWN PLAN ROW — `boardQaPerPeriod` (functions/src/billing/limits.ts),
//      checked alongside the workspace-wide `aiCallsPerPeriod` cap by
//      `checkFeatureQuota`, so a per-feature allowance is never a route around
//      the cap every other AI callable honours.
//
// GATES RUN BEFORE ANY SPENDING. Rate limit, then plan quota, then the question
// embed, then retrieval, then generation. Both paid calls are downstream of
// both gates: a workspace over its quota costs nothing at all, not "one
// embedding's worth of nothing".
//
// `details: { reason }` ON EVERY `resource-exhausted` THROW. Both throw sites
// below carry it, from the start. The four M4 AI callables throw that code for
// a transient throttle and for a plan cap with nothing to tell them apart, so
// their clients have to infer the reason from the workspace's plan; a free-tier
// user who merely clicked twice quickly gets shown an upgrade prompt. The
// flashcard callable was the first to close that, and its client routes on the
// field rather than guessing. src/services/boardQaService.ts does the same.
//
// CITATIONS ARE VERIFIED BEFORE THEY ARE OFFERED — see `liveChunks` below.
//
// SESSION SUMMARIES ARE IN SCOPE; TRANSCRIPTS ARE NOT. ROADMAP.md scopes this
// chat over "board content + session history + comments". All three are now
// indexed — session summaries by triggers/sessionEmbeddings.ts, which writes
// them into the asking board's own `embeddings` subcollection so they come back
// from the same `findNearest` as everything else. What is deliberately NOT
// indexed is the raw transcript or the `canvasSnapshot`; see that trigger's
// header for why that is a decision rather than an unfinished edge.
//
// ⚠️ AND THIS IS WHY THE LIVENESS CHECK BELOW BECAME A VISIBILITY CHECK.
//
// Every other indexed kind lives UNDER the asking board, and the board
// membership check above is therefore the whole of its access control: if you
// may ask, you may already read every note, stroke and comment that could come
// back. A SESSION IS NOT UNDER THE BOARD, and its read rule is a different
// predicate over different fields (firestore.rules' `match /sessions/...` —
// creator, participant, workspace member, or any signed-in user when the
// session carries a joinCode).
//
// Those two predicates CAN disagree, in the dangerous direction. The concrete
// case is a LEGACY board: `isBoardMember` requires `uid in board.members` and
// `inBoardWorkspace(board)`, and `inBoardWorkspace` is satisfied outright when
// the board has no `workspaceId` — so a member of a legacy board need not be in
// any workspace at all. A session on that board inherits `""` (or nothing), and
// `isMemberOfWorkspace('')` is false by construction, so unless that person is
// the creator, a participant, or the session carries a joinCode, THEY CANNOT
// READ THAT SESSION. The same divergence opens whenever a session's stored
// `workspaceId` is not the board's current one.
//
// Board membership is therefore NOT a safe proxy for session readership, and
// answering from a session summary on the strength of board membership alone
// would disclose it to someone the rules refuse. So the per-candidate check
// below applies the NARROWER gate: for a session chunk it re-derives the rules'
// own read predicate against the asking uid, and a chunk that fails is dropped
// BEFORE it becomes context — not merely before it becomes a citation. Dropping
// it later would be worthless: the answer would already have been written from
// content this caller may not see.
//
// SESSION CHUNKS ARE NOT CITED. They ground the answer but are filtered out of
// the returned citations — see `citations` below for that decision.

/** Feature key for cost telemetry. The usage page groups `byFeature` off
 *  whatever keys it finds, so this name is all that is needed for board Q&A to
 *  appear there. */
export const BOARD_QA_FEATURE = "boardQa";

/**
 * This feature's rate bucket — deliberately tighter than `DEFAULT_BUCKET` on
 * BOTH axes (30 burst / 1 per 30s ≈ 120/hour there; 8 burst / 1 per 60s ≈
 * 60/hour here).
 *
 * The burst matters more than the sustained rate. A shared bucket's 30-token
 * burst is sized for a person clicking AI buttons; a chat box in front of an
 * impatient user generates bursts a button never does, and each one costs a
 * question-embed plus a retrieval-sized completion. Eight in flight is
 * generous for someone genuinely reading the answers.
 */
export const QA_BUCKET: BucketConfig = {
  capacity: 8,
  refillPerSec: 1 / 60,
};

/**
 * The rate-limit bucket key for board Q&A, derived from the workspace (or the
 * solo/legacy fallback) but deliberately a DIFFERENT key.
 *
 * This is not cosmetic. `consumeToken` stores every bucket at
 * `workspaces/{bucketKey}/aiRate/bucket`, so passing `QA_BUCKET`'s tighter
 * config with the SHARED key would not create a second bucket — it would apply
 * a capacity of 8 to the same document summaries and OCR refill to 30, and the
 * two configs would clamp each other's state on alternate calls. A distinct key
 * is what makes "its own bucket" actually its own. The `:boardQa` suffix makes
 * a synthetic document id, the same technique as the existing `solo-{uid}`
 * fallback: not a real workspace, just a bucket address.
 */
export function qaBucketKey(base: string): string {
  return `${base}:boardQa`;
}

/**
 * Element type (as the embedding trigger's extractors stamp it) → the board
 * subcollection that element actually lives in.
 *
 * Exported and pinned by tests because it is the whole basis of the liveness
 * check below: point it at the wrong collection and every citation reads as
 * deleted (or, worse, every deleted one reads as live) while nothing else in
 * the system changes shape. Keys mirror the `elementType` values written by
 * the trigger that writes these embeddings; values mirror the subcollections
 * firestore.rules names.
 */
export const ELEMENT_COLLECTIONS: Record<string, string> = {
  note: "notes",
  textElement: "textElements",
  path: "paths",
  shape: "shapes",
  image: "images",
  // Not a canvas element — a comment thread, which ROADMAP.md's board Q&A
  // scope names alongside board content. Its liveness read works identically:
  // one document under the board, which either still exists or does not.
  comment: "comments",
  // `session` is deliberately ABSENT. A session is a top-level document, not a
  // subcollection of the board, so there is no value that could go here — and a
  // session chunk needs a readership check no board subcollection needs. It is
  // branched on explicitly in `makeAskBoardDeps` below, before this map is ever
  // consulted. Adding it here would silently route a session at
  // `boards/{boardId}/sessions/{id}`, which does not exist, so every session
  // chunk would drop and the feature would look merely broken rather than
  // wrong — which is how it would survive review.
};

/** The subcollection for `elementType`, or `null` when it is one this build
 *  does not know. Unknown fails CLOSED (the candidate is dropped, never cited)
 *  rather than guessing a path: an unverifiable citation is exactly what this
 *  check exists to keep off the screen. A new embeddable element kind — audio
 *  transcripts are the expected next one — must be added here to be citable,
 *  and the log line below is how that gets noticed.
 *
 *  Not consulted for `SESSION_ELEMENT_TYPE`; see `ELEMENT_COLLECTIONS`. */
export function collectionForElementType(elementType: string): string | null {
  return ELEMENT_COLLECTIONS[elementType] ?? null;
}

/**
 * Whether `uid` may read `sessions/{sessionId}` — a server-side re-derivation
 * of the read rule in firestore.rules' `match /sessions/{sessionId}` block.
 *
 * ⚠️ THIS MUST MIRROR THAT RULE. The Admin SDK bypasses security rules, so this
 * function IS the enforcement for anything retrieval surfaces out of a session.
 * The rule's four disjuncts, in the order it writes them:
 *   1. `request.auth.uid == resource.data.createdById`
 *   2. `request.auth.uid in resource.data.participantIds`
 *   3. `isMemberOfWorkspace(resource.data.get('workspaceId', null))`
 *   4. `resource.data.joinCode != null`
 *
 * Disjunct 4 is the surprising one and is mirrored faithfully rather than
 * quietly tightened: a session carrying a joinCode is readable by ANY signed-in
 * user, because that is what makes join-by-code work. Tightening it here would
 * mean refusing to answer from a summary the asker could read by opening the
 * session, which is a worse kind of wrong than it looks — the answer would be
 * silently incomplete with nothing on screen to say so. If that disjunct is
 * ever narrowed in the rules, narrow it here in the same commit.
 *
 * Ordered cheapest-first: three checks against the session document already in
 * hand before the workspace read, which is the only extra round trip.
 */
export async function sessionReadableBy(
  db: Firestore,
  uid: string,
  sessionId: string
): Promise<boolean> {
  const snap = await db.doc(`sessions/${sessionId}`).get();
  // A deleted session is also an unreadable one, so this doubles as the
  // liveness check the other kinds get from their own existence read.
  if (!snap.exists) return false;
  const data = snap.data() as {
    createdById?: unknown;
    participantIds?: unknown;
    workspaceId?: unknown;
    joinCode?: unknown;
  };

  if (data.createdById === uid) return true;
  if (Array.isArray(data.participantIds) && data.participantIds.includes(uid)) return true;
  // Rules read a missing map key as null, so "present and not null" is the
  // faithful reading of `joinCode != null` — including a joinCode of "".
  if (data.joinCode !== undefined && data.joinCode !== null) return true;

  // `isMemberOfWorkspace` requires a workspace id that is neither null nor the
  // empty string, which is exactly the legacy/migration-tolerant case
  // (`Session.workspaceId` is `""` or absent on a pre-Phase-4 session). That
  // case is a DENIAL here, not a fallback to the board's workspace: falling
  // back would grant precisely the access the rules refuse.
  const workspaceId = typeof data.workspaceId === "string" ? data.workspaceId : "";
  if (!workspaceId) return false;

  const ws = await db.doc(`workspaces/${workspaceId}`).get();
  if (!ws.exists) return false;
  const members = (ws.data() as { members?: Record<string, unknown> }).members;
  return !!members && Object.prototype.hasOwnProperty.call(members, uid);
}

export interface AskBoardRequest {
  boardId: string;
  question: string;
  /** Prior turns in this thread, replayed by the client so a follow-up
   *  resolves. Bounded server-side (`boundHistory`) — it is client input. */
  history?: { role: "user" | "assistant"; text: string }[];
}

/** One element the answer was drawn from. `elementType` travels with the id
 *  because the client needs it to resolve the id back to a canvas element (the
 *  ids are only unique within their own subcollection). */
export interface BoardQaCitation {
  elementId: string;
  elementType: string;
  /** A short piece of the element's indexed text, so the citation is readable
   *  before the user taps it. */
  excerpt: string;
}

export interface AskBoardResponse {
  answer: string;
  citations: BoardQaCitation[];
  model: string;
}

/**
 * Everything this handler touches outside itself, injected so the whole
 * decision path — every gate, both provider calls, the liveness filter — is
 * unit-testable without Firestore, OpenAI or the Functions runtime.
 */
export interface AskBoardDeps {
  resolveAccess(boardId: string, uid: string): Promise<BoardAccess | null>;
  consumeToken(bucketKey: string, now: number): Promise<boolean>;
  /** `checkFeatureQuota` for `boardQaPerPeriod` — the plan gate. */
  checkQuota(workspaceId: string, now: number): Promise<boolean>;
  /** Nearest indexed elements on THIS board. The board filter is the
   *  subcollection path itself, not a `where()`. */
  findNearest(boardId: string, vector: number[], limit: number): Promise<RetrievedChunk[]>;
  /**
   * Whether a retrieved candidate may become context for THIS caller: its
   * source still exists, AND this uid is entitled to read it.
   *
   * It was `elementExists(boardId, elementType, elementId)` while every indexed
   * kind lived under the board, where membership (already checked) settled
   * readability and existence was the only open question. Session summaries
   * broke that: they are indexed under the board but gated by the session's own
   * read rule, which board membership does not imply. Renamed rather than
   * quietly given a uid, because the OLD NAME WOULD HAVE LIED — a reader
   * checking "is this filter enough?" against a function called `elementExists`
   * would correctly conclude it is not an access check.
   */
  chunkVisibleTo(
    uid: string,
    boardId: string,
    elementType: string,
    elementId: string
  ): Promise<boolean>;
  /** Turns the question into a query vector. */
  embedder: EmbeddingProvider;
  /** Answers from the retrieved context. */
  provider: AIProvider;
  recordUsage(params: {
    workspaceId: string;
    uid: string;
    feature: string;
    model: string;
    usage: ChatUsage;
    flatCostUsd: number;
    now: number;
  }): Promise<void>;
}

/**
 * What the user sees when retrieval comes back with nothing usable. Phrased as
 * an answer, not an error: an empty or newly-created board genuinely has
 * nothing to answer from, and that is not a failure.
 *
 * It names what IS and IS NOT searched, deliberately. ROADMAP.md scopes this
 * chat over "board content + session history + comments"; all three are indexed
 * now, but what is indexed from a session is its SUMMARY, never the transcript
 * or the canvas snapshot (see triggers/sessionEmbeddings.ts for why that is a
 * decision). Someone who asks about something SAID in a session, and gets a
 * bare "I couldn't find anything", would reasonably conclude the feature is
 * broken or that the thing was never discussed. Naming the boundary turns a
 * dead end into a usable one.
 *
 * It is also the answer a caller gets when the only matching content was a
 * session they are not entitled to read — see the visibility filter in
 * `handleAskBoard`. That is correct and is why this is phrased as "I couldn't
 * find anything" rather than "there is nothing": it must not distinguish
 * "nothing exists" from "nothing you can see", which would leak the existence
 * of a session to someone the rules deny.
 */
const NO_CONTEXT_ANSWER =
  "I couldn't find anything that answers that. I can read this board's notes, text, transcribed handwriting, comment threads and the summaries of sessions you have access to — but not session recordings or transcripts. Try asking about something on the canvas, in the comments, or in a session summary.";

const MAX_EXCERPT_CHARS = 160;

function excerptOf(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > MAX_EXCERPT_CHARS ? `${clean.slice(0, MAX_EXCERPT_CHARS)}…` : clean;
}

export async function handleAskBoard(
  req: CallableRequest<AskBoardRequest>,
  deps: AskBoardDeps,
  now: number
): Promise<AskBoardResponse> {
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to ask about this board.");
  }

  const { boardId, question, history } = req.data ?? ({} as AskBoardRequest);
  if (!boardId) {
    throw new HttpsError("invalid-argument", "boardId is required.");
  }
  const trimmed = typeof question === "string" ? question.trim() : "";
  if (!trimmed) {
    throw new HttpsError("invalid-argument", "A question is required.");
  }
  if (trimmed.length > MAX_QUESTION_CHARS) {
    throw new HttpsError(
      "invalid-argument",
      `A question can be at most ${MAX_QUESTION_CHARS} characters.`
    );
  }

  const access = await deps.resolveAccess(boardId, uid);
  if (!access) {
    throw new HttpsError("not-found", "Board not found.");
  }
  if (!access.isMember) {
    throw new HttpsError("permission-denied", "You are not a member of this board.");
  }

  // Rate limit BEFORE quota, mirroring every other AI callable's order: a
  // transient throttle is one transaction, a quota check is two reads.
  // Workspace-scoped, with the same solo/legacy per-user fallback the others
  // use so a board with no workspaceId cannot sidestep the limiter — then
  // moved onto this feature's OWN key (see `qaBucketKey`).
  const bucketBase = access.workspaceId || `solo-${uid}`;
  const allowed = await deps.consumeToken(qaBucketKey(bucketBase), now);
  if (!allowed) {
    // Transient. The caller should retry in a moment and must never be shown an
    // upgrade prompt for this — which is what `reason` is for.
    throw new HttpsError(
      "resource-exhausted",
      "Too many questions right now. Please wait a moment and try again.",
      { reason: "rate-limit" }
    );
  }

  // Plan gate. Only meaningful for a real workspace; a solo/legacy board has no
  // plan to cap — the same carve-out every other callable makes, and the same
  // known gap on workspace-less boards.
  if (access.workspaceId) {
    const withinQuota = await deps.checkQuota(access.workspaceId, now);
    if (!withinQuota) {
      // NOT transient — this workspace is out of Q&A questions (or out of AI
      // calls entirely) for the period.
      throw new HttpsError(
        "resource-exhausted",
        "Your workspace has reached its board Q&A limit for this period.",
        { reason: "plan-quota" }
      );
    }
  }

  // ── everything past this point costs money ────────────────────────────────

  const embedded = await deps.embedder.embed(trimmed);
  const embedCostUsd = estimateCostUsd(embedded.model, {
    promptTokens: embedded.usage.promptTokens,
    completionTokens: 0,
    totalTokens: embedded.usage.totalTokens,
  });

  const candidates = await deps.findNearest(boardId, embedded.vector, RETRIEVAL_TOP_K);

  // CITATION LIVENESS AND READER VISIBILITY. A candidate whose source no longer
  // exists — or which THIS caller is not entitled to read — is dropped here,
  // before it becomes context, and so before it can be cited or quoted.
  //
  // The visibility half only bites for session summaries, the one indexed kind
  // whose read rule is not implied by board membership; see this file's header
  // for the concrete divergence and why board membership is not a safe proxy.
  // It is applied at the SAME point as the liveness check, not later, because
  // an answer written from a chunk is a disclosure of that chunk whether or not
  // it is ever cited.
  //
  // This is not belt-and-braces over the deletion-cleanup trigger; it is the
  // half that trigger cannot do. Cleanup is eventually consistent and can fail
  // outright (its own compensating-delete path logs and swallows), so an
  // embedding CAN outlive its element, and the roadmap's whole anti-
  // hallucination mitigation is "cite ids the user can click to verify". A
  // citation that resolves to nothing does not merely disappoint — it is
  // indistinguishable, to the person who clicks it, from the model having made
  // the content up. Dropping the chunk also keeps deleted content from
  // reaching the model at all, which is the stronger property: a user who
  // deletes a note should not find the answer still quoting it.
  //
  // Sequential rather than `Promise.all`: at most `RETRIEVAL_TOP_K` reads, and
  // the ordering keeps the retrieval rank stable for the context block.
  const liveChunks: RetrievedChunk[] = [];
  for (const candidate of candidates) {
    if (await deps.chunkVisibleTo(uid, boardId, candidate.elementType, candidate.elementId)) {
      liveChunks.push(candidate);
    }
  }

  // Metering is the same shape on both exits below: ONE `recordAiUsage` per
  // question. The workspace-wide `calls` counter and the `boardQaPerPeriod`
  // counter both read it, and both should mean "questions asked" — a question
  // that quietly cost two calls because retrieval needs an embed would make a
  // free tier of 3 mean 1. The embed's cost is not dropped for that: it is
  // folded into `flatCostUsd`, so the dollar figure on the usage page stays
  // whole even though the token counters only carry the completion call's.
  const meter = async (model: string, usage: ChatUsage, costUsd: number) => {
    if (!access.workspaceId) return; // solo/legacy board: no workspace to meter under.
    try {
      await deps.recordUsage({
        workspaceId: access.workspaceId,
        uid,
        feature: BOARD_QA_FEATURE,
        model,
        usage,
        flatCostUsd: costUsd,
        now,
      });
    } catch (err) {
      // Telemetry must never fail a call the user already paid for.
      logger.error("aiUsage telemetry write failed", {
        boardId,
        feature: BOARD_QA_FEATURE,
        err,
      });
    }
  };

  if (liveChunks.length === 0) {
    // No chat call — there is nothing to ground an answer in, and asking a
    // model to answer from an empty context is how a hallucination gets made.
    //
    // The embed still happened and is still metered, and it still consumes a
    // question from the period's allowance. That is deliberate: without it, an
    // empty board would be an unmetered embed generator that only the rate
    // limiter stood in front of.
    await meter(
      embedded.model,
      {
        promptTokens: embedded.usage.promptTokens,
        completionTokens: 0,
        totalTokens: embedded.usage.totalTokens,
      },
      embedCostUsd
    );
    return { answer: NO_CONTEXT_ANSWER, citations: [], model: embedded.model };
  }

  const messages = buildBoardQaMessages(trimmed, liveChunks, boundHistory(history));
  const chat = await deps.provider.chat({
    model: "board-qa",
    messages,
    // Two or three sentences plus citation markers — the system prompt asks for
    // brevity and this is the ceiling that makes the ask binding.
    maxTokens: 400,
    // Low: this is an extraction task over supplied excerpts, not a creative one.
    temperature: 0.2,
  });

  if (!chat.text) {
    throw new HttpsError("internal", "AI returned an empty response.");
  }

  await meter(
    chat.model,
    chat.usage,
    estimateCostUsd(chat.model, chat.usage) + embedCostUsd
  );

  const byId = new Map(liveChunks.map((c) => [c.elementId, c]));
  const citedIds = parseCitedIds(chat.text, byId.keys());
  // Fall back to the whole retrieved set when the model cited nothing. The
  // fallback is honest rather than decorative — these ARE the elements the
  // answer was produced from, whether or not the model marked them up — and it
  // means the user always has something to verify against, which is the point
  // of the requirement. It can only ever offer ids already proven live above.
  const citationIds = citedIds.length > 0 ? citedIds : [...byId.keys()];

  // SESSION SUMMARIES ARE NOT CITED — decided, not overlooked.
  //
  // A citation exists to be tapped: the board screen resolves the kind, selects
  // the element, and the user verifies the answer against the thing itself.
  // That is the roadmap's whole anti-hallucination mitigation. A session is not
  // on the canvas and has nothing to select, so there are only three options
  // and two of them are worse:
  //
  //   (a) Ship it as an unknown kind. `citationKind` (boardQaService.ts) returns
  //       null for a type it cannot place and the panel renders a dead chip
  //       reading "Can't open this element" — which, for a citation that is
  //       perfectly real, reads as a bug and hides the excerpt behind it.
  //   (b) Add a `session` canvas kind and route taps to the session recap. That
  //       is a genuine feature (a new branch in the board screen's
  //       `isCitationLive`/`handleSelectCitation`, a navigation away from the
  //       board mid-conversation, and a product call about whether a Q&A answer
  //       should take you off the board at all) and it is not this one.
  //   (c) Answer from the summary and cite the canvas elements the answer also
  //       drew on. That is what this does.
  //
  // The honest cost: an answer grounded ONLY in a session summary comes back
  // with no citations. That is already a supported outcome (`askBoard`'s client
  // treats an empty citation list as real, not malformed) and it is truthful —
  // there is nothing on this board to point at. It is not an invitation to
  // relax the filter; it is the reason (b) is worth doing if session answers
  // turn out to matter.
  const citations: BoardQaCitation[] = citationIds
    .map((id) => byId.get(id)!)
    .filter((chunk) => chunk.elementType !== SESSION_ELEMENT_TYPE)
    .map((chunk) => ({
      elementId: chunk.elementId,
      elementType: chunk.elementType,
      excerpt: excerptOf(chunk.text),
    }));

  const stripped = stripCitationMarkers(chat.text);

  return {
    // A response that was nothing but citation markers strips to "". Showing
    // the raw markers beats showing an empty bubble.
    answer: stripped || chat.text.trim(),
    citations,
    model: chat.model,
  };
}

/**
 * Builds the real Firestore/provider wiring.
 *
 * Exported — not left inline in the `onCall` below — for the same reason the
 * embedding trigger's own dependency factory is: the paths in here are not
 * incidental. `findNearest` must query the board's OWN embeddings
 * subcollection, and `elementExists` must read the collection the candidate's
 * type actually lives in. Point either at the wrong path and the handler still
 * runs, still answers, and silently either cites nothing or cites everything —
 * a behaviour no test of the handler (which sees only the injected functions)
 * could ever catch. So this is pinned directly against a fake Firestore.
 */
export function makeAskBoardDeps(
  db: Firestore,
  provider: AIProvider,
  embedder: EmbeddingProvider
): AskBoardDeps {
  return {
    resolveAccess: (boardId, uid) => resolveBoardAccess(db, boardId, uid),
    consumeToken: (bucketKey, now) => consumeToken(db, bucketKey, now, QA_BUCKET),
    checkQuota: (workspaceId, now) =>
      checkFeatureQuota(db, workspaceId, BOARD_QA_FEATURE, "boardQaPerPeriod", now),
    embedder,
    provider,
    findNearest: async (boardId, vector, limit) => {
      // The board filter IS the path: embeddings live in a subcollection of
      // their own board, so this query can never reach another board's index.
      const snap = await db
        .collection(`boards/${boardId}/embeddings`)
        .findNearest({
          vectorField: "vector",
          queryVector: vector,
          limit,
          // COSINE — the measure the roadmap's retrieval design names, and the
          // right one for OpenAI embeddings, which are not unit-normalised in
          // a way that makes dot product equivalent.
          distanceMeasure: "COSINE",
        })
        .get();

      return snap.docs
        .map((d) => {
          const data = d.data() as { elementType?: unknown; text?: unknown };
          return {
            elementId: d.id,
            // Readers tolerate missing fields; a document written by an older
            // build (or a partial write) must not crash retrieval. An empty
            // type simply fails the liveness lookup and drops out.
            elementType: typeof data?.elementType === "string" ? data.elementType : "",
            text: typeof data?.text === "string" ? data.text : "",
          };
        })
        .filter((c) => c.text.trim().length > 0);
    },
    chunkVisibleTo: async (uid, boardId, elementType, elementId) => {
      // A session summary is the one indexed kind that is NOT under the board,
      // and the one whose readability board membership does not imply. Branched
      // FIRST, before `collectionForElementType` is consulted at all — there is
      // no board subcollection it could resolve to, and the readership check is
      // not an extra on top of an existence check, it subsumes it (a deleted
      // session is unreadable). See `sessionReadableBy` and this file's header.
      if (elementType === SESSION_ELEMENT_TYPE) {
        return sessionReadableBy(db, uid, elementId);
      }
      const collection = collectionForElementType(elementType);
      if (!collection) {
        logger.warn("askBoard: unknown elementType on an embedding, skipping citation", {
          boardId,
          elementType,
        });
        return false;
      }
      // Everything else lives under the board, where the membership check the
      // handler already made is the whole of the access decision — so existence
      // remains the only open question for these kinds.
      const snap = await db.doc(`boards/${boardId}/${collection}/${elementId}`).get();
      return snap.exists;
    },
    recordUsage: ({ workspaceId, uid, feature, model, usage, flatCostUsd, now }) =>
      recordAiUsage(db, {
        workspaceId,
        uid,
        feature,
        model,
        usage,
        flatCostUsd,
        now,
      }).then(() => undefined),
  };
}

export const askBoard = onCall(
  { secrets: [OPENAI_API_KEY] },
  (req: CallableRequest<AskBoardRequest>) => {
    const key = OPENAI_API_KEY.value();
    return handleAskBoard(
      req,
      makeAskBoardDeps(
        getFirestore(),
        new OpenAIProvider(key),
        new OpenAIEmbeddingProvider(key)
      ),
      Date.now()
    );
  }
);
