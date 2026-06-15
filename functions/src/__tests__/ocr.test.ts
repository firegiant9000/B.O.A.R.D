// Pure-logic tests for the OCR engine seam: Vision response parsing, the
// LLM-reply parser, the Vision-first/escalate decision, and the cache key. No
// Firestore, no network (deps injected) — mirrors summaryPrompt/rateLimit tests.

import { parseVisionResponse, toBase64Content, type VisionClient } from "../ai/vision";
import {
  parseOcrResponse,
  recognizeImage,
  OCR_CONFIDENCE_THRESHOLD,
  VISION_MODEL,
} from "../ai/ocr";
import { ocrCacheKey } from "../ai/ocrCache";
import type { AIProvider } from "../ai/provider";

describe("toBase64Content", () => {
  it("strips a data URL prefix", () => {
    expect(toBase64Content("data:image/png;base64,AAAB")).toBe("AAAB");
  });
  it("passes a bare base64 string through", () => {
    expect(toBase64Content("AAAB")).toBe("AAAB");
  });
});

describe("parseVisionResponse", () => {
  it("extracts text and averages page confidence", () => {
    const body = {
      responses: [
        {
          fullTextAnnotation: {
            text: "Hello\nworld",
            pages: [{ confidence: 0.8 }, { confidence: 0.6 }],
          },
        },
      ],
    };
    expect(parseVisionResponse(body)).toEqual({ text: "Hello\nworld", confidence: 0.7 });
  });

  it("returns zero confidence when nothing is detected", () => {
    expect(parseVisionResponse({ responses: [{}] })).toEqual({ text: "", confidence: 0 });
  });
});

describe("parseOcrResponse", () => {
  it("parses a JSON reply", () => {
    expect(parseOcrResponse('{"text":"Big-O","confidence":0.55}')).toEqual({
      text: "Big-O",
      confidence: 0.55,
    });
  });
  it("clamps an out-of-range confidence", () => {
    expect(parseOcrResponse('{"text":"x","confidence":2}').confidence).toBe(1);
  });
  it("falls back to plain text at a default confidence", () => {
    expect(parseOcrResponse("just some text")).toEqual({ text: "just some text", confidence: 0.8 });
  });
});

describe("recognizeImage", () => {
  const provider: AIProvider = {
    chat: jest.fn(async () => ({
      text: '{"text":"clean text","confidence":0.9}',
      model: "gpt-4o-mini",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    })),
  };

  beforeEach(() => jest.clearAllMocks());

  it("returns Vision without escalating when confidence is at/above threshold", async () => {
    const vision: VisionClient = {
      detectHandwriting: jest.fn(async () => ({
        text: "vision text",
        confidence: OCR_CONFIDENCE_THRESHOLD,
      })),
    };
    const out = await recognizeImage({ vision, provider, imageDataUrl: "data:,x" });
    expect(out.source).toBe("vision");
    expect(out.model).toBe(VISION_MODEL);
    expect(provider.chat).not.toHaveBeenCalled();
    expect(out.paidCalls).toHaveLength(1);
    expect(out.paidCalls[0].flatCostUsd).toBeGreaterThan(0);
  });

  it("escalates to the LLM below threshold and records both paid calls", async () => {
    const vision: VisionClient = {
      detectHandwriting: jest.fn(async () => ({ text: "vsn", confidence: 0.4 })),
    };
    const out = await recognizeImage({ vision, provider, imageDataUrl: "data:,x" });
    expect(out.source).toBe("gpt");
    expect(out.text).toBe("clean text");
    expect(out.paidCalls).toHaveLength(2);
  });

  it("escalates when Vision finds no text even at high confidence", async () => {
    const vision: VisionClient = {
      detectHandwriting: jest.fn(async () => ({ text: "", confidence: 0.99 })),
    };
    const out = await recognizeImage({ vision, provider, imageDataUrl: "data:,x" });
    expect(out.source).toBe("gpt");
  });
});

describe("ocrCacheKey", () => {
  it("is order-independent over the path ids", () => {
    expect(ocrCacheKey(["a", "b", "c"])).toBe(ocrCacheKey(["c", "a", "b"]));
  });
  it("differs when the selection differs", () => {
    expect(ocrCacheKey(["a", "b"])).not.toBe(ocrCacheKey(["a", "b", "c"]));
  });
});
