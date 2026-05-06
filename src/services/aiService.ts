import AsyncStorage from "@react-native-async-storage/async-storage";
import { doc, getDoc, setDoc, deleteField } from "firebase/firestore";
import { db, auth } from "../config/firebase";
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
        AsyncStorage.setItem(STORAGE_KEY, _apiKey!).catch(() => {});
        return;
      }
    } catch {}
  }
  // Fall back to local cache if Firestore unavailable or user not signed in
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored) _apiKey = stored;
  } catch {}
}

export async function setOpenAIKey(key: string): Promise<void> {
  _apiKey = key;
  AsyncStorage.setItem(STORAGE_KEY, key).catch(() => {});
  const uid = auth.currentUser?.uid;
  if (uid) {
    await setDoc(privateKeyDoc(uid), { openaiKey: key }, { merge: true });
  }
}

export async function clearOpenAIKey(): Promise<void> {
  _apiKey = null;
  AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  const uid = auth.currentUser?.uid;
  if (uid) {
    await setDoc(privateKeyDoc(uid), { openaiKey: deleteField() }, { merge: true });
  }
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
  context: SessionContext,
  imageDataUrl?: string
): Promise<string> {
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

  return summary;
}
