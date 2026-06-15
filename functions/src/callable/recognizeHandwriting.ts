import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { OpenAIProvider } from "../ai/openai";
import { GoogleVisionClient, type VisionClient } from "../ai/vision";
import { recognizeImage } from "../ai/ocr";
import { ocrCacheKey, getCachedOcr, putCachedOcr } from "../ai/ocrCache";
import { consumeToken } from "../ai/rateLimit";
import { recordAiUsage, checkAiQuota } from "../ai/usage";
import { resolveBoardAccess } from "../lib/board";
import { OPENAI_API_KEY, GOOGLE_VISION_API_KEY } from "../config";
import type { AIProvider } from "../ai/provider";

// Phase 10 OCR callable. Same skeleton as generateSummary (auth → board access →
// rate limit → quota → engine → telemetry) plus a memoization layer: a cache hit
// short-circuits before the rate limiter and any paid call, so re-running OCR on
// the same selection is free (Appendix B.3).

const FEATURE = "ocr";

export interface RecognizeHandwritingRequest {
  boardId: string;
  /** Cropped PNG of the selected region, produced client-side. */
  imageDataUrl: string;
  /** Selected stroke ids — the cache key (order-independent). */
  pathIds: string[];
}

export interface RecognizeHandwritingResponse {
  text: string;
  confidence: number;
  source: "vision" | "gpt";
  model: string;
  /** True when served from the cache (no paid call, no usage logged). */
  cached: boolean;
}

export async function handleRecognizeHandwriting(
  req: CallableRequest<RecognizeHandwritingRequest>,
  vision: VisionClient,
  provider: AIProvider,
  now: number
): Promise<RecognizeHandwritingResponse> {
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to recognize handwriting.");
  }

  const { boardId, imageDataUrl, pathIds } =
    req.data ?? ({} as RecognizeHandwritingRequest);
  if (!boardId || !imageDataUrl) {
    throw new HttpsError("invalid-argument", "boardId and imageDataUrl are required.");
  }

  const db = getFirestore();

  const access = await resolveBoardAccess(db, boardId, uid);
  if (!access) {
    throw new HttpsError("not-found", "Board not found.");
  }
  if (!access.isMember) {
    throw new HttpsError("permission-denied", "You are not a member of this board.");
  }

  // Cache hit short-circuits before the limiter + any paid call. Only keyed when
  // the client passed stroke ids — an id-less call (e.g. a free-drawn marquee with
  // no strokes) always goes live.
  const key = Array.isArray(pathIds) && pathIds.length ? ocrCacheKey(pathIds) : null;
  if (key) {
    const cached = await getCachedOcr(db, boardId, key);
    if (cached) {
      return {
        text: cached.text,
        confidence: cached.confidence,
        source: cached.source,
        model: cached.model,
        cached: true,
      };
    }
  }

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

  const outcome = await recognizeImage({ vision, provider, imageDataUrl });

  if (!outcome.text) {
    throw new HttpsError("not-found", "No legible text was found in the selection.");
  }

  // Telemetry: log every engine that ran (an escalation paid for both Vision and
  // the LLM). Like the summary path, a telemetry failure must not fail an OCR the
  // user already paid for. Solo/legacy boards have no workspace to meter under.
  if (access.workspaceId) {
    for (const call of outcome.paidCalls) {
      try {
        await recordAiUsage(db, {
          workspaceId: access.workspaceId,
          uid,
          feature: FEATURE,
          model: call.model,
          usage: call.usage,
          flatCostUsd: call.flatCostUsd,
          now,
        });
      } catch (err) {
        logger.error("aiUsage telemetry write failed", { boardId, feature: FEATURE, err });
      }
    }
  }

  // Memoize so re-running the same selection is a free cache hit. A cache write
  // failure must not fail the call either — the user still gets their text.
  if (key) {
    try {
      await putCachedOcr(db, boardId, key, {
        text: outcome.text,
        confidence: outcome.confidence,
        source: outcome.source,
        model: outcome.model,
        createdAt: now,
      });
    } catch (err) {
      logger.error("ocrCache write failed", { boardId, err });
    }
  }

  return {
    text: outcome.text,
    confidence: outcome.confidence,
    source: outcome.source,
    model: outcome.model,
    cached: false,
  };
}

export const recognizeHandwriting = onCall(
  { secrets: [OPENAI_API_KEY, GOOGLE_VISION_API_KEY] },
  (req: CallableRequest<RecognizeHandwritingRequest>) =>
    handleRecognizeHandwriting(
      req,
      new GoogleVisionClient(GOOGLE_VISION_API_KEY.value()),
      new OpenAIProvider(OPENAI_API_KEY.value()),
      Date.now()
    )
);
