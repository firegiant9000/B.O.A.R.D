import type { AIProvider, ChatMessage, ChatUsage } from "./provider";
import type { VisionClient } from "./vision";

// Handwriting OCR orchestration (Month 4, Phase 10). Vision-first, GPT-on-low-
// confidence (Appendix B.3): Google Vision is ~$0.0015/image vs the vision LLM's
// per-token cost, so it runs first and the OpenAI model only handles the strokes
// Vision wasn't sure about. The escalation logic is pure (deps injected) so it is
// unit-tested without the network — mirroring summaryPrompt/rateLimit.

/** Below this 0–1 confidence the Vision result is treated as untrustworthy and
 *  escalated to the LLM (Appendix B.7 confirm threshold is the same 70%). */
export const OCR_CONFIDENCE_THRESHOLD = 0.7;

/** Google Cloud Vision DOCUMENT_TEXT_DETECTION list price, USD per image
 *  (units 1–5M/month). Vision bills per image, not per token, so it is logged as
 *  a flat cost rather than through the token-rate table. */
export const VISION_COST_PER_IMAGE = 0.0015;

/** The model name recorded in aiLog/aiUsage for a Vision call (it has no LLM
 *  model id). The usage rate table ignores it — the flat cost is passed through. */
export const VISION_MODEL = "google-vision";

const ZERO_USAGE: ChatUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const SYSTEM_PROMPT = `You transcribe handwriting and printed text from an image of a whiteboard region.
Respond with ONLY a JSON object (no markdown fences, no prose) matching exactly:
{"text": string, "confidence": number}
- "text": the transcribed text, preserving line breaks; "" if the image has no legible text.
- "confidence": your 0.0–1.0 confidence in the transcription.`;

/** Builds the multimodal message list for the LLM escalation path. */
export function buildOcrMessages(imageDataUrl: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: "Transcribe the text in this image." },
        { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
      ],
    },
  ];
}

/** Pure: parse the LLM reply into text + confidence. Tolerates a plain-text reply
 *  (no JSON) by treating the whole reply as the text at a default confidence, so a
 *  model that ignores the JSON instruction still yields a usable result. */
export function parseOcrResponse(reply: string): { text: string; confidence: number } {
  const trimmed = reply.trim();
  try {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const json = JSON.parse(trimmed.slice(start, end + 1));
      const text = typeof json.text === "string" ? json.text.trim() : "";
      const confidence =
        typeof json.confidence === "number" ? clamp01(json.confidence) : 0.8;
      return { text, confidence };
    }
  } catch {
    // fall through to the plain-text fallback
  }
  return { text: trimmed, confidence: trimmed ? 0.8 : 0 };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** One billable engine call, surfaced so the callable can log each to aiUsage. */
export interface PaidCall {
  model: string;
  usage: ChatUsage;
  flatCostUsd?: number;
}

export interface OcrOutcome {
  text: string;
  confidence: number;
  /** Which engine produced the returned text. */
  source: "vision" | "gpt";
  /** The concrete model/engine of `source` (for display + telemetry). */
  model: string;
  /** Every engine that actually ran (Vision always; GPT only on escalation), so
   *  the caller logs cost for each — an escalation paid for both. */
  paidCalls: PaidCall[];
}

/**
 * Vision-first OCR with LLM escalation. Runs Vision, returns it when confident,
 * else escalates to the injected LLM. Pure of Firestore/HTTP transport — the
 * `vision`/`provider` deps own that — so the threshold + escalation branches are
 * unit-tested directly.
 */
export async function recognizeImage(deps: {
  vision: VisionClient;
  provider: AIProvider;
  imageDataUrl: string;
}): Promise<OcrOutcome> {
  const { vision, provider, imageDataUrl } = deps;

  const visionResult = await vision.detectHandwriting(imageDataUrl);
  const paidCalls: PaidCall[] = [
    { model: VISION_MODEL, usage: ZERO_USAGE, flatCostUsd: VISION_COST_PER_IMAGE },
  ];

  if (visionResult.text && visionResult.confidence >= OCR_CONFIDENCE_THRESHOLD) {
    return {
      text: visionResult.text,
      confidence: visionResult.confidence,
      source: "vision",
      model: VISION_MODEL,
      paidCalls,
    };
  }

  // Low confidence (or nothing detected) → escalate to the vision LLM.
  const chat = await provider.chat({
    model: "ocr-vision",
    messages: buildOcrMessages(imageDataUrl),
    maxTokens: 500,
    temperature: 0,
  });
  paidCalls.push({ model: chat.model, usage: chat.usage });
  const parsed = parseOcrResponse(chat.text);

  return {
    text: parsed.text,
    confidence: parsed.confidence,
    source: "gpt",
    model: chat.model,
    paidCalls,
  };
}
