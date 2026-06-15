// AI provider seam (Appendix B.5: "model name is one config change"). Every AI
// phase (summary now; OCR / explain / diagram later) talks to this interface, not
// to OpenAI directly, so swapping providers or models is a single adapter change.

/** A chat message. `content` is either plain text or a multimodal part list
 *  (text + image) so the same shape carries vision requests. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export interface ChatRequest {
  /** Logical model tier. The adapter maps this to a concrete provider model. */
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  text: string;
  /** The concrete provider model that served the request (for cost logging). */
  model: string;
  usage: ChatUsage;
}

/** The contract every AI phase depends on. One method today; later phases add
 *  their own thin wrappers on top of `chat` rather than reinventing transport. */
export interface AIProvider {
  chat(req: ChatRequest): Promise<ChatResult>;
}
