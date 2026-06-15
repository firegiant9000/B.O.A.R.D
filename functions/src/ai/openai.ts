import OpenAI from "openai";
import type {
  AIProvider,
  ChatRequest,
  ChatResult,
  ChatMessage,
} from "./provider";

// OpenAI adapter behind the AIProvider seam. The API key never leaves the
// function runtime — it is read from the `OPENAI_API_KEY` secret and passed in by
// the caller, never shipped to the client (the whole point of Phase 1).

/** Logical tiers the rest of the code asks for, mapped here to concrete models.
 *  Changing a model is a one-line edit in this map (Appendix B.5). */
const MODEL_MAP: Record<string, string> = {
  "summary-text": "gpt-3.5-turbo",
  "summary-vision": "gpt-4o-mini",
  // Phase 10 — handwriting OCR escalation when Google Vision is low-confidence.
  "ocr-vision": "gpt-4o-mini",
  // Phase 11 — explain selection (vision tier so an image-only selection works).
  "explain-vision": "gpt-4o-mini",
  // Phase 12 — text → diagram. Text-only (returns Mermaid syntax), so no vision tier.
  "diagram-text": "gpt-4o-mini",
};

export function resolveModel(tier: string): string {
  return MODEL_MAP[tier] ?? tier;
}

function toOpenAIMessages(
  messages: ChatMessage[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  // The provider's ChatMessage shape is intentionally OpenAI-compatible; the cast
  // is the seam where a different provider would translate instead.
  return messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[];
}

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const model = resolveModel(req.model);
    const completion = await this.client.chat.completions.create({
      model,
      messages: toOpenAIMessages(req.messages),
      max_tokens: req.maxTokens ?? 300,
      temperature: req.temperature ?? 0.7,
    });

    const text = completion.choices?.[0]?.message?.content?.trim() ?? "";
    const usage = completion.usage;

    return {
      text,
      model: completion.model ?? model,
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
    };
  }
}
