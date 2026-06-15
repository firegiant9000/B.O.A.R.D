import type { ChatMessage } from "./provider";

// Pure prompt assembly + parse for "explain selection" (Month 4, Phase 11). Kept
// pure (no Firestore, no network) so it is unit-tested without an emulator —
// mirroring summaryPrompt/ocr. Distinct prompt path from summaries: the model
// explains a single selected concept rather than recapping a whole session, and
// returns a compact three-section structure (Appendix B.3) that the client drops
// into a TextElement beside the selection.

/** Output cap (~200 tokens per the phase contract) — the explanation is meant to
 *  be a short, glanceable block, and a tight cap keeps it fast (≤5s target) and
 *  cheap. The JSON envelope costs a few tokens, so this sits a little above 200. */
export const EXPLAIN_MAX_TOKENS = 260;

/** The three-section explanation artifact (Appendix B.3). */
export interface ExplainResult {
  concept: string;
  explanation: string;
  example: string;
}

const SYSTEM_PROMPT = `You explain a single selected item from a collaborative whiteboard — an equation, diagram, proof, snippet of notes, or sketch.
You receive any transcribed text from the selection and (if present) an image of it.
Respond with ONLY a JSON object (no markdown fences, no prose around it) matching exactly this shape:
{"concept": string, "explanation": string, "example": string}
- "concept": a short name/label for what was selected (a few words).
- "explanation": a clear, concise explanation in 1-3 sentences.
- "example": one short concrete example or application; "" if none fits.
Base everything on what is actually in the selection. Do not invent unrelated content. Keep it tight — this is a quick aside, not an essay.`;

/** Renders any selected text into the prompt body. Empty when the selection is
 *  purely visual (strokes/image) — the model then relies on the image alone. */
function formatSelectionText(selectionText?: string): string {
  const trimmed = (selectionText ?? "").trim();
  if (!trimmed) {
    return "The selection contains no transcribable text; rely on the image.";
  }
  return `Selected text:\n${trimmed}`;
}

/** Assembles the message list. When `imageDataUrl` is present the user turn
 *  becomes multimodal (vision) so the model can read strokes/sketches the text
 *  doesn't capture; the caller picks the vision model tier. */
export function buildExplainMessages(
  imageDataUrl?: string,
  selectionText?: string
): ChatMessage[] {
  const userText = `Explain the selected item.\n\n${formatSelectionText(selectionText)}\n\nRespond with only the JSON object described in the system message.`;

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
      // give up — caller falls back to treating the whole reply as the explanation
    }
  }
  return null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parses a model reply into an ExplainResult. Tolerates a non-JSON reply by
 *  treating the whole text as the explanation (graceful fallback, like summaries). */
export function parseExplainResponse(text: string): ExplainResult {
  const json = extractJsonObject(text);
  if (json) {
    return {
      concept: str(json.concept),
      explanation: str(json.explanation),
      example: str(json.example),
    };
  }
  return { concept: "", explanation: text.trim(), example: "" };
}

/** Flattens the structure into the plain multi-line text a TextElement carries.
 *  Sections are omitted when empty so a concept-only or example-less result still
 *  reads cleanly. */
export function formatExplainText(result: ExplainResult): string {
  const lines: string[] = [];
  if (result.concept) lines.push(result.concept);
  if (result.explanation) {
    if (lines.length) lines.push("");
    lines.push(result.explanation);
  }
  if (result.example) {
    if (lines.length) lines.push("");
    lines.push(`Example: ${result.example}`);
  }
  return lines.join("\n").trim();
}
