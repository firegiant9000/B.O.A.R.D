import AsyncStorage from "@react-native-async-storage/async-storage";
import { doc, getDoc, setDoc, deleteField } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, auth, functions } from "../config/firebase";
import { captureException } from "../lib/errorReporting";
import {
  AI_GATEWAY_ENABLED,
  OCR_ENABLED,
  EXPLAIN_ENABLED,
  DIAGRAM_ENABLED,
} from "../lib/featureFlags";
import type { SessionSummary } from "../types";
import * as pathService from "./pathService";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const STORAGE_KEY = "board_openai_key";

let _apiKey: string | null = null;

function privateKeyDoc(uid: string) {
  return doc(db, "users", uid, "private", "apiKeys");
}

export async function loadOpenAIKey(): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (uid) {
    try {
      const snap = await getDoc(privateKeyDoc(uid));
      if (snap.exists() && snap.data().openaiKey) {
        _apiKey = snap.data().openaiKey;
        AsyncStorage.setItem(STORAGE_KEY, _apiKey!).catch((e) =>
          captureException(e, { op: "loadOpenAIKey.cacheWrite" })
        );
        return;
      }
    } catch (e) {
      captureException(e, { op: "loadOpenAIKey.firestoreRead" });
    }
  }
  // Fall back to local cache if Firestore unavailable or user not signed in
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored) _apiKey = stored;
  } catch (e) {
    captureException(e, { op: "loadOpenAIKey.cacheRead" });
  }
}

export async function setOpenAIKey(key: string): Promise<void> {
  _apiKey = key;
  AsyncStorage.setItem(STORAGE_KEY, key).catch((e) =>
    captureException(e, { op: "setOpenAIKey.cacheWrite" })
  );
  const uid = auth.currentUser?.uid;
  if (uid) {
    await setDoc(privateKeyDoc(uid), { openaiKey: key }, { merge: true });
  }
}

export async function clearOpenAIKey(): Promise<void> {
  _apiKey = null;
  AsyncStorage.removeItem(STORAGE_KEY).catch((e) =>
    captureException(e, { op: "clearOpenAIKey.cacheRemove" })
  );
  const uid = auth.currentUser?.uid;
  if (uid) {
    await setDoc(privateKeyDoc(uid), { openaiKey: deleteField() }, { merge: true });
  }
}

export function getOpenAIKey(): string | null {
  return _apiKey;
}

/**
 * Whether session summaries can be generated. True when the gateway is enabled
 * (the function holds the key) or, on the legacy path, when a client key is set.
 * Call sites use this instead of `getOpenAIKey()` so the gateway path doesn't
 * demand a device key that no longer exists.
 */
export function isSummaryConfigured(): boolean {
  return AI_GATEWAY_ENABLED || !!_apiKey;
}

interface SessionContext {
  sessionTitle: string;
  boardTitle: string;
  durationMinutes: number;
  participantCount: number;
  /** Phase 3: biases the summary toward a TL;DR ("short") or the full
   *  structured breakdown ("detailed", the default). */
  mode?: "short" | "detailed";
}

/** Wraps a legacy/prose summary string into the structured shape so all callers
 *  get one type. Used by the legacy path and as a defensive fallback. */
function toStructuredSummary(text: string): SessionSummary {
  return { tldr: text.trim(), actionItems: [], decisions: [], openQuestions: [] };
}

/**
 * Gathers board content (notes and text elements) to build context for the AI summary.
 */
async function gatherBoardContent(boardId: string): Promise<string> {
  const [notes, textElements] = await Promise.all([
    pathService.getBoardNotes(boardId),
    pathService.getBoardTextElements(boardId),
  ]);

  const parts: string[] = [];

  if (notes.length > 0) {
    parts.push("Sticky notes on the board:");
    notes.forEach((n, i) => parts.push(`  ${i + 1}. "${n.content}"`));
  }

  if (textElements.length > 0) {
    parts.push("Text elements on the canvas:");
    textElements
      .filter((el) => el.text.trim())
      .forEach((el, i) => parts.push(`  ${i + 1}. "${el.text}"`));
  }

  if (parts.length === 0) {
    return "No text content was found on the board. The session may have focused on visual drawing/sketching.";
  }

  return parts.join("\n");
}

interface GenerateSummaryResponse {
  summary: SessionSummary;
  model: string;
}

/**
 * Gateway path (Phase 1): calls the `generateSummary` Cloud Function. No API key
 * on device — the function holds the key, gathers board content server-side, and
 * rate-limits per workspace. The client passes only ids + metadata + the optional
 * snapshot image.
 */
async function generateSessionSummaryViaGateway(
  boardId: string,
  context: SessionContext,
  imageDataUrl?: string
): Promise<SessionSummary> {
  const callable = httpsCallable<
    { boardId: string; context: SessionContext; imageDataUrl?: string },
    GenerateSummaryResponse
  >(functions, "generateSummary");

  try {
    const { data } = await callable({ boardId, context, imageDataUrl });
    const summary = data?.summary;
    if (!summary) throw new Error("AI returned an empty response.");
    // Defensive: tolerate an older function that still returns a string.
    if (typeof summary === "string") return toStructuredSummary(summary);
    if (!summary.tldr) throw new Error("AI returned an empty response.");
    return summary;
  } catch (e: any) {
    // Surface the function's HttpsError message (rate limit, permission, etc.)
    // rather than a generic "internal" wrapper.
    throw new Error(e?.message ?? "Failed to generate summary.");
  }
}

/**
 * Generates an AI-powered summary of a board session.
 *
 * Routes to the Cloud Function gateway when `AI_GATEWAY_ENABLED` (Phase 1
 * cutover), else falls back to the legacy direct-OpenAI path below. Returns the
 * summary text, or throws if the call fails.
 */
export async function generateSessionSummary(
  boardId: string,
  context: SessionContext,
  imageDataUrl?: string
): Promise<SessionSummary> {
  if (AI_GATEWAY_ENABLED) {
    return generateSessionSummaryViaGateway(boardId, context, imageDataUrl);
  }
  return generateSessionSummaryLegacy(boardId, context, imageDataUrl);
}

// --- Phase 10: handwriting OCR ---

/** Below this the result is treated as low-confidence: the client surfaces a
 *  confirm step before committing the text (Appendix B.7). Mirrors the function's
 *  `OCR_CONFIDENCE_THRESHOLD`. */
export const OCR_CONFIDENCE_THRESHOLD = 0.7;

export interface OcrResult {
  /** The recognized text. */
  text: string;
  /** 0–1 confidence; below `OCR_CONFIDENCE_THRESHOLD` the caller asks to confirm. */
  confidence: number;
  /** Which engine produced the text ("vision" | "gpt") — informational. */
  source: string;
  /** True when served from the per-selection cache (no paid call this run). */
  cached: boolean;
}

/** Whether the OCR affordance should be offered. OCR rides the gateway, so it
 *  needs both flags on (and a deployed function). */
export function isOcrConfigured(): boolean {
  return OCR_ENABLED && AI_GATEWAY_ENABLED;
}

/**
 * Recognizes handwriting/text in a selected board region (Phase 10). The client
 * passes a cropped PNG of the selection plus the selected stroke ids (the cache
 * key); the function runs Google Vision first and escalates to a vision LLM on
 * low confidence, memoizing the result so a re-run on the same strokes is free.
 */
export async function recognizeHandwriting(
  boardId: string,
  imageDataUrl: string,
  pathIds: string[]
): Promise<OcrResult> {
  const callable = httpsCallable<
    { boardId: string; imageDataUrl: string; pathIds: string[] },
    OcrResult
  >(functions, "recognizeHandwriting");

  try {
    const { data } = await callable({ boardId, imageDataUrl, pathIds });
    if (!data?.text) throw new Error("No legible text was found in the selection.");
    return data;
  } catch (e: any) {
    // Surface the function's HttpsError message (rate limit, not-found, etc.).
    throw new Error(e?.message ?? "Failed to recognize handwriting.");
  }
}

// --- Phase 11: explain selection ---

/** The three-section explanation the function returns (Appendix B.3). */
export interface ExplainResult {
  concept: string;
  explanation: string;
  example: string;
}

export interface ExplainResponse {
  result: ExplainResult;
  /** Pre-flattened text ready to drop into a TextElement. */
  text: string;
  model: string;
}

/** Whether the "explain selection" affordance should be offered. Explain rides
 *  the gateway, so it needs both flags on (and a deployed function). */
export function isExplainConfigured(): boolean {
  return EXPLAIN_ENABLED && AI_GATEWAY_ENABLED;
}

/**
 * Explains a selected board region (Phase 11). The client passes a cropped PNG of
 * the selection plus any transcribed text from selected text/notes; the function
 * returns a compact concept/explanation/example block (and a pre-flattened `text`
 * the caller drops into a TextElement beside the selection). Generative, so unlike
 * OCR there is no cache — re-running may legitimately differ.
 */
export async function explainSelection(
  boardId: string,
  imageDataUrl?: string,
  selectionText?: string
): Promise<ExplainResponse> {
  const callable = httpsCallable<
    { boardId: string; imageDataUrl?: string; selectionText?: string },
    ExplainResponse
  >(functions, "explainSelection");

  try {
    const { data } = await callable({ boardId, imageDataUrl, selectionText });
    if (!data?.text) throw new Error("Couldn't produce an explanation for that selection.");
    return data;
  } catch (e: any) {
    // Surface the function's HttpsError message (rate limit, not-found, etc.).
    throw new Error(e?.message ?? "Failed to explain the selection.");
  }
}

// --- Phase 12: text → diagram ---

export interface DiagramResponse {
  /** Validated Mermaid source for the client parser (`lib/mermaid-to-board`). */
  mermaid: string;
  /** Detected family: flowchart | sequence | class | mindmap. */
  family: string;
  model: string;
  /** True when the function needed its one stricter retry to get valid Mermaid. */
  retried: boolean;
}

/** Whether the "text → diagram" affordance should be offered. Diagram rides the
 *  gateway, so it needs both flags on (and a deployed function). */
export function isDiagramConfigured(): boolean {
  return DIAGRAM_ENABLED && AI_GATEWAY_ENABLED;
}

/**
 * Turns a natural-language prompt into a diagram (Phase 12). The function returns
 * validated Mermaid syntax (retrying once on a parse failure); the caller parses
 * it into native shapes/text via `lib/mermaid-to-board`. Generative, so — like
 * explain — there is no cache.
 */
export async function textToDiagram(
  boardId: string,
  prompt: string
): Promise<DiagramResponse> {
  const callable = httpsCallable<{ boardId: string; prompt: string }, DiagramResponse>(
    functions,
    "textToDiagram"
  );

  try {
    const { data } = await callable({ boardId, prompt });
    if (!data?.mermaid) throw new Error("Couldn't generate a diagram for that prompt.");
    return data;
  } catch (e: any) {
    // Surface the function's HttpsError message (rate limit, not-found, etc.).
    throw new Error(e?.message ?? "Failed to generate the diagram.");
  }
}

/**
 * Legacy direct-OpenAI path (pre-Phase-1). Retained behind the gateway flag until
 * the function is verified in prod, then removed along with the client key APIs.
 */
async function generateSessionSummaryLegacy(
  boardId: string,
  context: SessionContext,
  imageDataUrl?: string
): Promise<SessionSummary> {
  if (!_apiKey) {
    throw new Error(
      "OpenAI API key not configured. Go to Profile > Settings to add your API key."
    );
  }

  const boardContent = await gatherBoardContent(boardId);

  const systemPrompt = `You are a helpful assistant that summarizes collaboration sessions.
You will receive session metadata, transcribed text content, and (if present) an image of the whiteboard.
If an image is present, describe concretely what is drawn or written on it (shapes, words, diagrams, sketches) — do not say "no content was found" when an image is provided.
Write a concise summary (3-5 sentences) combining all signals. Focus on what was actually on the board and any apparent topics or decisions.`;

  const userPrompt = `Session: "${context.sessionTitle}"
Board: "${context.boardTitle}"
Duration: ${context.durationMinutes} minutes
Participants: ${context.participantCount} people

Board content:
${boardContent}

Please provide a brief session summary.`;

  const useVision = !!imageDataUrl;
  const userMessage = useVision
    ? {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: { url: imageDataUrl, detail: "high" },
          },
        ],
      }
    : { role: "user", content: userPrompt };

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${_apiKey}`,
    },
    body: JSON.stringify({
      model: useVision ? "gpt-4o-mini" : "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        userMessage,
      ],
      max_tokens: 300,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`AI API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const summary = data.choices?.[0]?.message?.content?.trim();

  if (!summary) {
    throw new Error("AI returned an empty response.");
  }

  // The legacy direct-OpenAI prompt returns prose; wrap it so callers get the
  // structured shape uniformly (the prose becomes the TL;DR).
  return toStructuredSummary(summary);
}
