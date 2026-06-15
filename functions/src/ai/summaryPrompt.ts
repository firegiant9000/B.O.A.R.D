import type { ChatMessage } from "./provider";

// Pure prompt assembly for the session summary. Kept pure (no Firestore, no
// network) so it is unit-tested without an emulator. Phase 3 makes the model
// return structured JSON (parsed by `parseSummaryResponse`) instead of a prose
// blob, with a short / detailed mode that biases the prompt.

/** Phase 3: short = TL;DR only; detailed = full structured breakdown. */
export type SummaryMode = "short" | "detailed";

export interface SummaryContext {
  sessionTitle: string;
  boardTitle: string;
  durationMinutes: number;
  participantCount: number;
  /** Defaults to "detailed" when omitted (back-compat with Phase 1/2 callers). */
  mode?: SummaryMode;
}

export interface BoardContent {
  notes: string[];
  textElements: string[];
}

/** The structured summary artifact (Appendix B.2). Readers tolerate a legacy
 *  plain-string summary; this is the shape new summaries take. */
export interface SessionSummary {
  tldr: string;
  actionItems: string[];
  decisions: string[];
  openQuestions: string[];
}

const SYSTEM_PROMPT = `You are a helpful assistant that summarizes collaboration sessions.
You will receive session metadata, transcribed text content, and (if present) an image of the whiteboard.
If an image is present, describe concretely what is drawn or written on it (shapes, words, diagrams, sketches) — do not say "no content was found" when an image is provided.
Respond with ONLY a JSON object (no markdown fences, no prose around it) matching exactly this shape:
{"tldr": string, "actionItems": string[], "decisions": string[], "openQuestions": string[]}
- "tldr": a concise 2-4 sentence overview of what the session covered.
- "actionItems": concrete follow-up tasks, each a short phrase; [] if none are evident.
- "decisions": decisions the group reached; [] if none.
- "openQuestions": unresolved questions raised; [] if none.
Base every field on what was actually on the board. Do not invent content. Keep array entries short.`;

/** Renders board content into the prompt body. Mirrors the legacy client format
 *  so summaries read the same before and after the cutover. */
export function formatBoardContent(content: BoardContent): string {
  const parts: string[] = [];

  if (content.notes.length > 0) {
    parts.push("Sticky notes on the board:");
    content.notes.forEach((c, i) => parts.push(`  ${i + 1}. "${c}"`));
  }

  const texts = content.textElements.filter((t) => t.trim());
  if (texts.length > 0) {
    parts.push("Text elements on the canvas:");
    texts.forEach((t, i) => parts.push(`  ${i + 1}. "${t}"`));
  }

  if (parts.length === 0) {
    return "No text content was found on the board. The session may have focused on visual drawing/sketching.";
  }

  return parts.join("\n");
}

export function buildSummaryUserPrompt(
  ctx: SummaryContext,
  content: BoardContent
): string {
  // "short" trims the breakdown to a TL;DR; "detailed" (default) asks for the
  // full set of arrays. Either way the model returns the same JSON shape — the
  // mode only changes how much it fills in.
  const modeHint =
    ctx.mode === "short"
      ? `Keep this brief: a one-paragraph "tldr" is the priority; leave the other arrays empty unless an item is clearly important.`
      : `Be thorough: populate "actionItems", "decisions", and "openQuestions" wherever the content supports them.`;

  return `Session: "${ctx.sessionTitle}"
Board: "${ctx.boardTitle}"
Duration: ${ctx.durationMinutes} minutes
Participants: ${ctx.participantCount} people

Board content:
${formatBoardContent(content)}

${modeHint}
Respond with only the JSON object described in the system message.`;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Pulls a JSON object out of a model reply, tolerating markdown code fences or
 *  leading/trailing prose. Returns null when no parseable object is found. */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "");
  try {
    const parsed = JSON.parse(trimmed.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to brace-slice recovery
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // give up — caller falls back to treating the whole reply as the tldr
    }
  }
  return null;
}

/** Parses a model reply into a SessionSummary. Tolerates a non-JSON reply by
 *  treating the whole text as the TL;DR (graceful fallback per Phase 3 tests). */
export function parseSummaryResponse(text: string): SessionSummary {
  const json = extractJsonObject(text);
  if (json) {
    return {
      tldr: typeof json.tldr === "string" ? json.tldr.trim() : "",
      actionItems: toStringArray(json.actionItems),
      decisions: toStringArray(json.decisions),
      openQuestions: toStringArray(json.openQuestions),
    };
  }
  return { tldr: text.trim(), actionItems: [], decisions: [], openQuestions: [] };
}

/** Assembles the full message list. When `imageDataUrl` is present the user turn
 *  becomes multimodal (vision) and the caller should pick the vision model tier. */
export function buildSummaryMessages(
  ctx: SummaryContext,
  content: BoardContent,
  imageDataUrl?: string
): ChatMessage[] {
  const userText = buildSummaryUserPrompt(ctx, content);
  const userMessage: ChatMessage = imageDataUrl
    ? {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
        ],
      }
    : { role: "user", content: userText };

  return [{ role: "system", content: SYSTEM_PROMPT }, userMessage];
}
