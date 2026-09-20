import type { ChatMessage } from "./provider";

// Month 6 — board Q&A prompt assembly and answer parsing. Pure string work,
// split out of the callable exactly like summaryPrompt.ts / flashcardPrompt.ts
// so every bound and every parse is unit-tested without Firestore, a provider
// or the Functions runtime.
//
// CITATIONS ARE THE POINT, not decoration. ROADMAP.md's own failure-mode table
// gives "always cite source element IDs in the answer; user can click to
// verify" as THE mitigation for a model inventing board content, and the
// trigger that writes these embeddings deletes an element's embedding on
// delete for the same reason — a citation that resolves to nothing is the
// thing that whole cleanup path exists to prevent. So:
//   - the model is told to mark each claim with the id it came from;
//   - `parseCitedIds` INTERSECTS what it marked with what retrieval actually
//     returned, so an id the model invented is dropped rather than shown to a
//     user as something they can click;
//   - `stripCitationMarkers` takes the markers back out of the prose, because
//     the client renders citations as its own affordance and raw `[[abc123]]`
//     in the middle of a sentence is not an answer anyone wants to read.
//
// EVERY BOUND HERE IS A COST BOUND. This is the first feature in the product
// where the client controls how much text reaches a paid model on every
// keystroke-driven request: the question, the multi-turn history the client
// replays, and the retrieved context all scale with someone else's input. A
// server that trusts any of the three has no ceiling on a single call's price.

/** Marker the model is asked to emit, e.g. `[[Xy12abc]]`. Captured lazily and
 *  without whitespace so a stray `[[` in board content can't swallow prose. */
const CITATION_MARKER = /\[\[([^\][\s]+)\]\]/g;

/** Longest question accepted. Past this the caller is not asking a question,
 *  it is pasting a payload into the prompt at the workspace's expense. */
export const MAX_QUESTION_CHARS = 500;

/** Most prior turns replayed into a follow-up. The client owns the thread, so
 *  the history arrives from the client and is bounded HERE — trusting it would
 *  let a patched client grow one request's prompt without limit. */
export const MAX_HISTORY_TURNS = 6;

/** Longest one replayed turn may be. */
export const MAX_HISTORY_CHARS = 400;

/** Longest one retrieved element's text may be in the context block. Board
 *  content is user-authored and has no length cap of its own. */
export const MAX_CHUNK_CHARS = 800;

/** How many nearest elements retrieval asks Firestore for. Small on purpose:
 *  every chunk is prompt tokens on every question, and the k+1'th match on a
 *  board is rarely what answers it. */
export const RETRIEVAL_TOP_K = 6;

/** One retrieved element: the id a citation points at, its kind (which is what
 *  lets a reader resolve the id back to a real element), and the text that was
 *  embedded for it. */
export interface RetrievedChunk {
  elementId: string;
  elementType: string;
  text: string;
}

/** One prior turn in the thread, as the client replays it. */
export interface QaTurn {
  role: "user" | "assistant";
  text: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Trims a client-supplied thread down to what the server is willing to pay to
 * replay: the most recent `MAX_HISTORY_TURNS`, each truncated, with blank and
 * malformed entries dropped. Returns a NEW array — the caller's own is never
 * mutated.
 *
 * Takes `unknown` rather than `QaTurn[]` deliberately: this value arrives
 * straight off the wire from a client, so its shape is a claim, not a fact. A
 * signature that said `QaTurn[]` would be a lie that pushed the validation
 * somewhere less careful.
 */
export function boundHistory(raw: unknown): QaTurn[] {
  if (!Array.isArray(raw)) return [];
  const clean: QaTurn[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { role, text } = entry as { role?: unknown; text?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof text !== "string" || !text.trim()) continue;
    clean.push({ role, text: truncate(text.trim(), MAX_HISTORY_CHARS) });
  }
  // Keep the MOST RECENT turns, not the first: a long thread's early turns are
  // the ones a follow-up needs least.
  return clean.slice(-MAX_HISTORY_TURNS);
}

/** The retrieved elements as the model sees them — each labelled with the id it
 *  must cite. Exported so a test can assert the id really is in the prompt: a
 *  model cannot cite an id it was never shown. */
export function buildContextBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (c) =>
        `[[${c.elementId}]] (${c.elementType})\n${truncate(c.text.trim(), MAX_CHUNK_CHARS)}`
    )
    .join("\n\n");
}

const SYSTEM_PROMPT = [
  "You answer questions about the contents of a shared whiteboard.",
  "You are given numbered excerpts from that board. Each excerpt begins with an",
  "element id in double square brackets, like [[abc123]].",
  "",
  "Rules:",
  "- Answer ONLY from the excerpts provided. They are the whole of what you know",
  "  about this board.",
  "- After each claim, cite the excerpt it came from by repeating its id in double",
  "  square brackets, exactly as it was given to you.",
  "- Never invent an element id. Only ids that appear in the excerpts are real.",
  "- If the excerpts do not answer the question, say so plainly instead of",
  "  guessing. Saying you cannot find it on the board is a correct answer.",
  "- Be brief. Two or three sentences is usually right.",
].join("\n");

/**
 * The full message list for one question. Prior turns go in as real
 * `assistant`/`user` messages (so the model sees a conversation, which is what
 * makes a follow-up like "why?" resolvable at all), and the retrieved context
 * rides on the final user message rather than the system prompt — the context
 * is different on every turn, while the instructions are not.
 */
export function buildBoardQaMessages(
  question: string,
  chunks: RetrievedChunk[],
  history: QaTurn[] = []
): ChatMessage[] {
  const context = buildContextBlock(chunks);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((t) => ({ role: t.role, content: t.text })),
    {
      role: "user",
      content: `Excerpts from the board:\n\n${context}\n\nQuestion: ${question.trim()}`,
    },
  ];
}

/**
 * The element ids the model cited, restricted to ids retrieval actually
 * returned, de-duplicated, in the order they first appear in the answer.
 *
 * The intersection is the load-bearing half. A model asked for ids will
 * occasionally produce one that looks plausible and does not exist; shipping
 * that to the client would put a tappable citation on the screen that resolves
 * to nothing — the precise failure the deletion-cleanup path on the write side
 * was built to prevent, reintroduced from the other end. `allowed` is the set
 * of ids whose elements retrieval has already confirmed still exist, so an id
 * outside it is either invented or stale, and neither is citable.
 */
export function parseCitedIds(answerText: string, allowed: Iterable<string>): string[] {
  const allowedSet = new Set(allowed);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of answerText.matchAll(CITATION_MARKER)) {
    const id = match[1];
    if (!allowedSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The answer with its `[[id]]` markers removed and the whitespace they leave
 * behind tidied. The ids still reach the client — as a structured citation
 * list — so nothing is lost by taking them out of the prose; what is gained is
 * an answer a person can read.
 */
export function stripCitationMarkers(answerText: string): string {
  return answerText
    .replace(CITATION_MARKER, "")
    // A marker sitting between a word and its punctuation leaves " ." behind.
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
