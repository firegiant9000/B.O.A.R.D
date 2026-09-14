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
import { checkFeatureOnlyQuota, recordAiUsage, hashWorkspaceId } from "../ai/usage";
import { ocrCacheKey, getCachedOcr } from "../ai/ocrCache";
import { OPENAI_API_KEY } from "../config";

// Month 6 — board Q&A embedding write path, the TRIGGER half of
// functions/src/ai/embeddings.ts's memoized write. ROADMAP.md:1048 is
// explicit and binding: "each element gets an embedding on create/update
// VIA CLOUD FUNCTION TRIGGER" — this file is that trigger.
//
// SIX SOURCES, TWELVE EXPLICIT BINDINGS, NOT A WILDCARD. A single
// `boards/{boardId}/{collectionId}/{elementId}` binding looks tempting but is
// wrong on three counts: (a) it fires on every OTHER subcollection under a
// board too — ocrCache, flashcardCache, polls/*/votes, reactions, aiUsage,
// aiLog, snapshots, audio, presence, cursors — needing an allowlist inside the
// handler anyway, so the wildcard buys nothing; (b) it fires on `embeddings`
// ITSELF, re-invoking this same trigger against a document shaped nothing like
// an element — a self-feedback loop; (c) it bills an invocation for every
// vote/reaction/tally write on the board, pure waste against the spec's own
// "first unbounded AI feature" warning (ROADMAP.md's board Q&A section). So:
// explicit bindings, TWO PER SOURCE that actually carries embeddable text —
// a write binding (the `makeWriteTrigger` exports at the end of this file)
// to index the content, and a paired delete binding (the `makeDeleteTrigger`
// exports below those) to drop the embedding when the element goes, since a
// surviving embedding is a citation pointing at nothing (see the
// deletion-cleanup section's own comment). Six sources × two = twelve
// bindings; count the two export blocks rather than trusting this sentence.
//
// The six sources are the five canvas-content subcollections firestore.rules
// names — the `paths`, `notes`, `textElements` and `shapes` blocks under
// `match /boards/{boardId}`, which share one member-read/editor-write gate,
// plus the `images` block just after them, which carries the same read gate
// but denies embed-identity writes — together with `comments`, which
// ROADMAP.md's board Q&A scope ("board content + session history +
// comments") names explicitly. Named by rule block rather than by line
// range on purpose: that citation was a `firestore.rules:888-914` range and
// has now been stale twice over, once from a canvas change and once from a
// security commit, while the block names have never moved.
//
// All twelve are built from two shared factories, so a SEVENTH source
// (Whisper transcripts on audio notes, expected next per the roadmap) is a
// two-line addition — one per factory — not a rewrite. Adding only the write
// half is the mistake to watch for; it is what leaves stale embeddings behind.
//
// Note what changed and what did not: `comments` moved from example (a)'s list
// of things a wildcard would WRONGLY catch into a deliberate binding of its
// own. The wildcard argument is unaffected — the objection was never "comments
// are uninteresting", it was that a wildcard catches everything indiscriminately
// and cannot tell a comment from a cursor position.
//
// METERING. Every real embed is a paid OpenAI call, and this is the feature
// ROADMAP.md itself flags as the one where "one enthusiastic free-tier user
// outspends a paying one."
//
// THIS TRIGGER'S SPEND IS CARVED OUT OF THE INTERACTIVE AI CAP, and gated on a
// row of its own (`embeddingsPerPeriod`) instead. `aiCallsPerPeriod` is what a
// USER spends by asking for something — a summary, an OCR, a question. Counting
// embeds there made a free workspace's five AI calls consumable by ordinary
// note-taking: roughly one editing session exhausted the month, after which
// board Q&A's own displayed limit of 3 questions was unreachable AND this
// trigger's gate denied too, so the index stopped updating — the answers would
// have been stale even if they had been askable. So: `recordUsage` passes
// `countsTowardAiCap: false` (dollars and tokens still accumulate and still
// show on the usage page; only the gated `calls` counter is held back), and the
// gate below is `checkFeatureOnlyQuota`, NOT `checkFeatureQuota`. Those two go
// together — see `RecordUsageParams.countsTowardAiCap` for the pairing rule and
// why gating on a counter this trigger deliberately does not feed would let an
// unrelated summary stop a board from re-indexing.
//
// Two more things make a TRIGGER different from a callable
// (generateFlashcards.ts, the pattern this mirrors):
//   - No auth context. There is no caller to resolve a workspace from, so the
//     workspace is resolved from the BOARD document instead. A legacy board
//     (no workspaceId) buckets its rate limit AND its cost telemetry under
//     `solo-${authorUid}` (a synthetic bucket, not a real workspace — see
//     `bucketKey` below) rather than skipping metering the way
//     generateFlashcards.ts's own solo/legacy carve-out does. THIS IS A
//     DELIBERATE DIVERGENCE from that precedent, not an oversight: a callable
//     needs a human clicking a button per call, but a trigger fires on every
//     write with nobody present — `templateService.applyTemplateToBoard` and
//     onboardingService's seeding both bulk-create notes, so a template
//     applied to a legacy board would otherwise bill OpenAI at bucket rate
//     (~120/hour, ~2,880/day, per author) with no dollar figure anywhere that
//     could ever reveal the spend. Still no PLAN to cap a legacy board
//     against (there is no plan model for solo boards, and inventing one
//     here is not the ask) — only visibility into what it costs. This is the
//     THIRD instance of "a legacy board bypasses a quota gate" on this
//     branch (voice notes' `boardOnPaidPlan`, and the M5 seat cap's own
//     legacy fallback, are the other two) — a known class of gap on
//     workspace-less boards, not a local quirk of this feature.
//   - No caller to throw an error at. `HttpsError("resource-exhausted", ...,
//     { reason })` (every callable's convention for telling a client which
//     kind of denial it hit) does not apply here — there is no client
//     routing on this path. A denial SKIPS THE EMBED AND LOGS instead. That
//     is the correct direction, not a shortcut: failing closed on SPENDING
//     (never call the paid provider past a limit) rather than on
//     correctness (the next settled edit gets another chance to index; a
//     skipped refresh corrupts nothing).
//
// NO COOLDOWN/DEBOUNCE ON TOP OF THE HASH-SKIP — deliberately. An earlier
// version of this file added a time-based cooldown here, justified against
// `useBoardDocument.ts`'s 2000ms `scheduleSave` debounce. That justification
// was wrong: `scheduleSave` debounces the BOARD document's own `updatedAt`
// bump, which none of these twelve bindings watch. The collections this file
// DOES watch are commit-on-finish, not stream-of-keystrokes: `notes` has no
// update function at all (`pathService.saveTextNote` only creates), and
// `textElements` is created with `text: ""` then written ONCE, complete,
// when `commitTextEdit` closes the inline editor. There is no repeated-save
// burst for a single element's text to coalesce here — the one real repeat
// case (dragging/resizing/reordering an element, where the TEXT is
// unchanged) is exactly what the content-hash skip already collapses to
// zero cost, for free. A cooldown on top would only have added a real risk
// with no corresponding benefit: commit a text element, spot a typo,
// re-commit within the window → skipped, and if that element is never
// touched again the index holds the pre-correction text permanently. It
// also would not have addressed this app's actual burst pattern (a template
// import creates N DIFFERENT elements at once) — a cooldown is per-element,
// so every one of the N is a first write and embeds regardless. Removed
// rather than kept with a corrected rationale that would have admitted it
// does nothing.

/** Whether `stored`'s content hash already matches `text` — the memoization
 *  check `embedElement` makes internally, duplicated here (not shared)
 *  because this gate needs the answer BEFORE spending a rate-limit token or
 *  a quota check on a call that would turn out to be a no-op; `embedElement`
 *  makes the same check AFTER, as the thing that actually skips the write. */
export function isContentUnchanged(stored: StoredEmbedding | null, text: string): boolean {
  return stored?.contentHash === contentHashFor(text);
}

/** One canvas-content element's extracted embeddable content, plus its
 *  author — a trigger has no auth context, so the element's own `userId`
 *  stands in for a caller uid: it's the closest identity available, used
 *  only for the rate-limit/telemetry bucket fallback (legacy boards) and
 *  the usage log's `uid` field. */
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

export function authorOf(data: FirebaseFirestore.DocumentData): string {
  return typeof data.userId === "string" && data.userId ? data.userId : "unknown";
}

export const extractNote: ElementExtractor = async (_db, _boardId, elementId, data) => {
  const content = typeof data.content === "string" ? data.content : "";
  if (!content.trim()) return null;
  return { element: { id: elementId, elementType: "note", text: content }, authorUid: authorOf(data) };
};

export const extractTextElement: ElementExtractor = async (_db, _boardId, elementId, data) => {
  const text = typeof data.text === "string" ? data.text : "";
  if (!text.trim()) return null;
  return { element: { id: elementId, elementType: "textElement", text }, authorUid: authorOf(data) };
};

// `paths`/`shapes` carry no native text field (`DrawPath`, `ShapeElement` in
// src/types/index.ts — geometry only, never a text/label property).
// `ImageElement` DOES carry an `alt: string` field. For an ordinary upload it
// is populated from the file's NAME (imageService) — not descriptive text
// about the image's content, so embedding it would not answer a board Q&A
// question. Month 6's camera-capture path (scanService.ts) is a SECOND writer
// of this same field, though: a scanned photo's OCR'd text (when any was
// recognized) lands on its own `alt` too, via imageService.updateImage — see
// scanService.ts's own header. `alt` today conflates both meanings with NO
// discriminator between them, so `extractImage` below still deliberately
// stays a no-op rather than reading `alt` blindly: doing so would index real
// board content for a scan, but would COINCIDENTALLY ALSO index ordinary
// photo filenames for every other image — the exact regression this note
// originally warned against. Giving scanned OCR text real Q&A coverage needs
// (at minimum) a way to tell the two apart, and is a deliberate scope
// decision for whoever next owns board Q&A, not an oversight here. A single
// STROKE's transcription, once run, already
// lands as a NEW `textElements` document instead (`useBoardAI.ts`'s
// `recognizeText`/`acceptOcr` → `placeOcrText`), which `extractTextElement`
// above already embeds — duplicating that text onto the stroke's own
// embedding would double-index the same words under two ids, not add
// coverage.
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
export const extractPath: ElementExtractor = async (db, boardId, elementId, data) => {
  const key = ocrCacheKey([elementId]);
  const cached = await getCachedOcr(db, boardId, key);
  if (!cached || !cached.text.trim()) return null;
  return { element: { id: elementId, elementType: "path", text: cached.text }, authorUid: authorOf(data) };
};

// No captioning runs against a whole SHAPE today, and `extractShape` stays a
// true no-op for it (`ShapeElement` carries no text field at all — see the
// `paths`/`shapes` note above).
//
// A whole IMAGE is different since Month 6: `scanService.ts`'s camera-capture
// path DOES now run OCR against a captured image (via the same
// `recognizeHandwriting` callable `extractPath`'s stroke-selection OCR uses)
// and writes the result onto that image's own `alt` field. `extractImage`
// stays a no-op anyway — not because no such text exists, but because `alt`
// conflates that OCR text with an ordinary upload's filename with no
// discriminator (see the `alt` note above), so reading it here would also
// index every plain photo's filename as if it were board content. That, plus
// sending previously-local OCR text to the embeddings provider, is a real
// data-scope change (see the `comments` extractor's own "WHAT THIS CHANGES
// ABOUT WHERE BOARD DATA GOES" note for the shape such a change should take)
// — a decision for whoever next gives `alt` a real/filename discriminator,
// not a silent side effect of this trigger. Concretely: board Q&A cannot
// today retrieve a scanned page's recognized text ("what did we cover on
// this board" has no path to it) — "snap a page and hit Explain" is
// unaffected, since `explainSelection` sends a screenshot of the selection
// straight to a vision model and never reads `alt`.
//
// Both stay explicit no-op extractors (not simply omitted bindings) so the
// canvas bindings below stay exactly the element-subcollection set
// firestore.rules names, ready to gain a real extractor the moment one of
// these sources gains INDEXABLE embeddable text. Audio transcripts (Whisper,
// ROADMAP.md) are expected to join the binding set NEXT, as a SEVENTH SOURCE
// alongside the five canvas ones and `comments` — and so as the thirteenth
// and fourteenth bindings, since every source carries a write binding and a
// delete binding (see this file's header). This list is not written to
// calcify as exhaustive.
export const extractShape: ElementExtractor = async () => null;
export const extractImage: ElementExtractor = async () => null;

/**
 * Comments — the sixth source, and the first that is not a canvas element.
 *
 * ROADMAP.md's board Q&A scope is "board content + session history +
 * comments", and until this extractor existed a question like "what did we
 * decide in the comments?" could only ever get the no-context answer: the
 * text was never indexed, so retrieval could not reach it.
 *
 * WHAT THIS CHANGES ABOUT WHERE BOARD DATA GOES: comment bodies and reply
 * bodies are now sent to OpenAI's embedding endpoint, as note and text-element
 * content already were. That is not a new class of data leaving the product,
 * but it is a wider and more candid surface — comments are where people write
 * about each other's work, not just about the subject — so it is stated here
 * rather than left to be inferred from the binding list.
 *
 * TWO FIELD NAMES DIVERGE from every extractor above, and both are load-bearing
 * enough to be pinned against the real `Comment` type (src/types/index.ts) by
 * tests rather than assumed:
 *   - the text is `body`, not `content` (notes) or `text` (text elements);
 *   - the author is `authorId`, not `userId` — so `authorOf` (which reads
 *     `userId`) would return "unknown" here, which would misattribute this
 *     spend in the usage log and, on a legacy board, bucket every comment's
 *     rate limit under one synthetic `solo-unknown` key shared by every author.
 *
 * A thread is embedded as ONE unit: the root body plus every reply's body. The
 * replies live in an array ON the comment document (commentService.ts keeps a
 * thread in one doc), so there is no separate document to bind to — and the
 * decision a question is usually reaching for is as likely to be in a reply as
 * in the root. Adding or editing a reply changes the joined text, so the
 * content hash changes and the thread re-embeds; resolving or unresolving one
 * does not, so it stays a free hash-skip.
 */
export const extractComment: ElementExtractor = async (_db, _boardId, elementId, data) => {
  const root = typeof data.body === "string" ? data.body : "";
  const replies = Array.isArray(data.replies)
    ? data.replies
        .map((r: unknown) =>
          r && typeof r === "object" && typeof (r as { body?: unknown }).body === "string"
            ? ((r as { body: string }).body)
            : ""
        )
        .filter((b: string) => b.trim().length > 0)
    : [];

  const text = [root, ...replies].filter((t) => t.trim().length > 0).join("\n");
  if (!text.trim()) return null;

  return {
    element: { id: elementId, elementType: "comment", text },
    // NOT `authorOf` — a comment's author field is `authorId`, not `userId`.
    authorUid:
      typeof data.authorId === "string" && data.authorId ? data.authorId : "unknown",
  };
};

type Collection = "notes" | "textElements" | "paths" | "shapes" | "images" | "comments";

export const EXTRACTORS: Record<Collection, ElementExtractor> = {
  notes: extractNote,
  textElements: extractTextElement,
  paths: extractPath,
  shapes: extractShape,
  images: extractImage,
  comments: extractComment,
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
  /** `checkFeatureOnlyQuota` over `embeddingsPerPeriod` — this trigger's own
   *  plan row, NOT the workspace-wide AI cap. See this file's header. */
  checkQuota(workspaceId: string, now: number): Promise<boolean>;
  embed(boardId: string, element: BoardElementInput, now: number): Promise<EmbedOutcome>;
  recordUsage(params: {
    workspaceId: string;
    uid: string;
    model: string;
    usage: { promptTokens: number; totalTokens: number };
    now: number;
  }): Promise<void>;
  /** Re-reads the ELEMENT's own document (not the embedding doc) — the race
   *  guard in `handleElementWrite` below. Bound to one specific board/
   *  collection/element at construction time (see `makeDeps`), not
   *  parameterized here, since one `EmbeddingTriggerDeps` is already
   *  constructed per invocation for exactly one element. */
  elementStillExists(): Promise<boolean>;
  deleteEmbedding(boardId: string, elementId: string): Promise<void>;
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

  // Checked FIRST, before any board read: a position/resize/z-order write
  // (a drag, a reorder) changes none of these element TYPES' text, so this
  // is the by-far-most-common invocation shape and it should cost nothing
  // but this one read — not also a board-document read that the unchanged
  // hash makes moot immediately afterward.
  const stored = await deps.getStoredEmbedding(boardId, element.id);
  if (isContentUnchanged(stored, element.text)) {
    return; // unchanged content — no board read, no metering, no embed.
  }

  const workspaceId = await deps.getBoardWorkspaceId(boardId);
  if (workspaceId === null) {
    // The board itself is gone (deleted mid-flight, between the element
    // write landing and this trigger running) — nothing to resolve a plan
    // or a rate-limit bucket against, and the element's own board no longer
    // exists to index for.
    logger.warn("embeddings trigger: board missing, skipping", { boardId });
    return;
  }

  // Rate limit BEFORE quota, mirroring generateFlashcards.ts's own order: a
  // transient throttle is cheaper to check than a Firestore quota read.
  // `bucketKey` is ALSO the telemetry bucket below for a legacy board — see
  // this file's header for why that's a deliberate divergence from
  // generateFlashcards.ts, not an oversight.
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
  // has no plan to cap (same carve-out as generateFlashcards.ts). Telemetry
  // below is NOT carved out the same way — see this file's header.
  //
  // This is `embeddingsPerPeriod`, this trigger's own row, NOT the
  // workspace-wide AI cap — and the numbers there are deliberately loose,
  // because a denial here is SILENT to the user: the embed is skipped, the
  // index goes stale, and board Q&A keeps answering from content that no
  // longer matches the board. That makes a cap that bites during ordinary
  // editing worse than no cap; this one exists to stop a runaway.
  if (workspaceId) {
    const withinQuota = await deps.checkQuota(workspaceId, now);
    if (!withinQuota) {
      // Same "skip + log, never throw" direction as the rate limiter above.
      // Hashed workspace id only, never raw (Global Constraint).
      logger.warn("embeddings trigger: over embedding quota, skipping embed", {
        workspaceHash: hashWorkspaceId(workspaceId),
        boardId,
        elementId: element.id,
      });
      return;
    }
  }

  const outcome = await deps.embed(boardId, element, now);
  if (!outcome.embedded) {
    return; // a narrow race with another invocation made this a hash-skip after all.
  }

  // Meter regardless of the race guard below: the provider was actually
  // called and the cost was actually incurred, whether or not the element
  // (and so the embedding this call just wrote) still exists a moment
  // later. `workspaceId: bucketKey` is what makes a legacy board's spend
  // show up somewhere at all — `workspaces/solo-${authorUid}/aiUsage/...`
  // is a synthetic bucket, not a real workspace document, and nothing in
  // the product UI surfaces it; it exists so the spend is not INVISIBLE,
  // not so it's a polished dashboard entry. See this file's header.
  if (outcome.model && outcome.usage) {
    try {
      await deps.recordUsage({
        workspaceId: bucketKey,
        uid: authorUid,
        model: outcome.model,
        usage: outcome.usage,
        now,
      });
    } catch (err) {
      // A telemetry write must never undo an embed that already happened
      // and was already paid for — log and swallow, mirroring
      // generateFlashcards' own recordAiUsage try/catch.
      logger.error("embeddings trigger: usage telemetry write failed", { boardId, err });
    }
  }

  // Write/delete race guard. `embedElement` above can take seconds (a real
  // OpenAI round trip); if the element was deleted WHILE it was in flight,
  // `onXDeleted`'s cleanup trigger (below) may already have run and found
  // NOTHING to delete yet — then THIS write lands afterward and resurrects
  // exactly the "citation pointing at nothing" item the deletion trigger
  // exists to prevent. Re-reading the element's own document (not the
  // embedding doc) after the embed catches that: if it's gone, delete the
  // embedding we just wrote.
  //
  // CLOSED for the single-invocation case, with strongly-consistent Admin
  // SDK reads: either this check finds the element gone and deletes right
  // here, or it finds the element present and a delete arriving AFTER this
  // point removes an embedding that now genuinely exists — `onXDeleted`
  // cleans that up normally. There is no ordering of one write and one
  // delete that resurrects anything.
  //
  // Also not reachable: delete-then-recreate at the SAME id (e.g. an
  // undo/redo of a delete). Recreating an element is a fresh `create` in
  // this app, which lands as a NEW document id — never the deleted one — so
  // there is no live element whose embedding this compensating delete could
  // ever strip out from under it.
  //
  // The REAL residuals, honestly named rather than a wrong-but-cautious
  // one: (1) the compensating delete below itself fails (network blip,
  // permission drift) — caught and logged just below, not silently eaten;
  // (2) `onXDeleted`'s own delete fails for the same reasons — that
  // trigger's own retry semantics are its concern, not this file's; (3) this
  // Cloud Function instance dies (crash, timeout, forced restart) between
  // `embedElement` returning and this check running — nothing runs the
  // compensating delete at all, and nothing re-triggers one later, since the
  // element write itself does not fire again. None of these three are
  // ORDERING races the way the resurrection scenario was; they are plain
  // failure/liveness gaps, the same kind every fire-and-forget cleanup in
  // this codebase already accepts.
  const stillExists = await deps.elementStillExists();
  if (!stillExists) {
    try {
      await deps.deleteEmbedding(boardId, element.id);
    } catch (err) {
      // Residual (1) above, made concrete: without this catch, a throw here
      // rejects the whole handler — `onDocumentWritten` defaults to
      // `retry: false`, so the resurrected embedding would stand
      // permanently and silently, exactly the outcome this guard exists to
      // prevent. A retry would not even help (a retried run sees a matching
      // contentHash and returns early at `isContentUnchanged` above,
      // never reaching this code again) — log and swallow instead, mirroring
      // the usage-telemetry catch just above.
      logger.error("embeddings trigger: compensating delete failed after a write/delete race", {
        boardId,
        elementId: element.id,
        err,
      });
    }
  }
}

/**
 * Exported (not just used internally by `makeWriteTrigger` below) so its
 * real Firestore path wiring — `elementStillExists`/`deleteEmbedding` must
 * read/write EXACTLY the right collections, not each other's, or the write/
 * delete race guard silently never fires — is pinned by a test against a
 * fake Firestore, the same way the extractors' field names are pinned
 * against real element shapes.
 */
export function makeDeps(
  db: Firestore,
  provider: EmbeddingProvider,
  boardId: string,
  collection: Collection,
  elementId: string
): EmbeddingTriggerDeps {
  return {
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
        // Automated spend: reported in full, but not charged against the
        // interactive `aiCallsPerPeriod` cap. Paired with `checkQuota` above —
        // see this file's header and `RecordUsageParams.countsTowardAiCap`.
        countsTowardAiCap: false,
      }).then(() => undefined),
    elementStillExists: async () => {
      const snap = await db.doc(`boards/${boardId}/${collection}/${elementId}`).get();
      return snap.exists;
    },
    deleteEmbedding: async (bId, elId) => {
      await db.doc(`boards/${bId}/embeddings/${elId}`).delete();
    },
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
      await handleElementWrite(
        boardId,
        extracted,
        makeDeps(db, provider, boardId, collection, elementId),
        Date.now()
      );
    }
  );
}

export const onNoteWritten = makeWriteTrigger("notes");
export const onTextElementWritten = makeWriteTrigger("textElements");
export const onPathWritten = makeWriteTrigger("paths");
export const onShapeWritten = makeWriteTrigger("shapes");
export const onImageWritten = makeWriteTrigger("images");
// The sixth source — comments, which ROADMAP.md's board Q&A scope names
// explicitly alongside board content. Same explicit-binding discipline as the
// five above, for the same reasons (see this file's header).
export const onCommentWritten = makeWriteTrigger("comments");

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
// A deleted comment thread is a citation pointing at nothing exactly like a
// deleted element is — the same reason every binding above has a paired one.
export const onCommentDeleted = makeDeleteTrigger("comments");
