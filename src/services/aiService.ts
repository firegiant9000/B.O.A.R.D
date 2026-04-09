import * as pathService from "./pathService";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Set your OpenAI API key here, or replace with an environment variable loader.
 * For production, move this to a server-side Cloud Function.
 */
let _apiKey: string | null = null;

export function setOpenAIKey(key: string) {
  _apiKey = key;
}

export function getOpenAIKey(): string | null {
  return _apiKey;
}

interface SessionContext {
  sessionTitle: string;
  boardTitle: string;
  durationMinutes: number;
  participantCount: number;
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

/**
 * Generates an AI-powered summary of a board session using the OpenAI API.
 * Returns the summary text, or throws if the API call fails.
 */
export async function generateSessionSummary(
  boardId: string,
  context: SessionContext
): Promise<string> {
  if (!_apiKey) {
    throw new Error(
      "OpenAI API key not configured. Go to Profile > Settings to add your API key."
    );
  }

  const boardContent = await gatherBoardContent(boardId);

  const systemPrompt = `You are a helpful assistant that summarizes collaboration sessions.
Given the session metadata and board content, write a concise summary (3-5 sentences) of what was discussed or worked on.
Focus on key topics, decisions, and action items. Be specific and useful.`;

  const userPrompt = `Session: "${context.sessionTitle}"
Board: "${context.boardTitle}"
Duration: ${context.durationMinutes} minutes
Participants: ${context.participantCount} people

Board content:
${boardContent}

Please provide a brief session summary.`;

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${_apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
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

  return summary;
}
