// Pure-logic tests for the explain-selection seam: message assembly (multimodal
// vs text-only), the structured-reply parser (with graceful fallback), and the
// text flattener. No Firestore, no network — mirrors summaryPrompt/ocr tests.

import {
  buildExplainMessages,
  parseExplainResponse,
  formatExplainText,
} from "../ai/explain";

describe("buildExplainMessages", () => {
  it("includes selected text in the user prompt", () => {
    const msgs = buildExplainMessages(undefined, "E = mc^2");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(typeof msgs[1].content).toBe("string");
    expect(msgs[1].content as string).toContain("E = mc^2");
  });

  it("becomes multimodal when an image is supplied", () => {
    const msgs = buildExplainMessages("data:image/png;base64,AAAB", "");
    const parts = msgs[1].content;
    expect(Array.isArray(parts)).toBe(true);
    const arr = parts as Array<{ type: string }>;
    expect(arr.some((p) => p.type === "image_url")).toBe(true);
    expect(arr.some((p) => p.type === "text")).toBe(true);
  });

  it("falls back to relying on the image when there is no text", () => {
    const msgs = buildExplainMessages("data:,x");
    const text = (msgs[1].content as Array<{ type: string; text?: string }>).find(
      (p) => p.type === "text"
    );
    expect(text?.text).toContain("rely on the image");
  });
});

describe("parseExplainResponse", () => {
  it("parses a three-section JSON reply", () => {
    const reply =
      '{"concept":"Pythagorean theorem","explanation":"a^2+b^2=c^2 for right triangles.","example":"3-4-5 triangle."}';
    expect(parseExplainResponse(reply)).toEqual({
      concept: "Pythagorean theorem",
      explanation: "a^2+b^2=c^2 for right triangles.",
      example: "3-4-5 triangle.",
    });
  });

  it("tolerates markdown fences and surrounding prose", () => {
    const reply =
      'Here you go:\n```json\n{"concept":"Big-O","explanation":"Growth rate.","example":""}\n```';
    expect(parseExplainResponse(reply)).toEqual({
      concept: "Big-O",
      explanation: "Growth rate.",
      example: "",
    });
  });

  it("falls back to the whole reply as the explanation when not JSON", () => {
    expect(parseExplainResponse("just a plain sentence")).toEqual({
      concept: "",
      explanation: "just a plain sentence",
      example: "",
    });
  });

  it("coerces non-string fields to empty", () => {
    const reply = '{"concept":42,"explanation":"ok","example":null}';
    expect(parseExplainResponse(reply)).toEqual({
      concept: "",
      explanation: "ok",
      example: "",
    });
  });
});

describe("formatExplainText", () => {
  it("joins the three sections with blank-line separators", () => {
    const text = formatExplainText({
      concept: "Newton's second law",
      explanation: "Force equals mass times acceleration.",
      example: "Pushing a cart.",
    });
    expect(text).toBe(
      "Newton's second law\n\nForce equals mass times acceleration.\n\nExample: Pushing a cart."
    );
  });

  it("omits empty sections", () => {
    expect(formatExplainText({ concept: "", explanation: "Just this.", example: "" })).toBe(
      "Just this."
    );
  });

  it("returns an empty string when everything is empty", () => {
    expect(formatExplainText({ concept: "", explanation: "", example: "" })).toBe("");
  });
});
