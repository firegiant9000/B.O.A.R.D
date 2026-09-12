import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { OpenAIProvider } from "../ai/openai";
import {
  buildFlashcardMessages,
  parseFlashcardResponse,
} from "../ai/flashcardPrompt";
import {
  flashcardCacheKey,
  getCachedFlashcards,
  putCachedFlashcards,
  type FlashcardPair,
} from "../ai/flashcardCache";
import { consumeToken } from "../ai/rateLimit";
import { recordAiUsage, checkAiQuota } from "../ai/usage";
import { resolveBoardAccess } from "../lib/board";
import { OPENAI_API_KEY } from "../config";
import type { AIProvider } from "../ai/provider";

// Month 6 — flashcard generation. Same skeleton as recognizeHandwriting (auth →
// board access → cache → rate limit → quota → engine → telemetry → cache write)
// since generation is memoized exactly like OCR. UNLIKE every M4 AI callable,
// every `resource-exhausted` throw below carries `details: { reason }` — the
// M4 callables throw the same code for two unrelated reasons (a transient
// per-workspace throttle vs. the plan's AI-call cap) with nothing to tell a
// client which one it hit, so a free-tier user momentarily throttled sees the
// same upgrade prompt as one who is genuinely out of quota. This callable is
// the one built after that gap was named, so it closes it from the start
// rather than needing a later migration — see src/services/flashcardService.ts
// for the client-side routing on this field.
//
// The GENERATED cards are NOT saved to any per-user schedule here — this
// callable only turns a selection into front/back pairs. Scheduling is
// per-user (`users/{uid}/decks/{deckId}/cards/{cardId}`), never board-scoped
// (two students studying the same board have different schedules), so saving
// a card to a deck is a separate, later write the client makes for itself
// (flashcardService.addCardsToDeck) — this function has no opinion on which
// deck, or whether the caller saves the cards at all.

const FEATURE = "flashcards";

export interface GenerateFlashcardsRequest {
  boardId: string;
  /** Transcribed text from the selection (text elements / sticky notes).
   *  Optional — a purely visual selection can still generate from the image. */
  selectionText?: string;
  /** Cropped PNG of the selected region, produced client-side. Optional — a
   *  text-only selection can generate without an image. */
  imageDataUrl?: string;
  /** Selected stroke ids — the cache key (order-independent), like OCR's. */
  pathIds?: string[];
}

export interface GenerateFlashcardsResponse {
  cards: FlashcardPair[];
  model: string;
  /** True when served from the cache (no paid call, no usage logged). */
  cached: boolean;
}

export async function handleGenerateFlashcards(
  req: CallableRequest<GenerateFlashcardsRequest>,
  provider: AIProvider,
  now: number
): Promise<GenerateFlashcardsResponse> {
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to generate flashcards.");
  }

  const { boardId, selectionText, imageDataUrl, pathIds } =
    req.data ?? ({} as GenerateFlashcardsRequest);
  if (!boardId) {
    throw new HttpsError("invalid-argument", "boardId is required.");
  }
  if (!imageDataUrl && !(selectionText && selectionText.trim())) {
    throw new HttpsError(
      "invalid-argument",
      "An image or some selected text is required to generate flashcards."
    );
  }

  const db = getFirestore();

  const access = await resolveBoardAccess(db, boardId, uid);
  if (!access) {
    throw new HttpsError("not-found", "Board not found.");
  }
  if (!access.isMember) {
    throw new HttpsError("permission-denied", "You are not a member of this board.");
  }

  // Cache hit short-circuits before the limiter + any paid call — identical
  // memoization shape to recognizeHandwriting.ts. Only keyed when the client
  // passed stroke ids; a selection with no strokes (pure text/notes) always
  // goes live, same as OCR's own id-less fallback.
  const key = Array.isArray(pathIds) && pathIds.length ? flashcardCacheKey(pathIds) : null;
  if (key) {
    const cached = await getCachedFlashcards(db, boardId, key);
    if (cached) {
      return { cards: cached.cards, model: cached.model, cached: true };
    }
  }

  // Rate-limit by workspace; legacy no-workspace boards bucket per-user so a
  // missing workspaceId can't sidestep the limiter.
  const bucketKey = access.workspaceId || `solo-${uid}`;
  const allowed = await consumeToken(db, bucketKey, now);
  if (!allowed) {
    // Transient — the caller should just retry in a few seconds, never see an
    // upgrade prompt for this. See this file's own header on `details`.
    throw new HttpsError(
      "resource-exhausted",
      "Too many AI requests right now. Please wait a moment and try again.",
      { reason: "rate-limit" }
    );
  }

  // Plan quota gate. Only meaningful for a real workspace; a solo/legacy board
  // has no plan to cap.
  if (access.workspaceId) {
    const withinQuota = await checkAiQuota(db, access.workspaceId, now);
    if (!withinQuota) {
      // NOT transient — the workspace is genuinely over its plan's AI-call cap
      // for this period. See this file's own header on `details`.
      throw new HttpsError(
        "resource-exhausted",
        "Your workspace has reached its AI usage limit for this period.",
        { reason: "plan-quota" }
      );
    }
  }

  const messages = buildFlashcardMessages(selectionText, imageDataUrl);
  const chat = await provider.chat({
    model: "flashcards",
    messages,
    // Bounded array of short strings — comfortably fits MAX_FLASHCARDS_PER_GENERATION
    // pairs with room for the JSON envelope.
    maxTokens: 900,
    temperature: 0.5,
  });

  if (!chat.text) {
    throw new HttpsError("internal", "AI returned an empty response.");
  }

  const cards = parseFlashcardResponse(chat.text);
  if (cards.length === 0) {
    throw new HttpsError(
      "not-found",
      "Couldn't generate any flashcards from that selection."
    );
  }

  // Cost telemetry. A telemetry write must never fail a generation the user
  // already paid for, so a failure is logged and swallowed. Solo/legacy boards
  // have no workspace to meter under.
  if (access.workspaceId) {
    try {
      await recordAiUsage(db, {
        workspaceId: access.workspaceId,
        uid,
        feature: FEATURE,
        model: chat.model,
        usage: chat.usage,
        now,
      });
    } catch (err) {
      logger.error("aiUsage telemetry write failed", { boardId, feature: FEATURE, err });
    }
  }

  // Memoize so re-running the same selection is a free cache hit. A cache
  // write failure must not fail the call either — the user still gets their cards.
  if (key) {
    try {
      await putCachedFlashcards(db, boardId, key, {
        cards,
        model: chat.model,
        createdAt: now,
      });
    } catch (err) {
      logger.error("flashcardCache write failed", { boardId, err });
    }
  }

  return { cards, model: chat.model, cached: false };
}

export const generateFlashcards = onCall(
  { secrets: [OPENAI_API_KEY] },
  (req: CallableRequest<GenerateFlashcardsRequest>) =>
    handleGenerateFlashcards(req, new OpenAIProvider(OPENAI_API_KEY.value()), Date.now())
);
