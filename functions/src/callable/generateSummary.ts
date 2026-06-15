import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { OpenAIProvider } from "../ai/openai";
import {
  buildSummaryMessages,
  parseSummaryResponse,
  type SummaryContext,
  type SessionSummary,
} from "../ai/summaryPrompt";
import { consumeToken } from "../ai/rateLimit";
import { recordAiUsage, checkAiQuota } from "../ai/usage";
import { resolveBoardAccess, gatherBoardContent } from "../lib/board";
import { OPENAI_API_KEY } from "../config";
import type { AIProvider } from "../ai/provider";

// Feature tag written to aiUsage/aiLog so the usage page can break cost down by
// feature. Later AI phases (OCR / explain / diagram) pass their own tag.
const FEATURE = "summary";

// The single callable for Month 4 Phase 1. Later AI phases (OCR, explain, diagram)
// add sibling callables that reuse the same shape — auth check → board access →
// rate limit → provider.chat → return. The OpenAI key is bound as a secret, so it
// lives only in the function runtime, never in the client bundle.

export interface GenerateSummaryRequest {
  boardId: string;
  context: SummaryContext;
  imageDataUrl?: string;
}

export interface GenerateSummaryResponse {
  summary: SessionSummary;
  model: string;
}

/** Core handler, provider + clock injected so it is unit-testable without the
 *  Functions runtime. The exported `generateSummary` binds the real ones. */
export async function handleGenerateSummary(
  req: CallableRequest<GenerateSummaryRequest>,
  provider: AIProvider,
  now: number
): Promise<GenerateSummaryResponse> {
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to generate a summary.");
  }

  const { boardId, context, imageDataUrl } = req.data ?? ({} as GenerateSummaryRequest);
  if (!boardId || !context) {
    throw new HttpsError("invalid-argument", "boardId and context are required.");
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

  // Plan quota gate (Phase 2 — M5 enforcement seam). Allows everyone today but
  // reads the live counter, so M5 flips a limit here without touching the call site.
  // Only meaningful for a real workspace; a solo/legacy board has no plan to cap.
  if (access.workspaceId) {
    const withinQuota = await checkAiQuota(db, access.workspaceId, now);
    if (!withinQuota) {
      throw new HttpsError(
        "resource-exhausted",
        "Your workspace has reached its AI usage limit for this period."
      );
    }
  }

  const content = await gatherBoardContent(db, boardId);
  const useVision = !!imageDataUrl;
  const messages = buildSummaryMessages(context, content, imageDataUrl);

  const result = await provider.chat({
    model: useVision ? "summary-vision" : "summary-text",
    messages,
    // Detailed mode needs more room for the action-item/decision arrays; short
    // stays tight. The JSON envelope itself costs a few tokens, so both are a
    // little above the old prose cap.
    maxTokens: context.mode === "short" ? 350 : 600,
    temperature: 0.7,
  });

  if (!result.text) {
    throw new HttpsError("internal", "AI returned an empty response.");
  }

  // Phase 3: parse the model's JSON into the structured artifact. A non-JSON
  // reply degrades to a TL;DR-only summary rather than failing the call.
  const summary = parseSummaryResponse(result.text);

  // Phase 2 cost telemetry: log per-call cost + bump the period counter. Telemetry
  // must never break a summary the user already paid for, so a write failure is
  // logged and swallowed. Solo/legacy boards have no workspace to meter under.
  if (access.workspaceId) {
    try {
      await recordAiUsage(db, {
        workspaceId: access.workspaceId,
        uid,
        feature: FEATURE,
        model: result.model,
        usage: result.usage,
        now,
      });
    } catch (err) {
      logger.error("aiUsage telemetry write failed", { boardId, err });
    }
  }

  return { summary, model: result.model };
}

export const generateSummary = onCall(
  { secrets: [OPENAI_API_KEY] },
  (req: CallableRequest<GenerateSummaryRequest>) =>
    handleGenerateSummary(req, new OpenAIProvider(OPENAI_API_KEY.value()), Date.now())
);
