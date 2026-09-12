import type { ChatMessage } from "./provider";
import type { FlashcardPair } from "./flashcardCache";

// Pure prompt assembly + parse for flashcard generation (Month 6). Kept pure (no
// Firestore, no network) so it is unit-tested without an emulator — mirrors
// explain.ts/summaryPrompt.ts. The model turns a board selection (transcribed
// text and/or an image) into a bounded set of front/back study-card pairs.

/** Output cap — a generation call is capped at this many cards regardless of
 *  how much the model tries to return, so one selection can't produce an
 *  unbounded write (cost + a deck that's unreviewable in one sitting). */
export const MAX_FLASHCARDS_PER_GENERATION = 10;

const SYSTEM_PROMPT = `You turn a selected region of a collaborative whiteboard into study flashcards.
You receive any transcribed text from the selection and (if present) an image of it.
Respond with ONLY a JSON array (no markdown fences, no prose around it) of objects matching exactly this shape:
[{"front": string, "back": string}, ...]
- "front": a short question or prompt (a term, a question, a fill-in-the-blank).
- "back": the answer or definition.
Generate as many distinct cards as the content naturally supports, up to ${MAX_FLASHCARDS_PER_GENERATION}. Base every card on what is actually in the selection — never invent unrelated content. If nothing quizzable is present, respond with an empty array [].`;

function formatSelectionText(selectionText?: string): string {
  const trimmed = (selectionText ?? "").trim();
  if (!trimmed) {
    return "The selection contains no transcribed text; rely on the image.";
  }
  return `Selected text:\n${trimmed}`;
}

/** Assembles the message list. When `imageDataUrl` is present the user turn
 *  becomes multimodal (vision) so the model can read strokes/sketches the text
 *  doesn't capture; the caller picks the vision-capable model tier. */
export function buildFlashcardMessages(
  selectionText?: string,
  imageDataUrl?: string
): ChatMessage[] {
  const userText = `Generate flashcards for the selected content.\n\n${formatSelectionText(selectionText)}\n\nRespond with only the JSON array described in the system message.`;

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

/** Pulls a JSON array out of a model reply, tolerating markdown code fences or
 *  leading/trailing prose — mirrors explain.ts's `extractJsonObject`, but for
 *  an array envelope. Returns null when no parseable array is found. */
function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "");
  try {
    const parsed = JSON.parse(trimmed.trim());
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to bracket-slice recovery
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // give up — caller treats this as "no cards"
    }
  }
  return null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parses a model reply into a bounded list of front/back pairs. Drops any
 *  entry missing a non-empty front or back (a tolerant reader, not a thrower —
 *  a malformed single entry shouldn't fail the whole generation) and caps the
 *  result at `MAX_FLASHCARDS_PER_GENERATION` regardless of what the model
 *  returned. A non-JSON or unparseable reply yields an empty list, which the
 *  caller surfaces as "no flashcards found" rather than an internal error. */
export function parseFlashcardResponse(text: string): FlashcardPair[] {
  const json = extractJsonArray(text);
  if (!json) return [];

  const cards: FlashcardPair[] = [];
  for (const entry of json) {
    if (!entry || typeof entry !== "object") continue;
    const front = str((entry as Record<string, unknown>).front);
    const back = str((entry as Record<string, unknown>).back);
    if (!front || !back) continue;
    cards.push({ front, back });
    if (cards.length >= MAX_FLASHCARDS_PER_GENERATION) break;
  }
  return cards;
}
