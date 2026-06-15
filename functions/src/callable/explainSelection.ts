import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { OpenAIProvider } from "../ai/openai";
import {
  buildExplainMessages,
  parseExplainResponse,
  formatExplainText,
  EXPLAIN_MAX_TOKENS,
  type ExplainResult,
} from "../ai/explain";
import { consumeToken } from "../ai/rateLimit";
import { recordAiUsage, checkAiQuota } from "../ai/usage";
import { resolveBoardAccess } from "../lib/board";
import { OPENAI_API_KEY } from "../config";
import type { AIProvider } from "../ai/provider";

// Phase 11 "explain selection" callable. Same skeleton as generateSummary (auth →
// board access → rate limit → quota → provider.chat → telemetry → return). Unlike
// OCR there is no cache: explanations are generative, so re-running can legitimately
// differ and isn't worth memoizing. The selection content arrives from the client
// (image + any transcribed text); the function still resolves board membership so a
// caller can't explain content on a board they can't see.

const FEATURE = "explain";

export interface ExplainSelectionRequest {
  boardId: string;
  /** Cropped PNG of the selected region, produced client-side. Optional — a
   *  text-only selection can be explained without an image. */
  imageDataUrl?: string;
  /** Transcribed text from the selection (text elements / sticky notes). */
  selectionText?: string;
}

export interface ExplainSelectionResponse {
  result: ExplainResult;
  /** Pre-flattened text ready to drop into a TextElement. */
  text: string;
  model: string;
}

export async function handleExplainSelection(
  req: CallableRequest<ExplainSelectionRequest>,
  provider: AIProvider,
  now: number
): Promise<ExplainSelectionResponse> {
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to explain a selection.");
  }

  const { boardId, imageDataUrl, selectionText } =
    req.data ?? ({} as ExplainSelectionRequest);
  if (!boardId) {
    throw new HttpsError("invalid-argument", "boardId is required.");
  }
  if (!imageDataUrl && !(selectionText && selectionText.trim())) {
    throw new HttpsError(
      "invalid-argument",
      "An image or some selected text is required to explain a selection."
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

  // Rate-limit by workspace; legacy no-workspace boards bucket per-user so a
  // missing workspaceId can't sidestep the limiter.
  const bucketKey = access.workspaceId || `solo-${uid}`;
  const allowed = await consumeToken(db, bucketKey, now);
  if (!allowed) {
    throw new HttpsError(
      "resource-exhausted",
      "Too many AI requests right now. Please wait a moment and try again."
    );
  }

  if (access.workspaceId) {
    const withinQuota = await checkAiQuota(db, access.workspaceId, now);
    if (!withinQuota) {
      throw new HttpsError(
        "resource-exhausted",
        "Your workspace has reached its AI usage limit for this period."
      );
    }
  }

  const messages = buildExplainMessages(imageDataUrl, selectionText);
  const chat = await provider.chat({
    // gpt-4o-mini either way — vision tier so an image-only selection still works.
    model: "explain-vision",
    messages,
    maxTokens: EXPLAIN_MAX_TOKENS,
    temperature: 0.4,
  });

  if (!chat.text) {
    throw new HttpsError("internal", "AI returned an empty response.");
  }

  const result = parseExplainResponse(chat.text);
  const text = formatExplainText(result);
  if (!text) {
    throw new HttpsError("not-found", "Couldn't produce an explanation for that selection.");
  }

  // Phase 2 cost telemetry. A telemetry write must never fail an explanation the
  // user already paid for, so a failure is logged and swallowed. Solo/legacy boards
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

  return { result, text, model: chat.model };
}

export const explainSelection = onCall(
  { secrets: [OPENAI_API_KEY] },
  (req: CallableRequest<ExplainSelectionRequest>) =>
    handleExplainSelection(req, new OpenAIProvider(OPENAI_API_KEY.value()), Date.now())
);
