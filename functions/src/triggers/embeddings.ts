import { onDocumentWritten, onDocumentDeleted } from "firebase-functions/v2/firestore";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import {
  embedElement,
  getStoredEmbedding,
  contentHashFor,
  type BoardElementInput,
  type EmbeddingProvider,
  type EmbedOutcome,
  type StoredEmbedding,
} from "../ai/embeddings";
import { OpenAIEmbeddingProvider } from "../ai/openai";
import { consumeToken } from "../ai/rateLimit";
import { checkAiQuota, recordAiUsage, hashWorkspaceId } from "../ai/usage";
import { ocrCacheKey, getCachedOcr } from "../ai/ocrCache";
import { OPENAI_API_KEY } from "../config";

// Month 6 — board Q&A embedding write path, the TRIGGER half of
// functions/src/ai/embeddings.ts's memoized write. ROADMAP.md:1048 is
// explicit and binding: "each element gets an embedding on create/update
// VIA CLOUD FUNCTION TRIGGER" — this file is that trigger.
//
// FIVE EXPLICIT BINDINGS, NOT A WILDCARD. A single
// `boards/{boardId}/{collectionId}/{elementId}` binding looks tempting but is
// wrong on three counts: (a) it fires on every OTHER subcollection under a
// board too — ocrCache, flashcardCache, polls/*/votes, comments, reactions,
// aiUsage, aiLog, snapshots, audio, presence, cursors — needing an allowlist
// inside the handler anyway, so the wildcard buys nothing; (b) it fires on
// `embeddings` ITSELF, re-invoking this same trigger against a document
// shaped nothing like an element — a self-feedback loop; (c) it bills an
// invocation for every vote/comment/reaction/tally write on the board, pure
// waste against the spec's own "first unbounded AI feature" warning
// (ROADMAP.md's board Q&A section). So: one binding per canvas-content
// subcollection firestore.rules names (paths/notes/textElements/shapes/
// images — firestore.rules:888-914), built from a shared factory so a SIXTH
// source (Whisper transcripts on audio notes, expected next per the
// roadmap) is a one-line addition, not a rewrite.
//
// METERING. Every real embed is a paid OpenAI call, and this is the feature
// ROADMAP.md itself flags as the one where "one enthusiastic free-tier user
// outspends a paying one." Two things make a TRIGGER different from a
// callable (generateFlashcards.ts, the pattern this mirrors):
//   - No auth context. There is no caller to resolve a workspace from, so the
//     workspace is resolved from the BOARD document instead. A legacy board
//     (no workspaceId) buckets its rate limit per the element's own author
//     uid and skips the plan-quota check entirely — same carve-out
//     generateFlashcards.ts uses for a solo/legacy board, since there is no
//     plan to cap.
//   - No caller to throw an error at. `HttpsError("resource-exhausted", ...,
//     { reason })` (every callable's convention for telling a client which
//     kind of denial it hit) does not apply here — there is no client
//     routing on this path. A denial SKIPS THE EMBED AND LOGS instead. That
//     is the correct direction, not a shortcut: failing closed on SPENDING
//     (never call the paid provider past a limit) rather than on
//     correctness (the next settled edit gets another chance to index; a
//     skipped refresh corrupts nothing).
//
// DEBOUNCE, on top of the hash-skip, not instead of it. `contentHash` is a
// DEDUP, not a debounce: it collapses IDENTICAL re-embeds to zero cost (the
// common case, and genuinely most of the savings), but does nothing for a
// burst of rapid, each-genuinely-DIFFERENT edits — someone typing sentence
// by sentence produces one paid call per autosave flush, because every
// intermediate hash differs from the last. `EMBEDDING_DEBOUNCE_MS` below
// adds a cooldown on top: skip (again, no provider call) when this
// element's last REAL embed was too recent, using the `updatedAt` already
// stored — no new dependency, no Cloud Tasks, no delayed scheduling.
export const EMBEDDING_DEBOUNCE_MS = 20_000;
// Chosen relative to the app's own autosave cadence: `useBoardDocument.ts`'s
// `scheduleSave` debounces the board's `updatedAt` bump at 2000ms, so a burst
// of active edits already produces Firestore writes roughly every couple of
// seconds. 20s is ~10x that: comfortably long enough to coalesce a typing
// burst into roughly one paid embed rather than one per flush, while still
// short enough that a normal pause between sentences or elements reindexes
// well within the timescale board Q&A needs to feel current. KNOWN
// LIMITATION, disclosed rather than hidden: this is a cooldown, not a true
// trailing-edge debounce — if editing stops WHILE an element is inside its
// cooldown window, that final text is not re-embedded until the NEXT write
// to that element (there is no scheduled follow-up call). A true
// trailing-edge debounce would need delayed/cancellable scheduling (Cloud
// Tasks), which conflicts with "no new dependencies"; this is the accepted,
// cheaper tradeoff.

/**
 * Whether to skip attempting an embed for this write — BEFORE spending a
 * rate-limit token or a quota check on a call that would turn out to be a
 * no-op. Two independent reasons to skip:
 *   1. Unchanged content (the same check `embedElement` makes internally —
 *      duplicated here, not shared, because this gate needs the answer
 *      BEFORE metering, while `embedElement`'s own check happens AFTER).
 *   2. Debounced: changed content, but the last REAL embed of this element
 *      was too recent.
 *
 * DELIBERATELY DOES NOT follow this codebase's "deny unless provably under"
 * quota-gate convention (`!(used < limit)`, failing closed toward DENY on
 * corrupt data) for the debounce half of this check. That convention exists
 * because a quota gate is the LAST line of defense against overspend, so
 * corrupt data must fail toward the safe (denying) side. This gate is not a
 * spend gate — `consumeToken`/`checkAiQuota` downstream of it are, and they
 * apply regardless of what this function decides. So a corrupt/non-finite
 * `updatedAt` here fails toward ATTEMPT, not skip: attempting is
 * self-healing (a successful embed overwrites the corrupt `updatedAt` with a
 * fresh valid one, via `embedElement`) and cannot cause overspend (the real
 * spend gates still run right after); skipping on corrupt data would not
 * self-heal anything — it would silently stop re-indexing that element
 * FOREVER, since a skip never writes a fresh `updatedAt` either. See this
 * function's own tests for the RED-check that confirms the direction.
 */
export function shouldSkipEmbedAttempt(
  stored: StoredEmbedding | null,
  text: string,
  now: number,
  debounceMs: number = EMBEDDING_DEBOUNCE_MS
): boolean {
  if (stored?.contentHash === contentHashFor(text)) {
    return true; // unchanged — embedElement would no-op this anyway.
  }
  if (
    typeof stored?.updatedAt === "number" &&
    Number.isFinite(stored.updatedAt) &&
    now - stored.updatedAt < debounceMs
  ) {
    return true; // too soon since the last REAL embed of this element.
  }
  return false; // no stored doc yet, corrupt/missing updatedAt, or past the cooldown — attempt.
}

/** One canvas-content element's extracted embeddable content, plus its
 *  author — a trigger has no auth context, so the element's own `userId`
 *  stands in for a caller uid: it's the closest identity available, used
 *  only for the rate-limit bucket fallback (legacy boards) and the usage
 *  log's `uid` field. */
export interface ExtractedElement {
  element: BoardElementInput;
  authorUid: string;
}

type ElementExtractor = (
  db: Firestore,
  boardId: string,
  elementId: string,
  data: FirebaseFirestore.DocumentData
) => Promise<ExtractedElement | null>;

function authorOf(data: FirebaseFirestore.DocumentData): string {
  return typeof data.userId === "string" && data.userId ? data.userId : "unknown";
}

const extractNote: ElementExtractor = async (_db, _boardId, elementId, data) => {
  const content = typeof data.content === "string" ? data.content : "";
  if (!content.trim()) return null;
  return { element: { id: elementId, elementType: "note", text: content }, authorUid: authorOf(data) };
};

const extractTextElement: ElementExtractor = async (_db, _boardId, elementId, data) => {
  const text = typeof data.text === "string" ? data.text : "";
  if (!text.trim()) return null;
  return { element: { id: elementId, elementType: "textElement", text }, authorUid: authorOf(data) };
};

// `paths`/`shapes`/`images` carry no native text field (`DrawPath`,
// `ShapeElement`, `ImageElement` in src/types/index.ts — geometry and
// storage metadata only, never a text/label property). A single STROKE's
// transcription, once run, already lands as a NEW `textElements` document
// instead (`useBoardAI.ts`'s `recognizeText`/`acceptOcr` → `placeOcrText`),
// which `extractTextElement` above already embeds — duplicating that text
// onto the stroke's own embedding would double-index the same words under
// two ids, not add coverage.
//
// `extractPath` still makes ONE narrow, real (not fabricated) attempt:
// `ocrCache` is keyed by a hash of the OCR'd SELECTION's path ids
// (`ocrCacheKey`, ocrCache.ts). When that selection was a SINGLE stroke,
// `ocrCacheKey([elementId])` reproduces the exact same key deterministically
// — a genuine cache hit. It cannot do this for a multi-stroke selection (the
// common case for a handwritten sentence or word): there is no way to
// reverse-derive "which OTHER path ids were in the selection that produced
// this cache entry" from just this one path's own id. This under-covers
// multi-stroke transcriptions (only reachable via `textElements` above) but
// never double-counts or guesses.
const extractPath: ElementExtractor = async (db, boardId, elementId, data) => {
  const key = ocrCacheKey([elementId]);
  const cached = await getCachedOcr(db, boardId, key);
  if (!cached || !cached.text.trim()) return null;
  return { element: { id: elementId, elementType: "path", text: cached.text }, authorUid: authorOf(data) };
};

// No OCR or captioning runs against a whole SHAPE or IMAGE element today
// (OCR runs only against a user-selected STROKE region — useBoardAI.ts —
// never a shape or an image), and neither type carries a text field to
// begin with. Explicit no-op extractors (not simply omitted bindings) so the
// five bindings below stay exactly the element-subcollection set
// firestore.rules names, ready to gain a real extractor the moment one of
// these sources gains embeddable text. Audio transcripts (Whisper,
// ROADMAP.md) are expected to join this set NEXT, as a SIXTH binding — this
// list is not written to calcify as exhaustive.
const extractShape: ElementExtractor = async () => null;
const extractImage: ElementExtractor = async () => null;

type Collection = "notes" | "textElements" | "paths" | "shapes" | "images";

const EXTRACTORS: Record<Collection, ElementExtractor> = {
  notes: extractNote,
  textElements: extractTextElement,
  paths: extractPath,
  shapes: extractShape,
  images: extractImage,
};

/**
 * Injected so the trigger's real work unit-tests without Firestore or the
 * Functions runtime — mirrors the `PollTallyDeps` split in pollTally.ts.
 */
export interface EmbeddingTriggerDeps {
  /** `null` when the board doc itself is gone (deleted mid-flight); `""` for
   *  a real legacy board with no `workspaceId`. */
  getBoardWorkspaceId(boardId: string): Promise<string | null>;
  getStoredEmbedding(boardId: string, elementId: string): Promise<StoredEmbedding | null>;
  consumeToken(bucketKey: string, now: number): Promise<boolean>;
  checkAiQuota(workspaceId: string, now: number): Promise<boolean>;
  embed(boardId: string, element: BoardElementInput, now: number): Promise<EmbedOutcome>;
  recordUsage(params: {
    workspaceId: string;
    uid: string;
    model: string;
    usage: { promptTokens: number; totalTokens: number };
    now: number;
  }): Promise<void>;
}

/**
 * The trigger's real work for one element write, independent of the
 * firebase-functions event shape — mirrors `handlePollVoteWrite`'s split in
 * pollTally.ts. `extracted` is never null here (a binding that extracted
 * nothing returns before ever calling this — see `makeWriteTrigger` below),
 * so this function only ever deals with genuinely embeddable content.
 */
export async function handleElementWrite(
  boardId: string,
  extracted: ExtractedElement,
  deps: EmbeddingTriggerDeps,
  now: number
): Promise<void> {
  const { element, authorUid } = extracted;

  const workspaceId = await deps.getBoardWorkspaceId(boardId);
  if (workspaceId === null) {
    // The board itself is gone (deleted mid-flight, between the element
    // write landing and this trigger running) — nothing to resolve a plan
    // or a rate-limit bucket against, and the element's own board no longer
    // exists to index for.
    logger.warn("embeddings trigger: board missing, skipping", { boardId });
    return;
  }

  const stored = await deps.getStoredEmbedding(boardId, element.id);
  if (shouldSkipEmbedAttempt(stored, element.text, now)) {
    return; // unchanged content, or too soon since the last real embed — free.
  }

  // Rate limit BEFORE quota, mirroring generateFlashcards.ts's own order: a
  // transient throttle is cheaper to check than a Firestore quota read.
  // Legacy (no-workspace) boards bucket per AUTHOR, the closest thing to a
  // caller identity a trigger has (mirrors generateFlashcards' `solo-${uid}`
  // fallback).
  const bucketKey = workspaceId || `solo-${authorUid}`;
  const allowed = await deps.consumeToken(bucketKey, now);
  if (!allowed) {
    // No caller to throw a `resource-exhausted` at — skip and log instead.
    // This IS the correct direction: fail closed on SPENDING (never call the
    // paid provider while throttled), not on correctness. `details: {
    // reason }` (every callable's convention for telling a client which
    // kind of denial it hit) does not apply — there is no client routing on
    // this path.
    logger.warn("embeddings trigger: rate-limited, skipping embed", {
      boardId,
      elementId: element.id,
    });
    return;
  }

  // Plan quota gate — only meaningful for a real workspace; a legacy board
  // has no plan to cap (same carve-out as generateFlashcards.ts).
  if (workspaceId) {
    const withinQuota = await deps.checkAiQuota(workspaceId, now);
    if (!withinQuota) {
      // Same "skip + log, never throw" direction as the rate limiter above.
      // Hashed workspace id only, never raw (Global Constraint).
      logger.warn("embeddings trigger: over AI quota, skipping embed", {
        workspaceHash: hashWorkspaceId(workspaceId),
        boardId,
        elementId: element.id,
      });
      return;
    }
  }

  const outcome = await deps.embed(boardId, element, now);
  if (!outcome.embedded || !workspaceId || !outcome.model || !outcome.usage) {
    // Either a narrow race with another invocation made this a hash-skip
    // after all, or a legacy board with nothing to meter under — either way,
    // no real provider call happened here that needs recording.
    return;
  }

  try {
    await deps.recordUsage({
      workspaceId,
      uid: authorUid,
      model: outcome.model,
      usage: outcome.usage,
      now,
    });
  } catch (err) {
    // A telemetry write must never undo an embed that already happened and
    // was already paid for — log and swallow, mirroring generateFlashcards'
    // own recordAiUsage try/catch.
    logger.error("embeddings trigger: usage telemetry write failed", { boardId, err });
  }
}

function makeDeps(db: Firestore, provider: EmbeddingProvider): EmbeddingTriggerDeps {
  return {
    getBoardWorkspaceId: async (boardId) => {
      const snap = await db.doc(`boards/${boardId}`).get();
      if (!snap.exists) return null;
      const workspaceId = snap.data()?.workspaceId;
      return typeof workspaceId === "string" ? workspaceId : "";
    },
    getStoredEmbedding: (boardId, elementId) => getStoredEmbedding(db, boardId, elementId),
    consumeToken: (bucketKey, now) => consumeToken(db, bucketKey, now),
    checkAiQuota: (workspaceId, now) => checkAiQuota(db, workspaceId, now),
    embed: (boardId, element, now) => embedElement(db, boardId, element, provider, now),
    recordUsage: ({ workspaceId, uid, model, usage, now }) =>
      recordAiUsage(db, {
        workspaceId,
        uid,
        feature: "embeddings",
        model,
        usage: { promptTokens: usage.promptTokens, completionTokens: 0, totalTokens: usage.totalTokens },
        now,
      }).then(() => undefined),
  };
}

function makeWriteTrigger(collection: Collection) {
  const extractor = EXTRACTORS[collection];
  return onDocumentWritten(
    { document: `boards/{boardId}/${collection}/{elementId}`, secrets: [OPENAI_API_KEY] },
    async (event) => {
      const after = event.data?.after;
      if (!after?.exists) return; // a delete — the paired onDocumentDeleted below owns cleanup.

      const { boardId, elementId } = event.params as { boardId: string; elementId: string };
      const db = getFirestore();

      const extracted = await extractor(db, boardId, elementId, after.data() ?? {});
      if (!extracted) return; // nothing embeddable in this write.

      const provider = new OpenAIEmbeddingProvider(OPENAI_API_KEY.value());
      await handleElementWrite(boardId, extracted, makeDeps(db, provider), Date.now());
    }
  );
}

export const onNoteWritten = makeWriteTrigger("notes");
export const onTextElementWritten = makeWriteTrigger("textElements");
export const onPathWritten = makeWriteTrigger("paths");
export const onShapeWritten = makeWriteTrigger("shapes");
export const onImageWritten = makeWriteTrigger("images");

// ─────────────────────────────────────────────────────────────────────────
// Deletion cleanup. Board Q&A cites source element ids so a user can click
// through and verify (ROADMAP.md) — a surviving embedding for a deleted
// element is not clutter, it is a citation pointing at nothing. Mirrors
// `handlePollDeleted`'s shape in pollTally.ts exactly: always runs (no skip
// branch), single-doc delete (no batching needed — unlike pollTally's votes
// collection, there is exactly one embedding doc per element, and deleting
// a doc that was never written — paths/shapes/images today — is a harmless
// no-op).

export interface CleanupDeps {
  deleteEmbedding(boardId: string, elementId: string): Promise<void>;
}

export async function handleElementDeleted(
  boardId: string,
  elementId: string,
  deps: CleanupDeps
): Promise<void> {
  await deps.deleteEmbedding(boardId, elementId);
}

function makeCleanupDeps(db: Firestore): CleanupDeps {
  return {
    deleteEmbedding: async (boardId, elementId) => {
      await db.doc(`boards/${boardId}/embeddings/${elementId}`).delete();
    },
  };
}

function makeDeleteTrigger(collection: Collection) {
  return onDocumentDeleted(`boards/{boardId}/${collection}/{elementId}`, async (event) => {
    const { boardId, elementId } = event.params as { boardId: string; elementId: string };
    await handleElementDeleted(boardId, elementId, makeCleanupDeps(getFirestore()));
  });
}

export const onNoteDeleted = makeDeleteTrigger("notes");
export const onTextElementDeleted = makeDeleteTrigger("textElements");
export const onPathDeleted = makeDeleteTrigger("paths");
export const onShapeDeleted = makeDeleteTrigger("shapes");
export const onImageDeleted = makeDeleteTrigger("images");
