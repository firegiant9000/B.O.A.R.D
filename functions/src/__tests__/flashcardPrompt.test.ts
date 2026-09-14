import {
  buildFlashcardMessages,
  parseFlashcardResponse,
  MAX_FLASHCARDS_PER_GENERATION,
} from "../ai/flashcardPrompt";
import { flashcardCacheKey } from "../ai/flashcardCache";

describe("buildFlashcardMessages", () => {
  it("includes the selected text in a text-only message", () => {
    const messages = buildFlashcardMessages("Mitochondria is the powerhouse of the cell.");
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("user");
    expect(typeof messages[1].content).toBe("string");
    expect(messages[1].content as string).toContain("Mitochondria is the powerhouse");
  });

  it("builds a multimodal message when an image is present", () => {
    const messages = buildFlashcardMessages(undefined, "data:image/png;base64,AA");
    const content = messages[1].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image_url" }),
        expect.objectContaining({ type: "text" }),
      ])
    );
  });

  it("notes the absence of transcribed text when only an image is given", () => {
    const messages = buildFlashcardMessages(undefined, "data:image/png;base64,AA");
    const textPart = (messages[1].content as any[]).find((p) => p.type === "text");
    expect(textPart.text).toMatch(/no transcribed text/i);
  });
});

describe("parseFlashcardResponse", () => {
  it("parses a clean JSON array", () => {
    const text = '[{"front":"2+2","back":"4"},{"front":"Capital of France","back":"Paris"}]';
    expect(parseFlashcardResponse(text)).toEqual([
      { front: "2+2", back: "4" },
      { front: "Capital of France", back: "Paris" },
    ]);
  });

  it("recovers from markdown code fences", () => {
    const text = '```json\n[{"front":"a","back":"b"}]\n```';
    expect(parseFlashcardResponse(text)).toEqual([{ front: "a", back: "b" }]);
  });

  it("recovers a JSON array embedded in prose via bracket-slice recovery", () => {
    const text = 'Here are your cards:\n[{"front":"a","back":"b"}]\nEnjoy studying!';
    expect(parseFlashcardResponse(text)).toEqual([{ front: "a", back: "b" }]);
  });

  it("drops entries missing a front or back", () => {
    const text = '[{"front":"a","back":"b"},{"front":"","back":"c"},{"back":"only-back"},{"front":"only-front"}]';
    expect(parseFlashcardResponse(text)).toEqual([{ front: "a", back: "b" }]);
  });

  it("caps the result at MAX_FLASHCARDS_PER_GENERATION even when the model over-produces", () => {
    const many = Array.from({ length: MAX_FLASHCARDS_PER_GENERATION + 5 }, (_, i) => ({
      front: `q${i}`,
      back: `a${i}`,
    }));
    const result = parseFlashcardResponse(JSON.stringify(many));
    expect(result).toHaveLength(MAX_FLASHCARDS_PER_GENERATION);
    expect(result[0]).toEqual({ front: "q0", back: "a0" });
  });

  it("returns an empty list for unparseable text rather than throwing", () => {
    expect(parseFlashcardResponse("not json at all")).toEqual([]);
  });

  it("returns an empty list for an explicit empty array", () => {
    expect(parseFlashcardResponse("[]")).toEqual([]);
  });

  it("returns an empty list when the reply is a JSON object, not an array", () => {
    expect(parseFlashcardResponse('{"front":"a","back":"b"}')).toEqual([]);
  });
});

// Real (unmocked) hash behavior — mirrors ocr.test.ts's own direct assertions
// on ocrCacheKey, which this function's construction is identical to.
describe("flashcardCacheKey", () => {
  it("is order-independent over the same set of ids", () => {
    expect(flashcardCacheKey(["a", "b", "c"])).toBe(flashcardCacheKey(["c", "a", "b"]));
  });

  it("differs for a different set of ids", () => {
    expect(flashcardCacheKey(["a", "b"])).not.toBe(flashcardCacheKey(["a", "b", "c"]));
  });
});
