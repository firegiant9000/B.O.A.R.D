import {
  formatBoardContent,
  buildSummaryUserPrompt,
  buildSummaryMessages,
  parseSummaryResponse,
} from "../ai/summaryPrompt";

const ctx = {
  sessionTitle: "Study",
  boardTitle: "Board",
  durationMinutes: 30,
  participantCount: 2,
};

describe("formatBoardContent", () => {
  it("falls back to the no-content note when empty", () => {
    expect(formatBoardContent({ notes: [], textElements: [] })).toMatch(
      /No text content was found/
    );
  });

  it("lists notes and text elements, dropping blank text", () => {
    const out = formatBoardContent({
      notes: ["Big-O"],
      textElements: ["recurrence", "   "],
    });
    expect(out).toContain('Sticky notes on the board:');
    expect(out).toContain('1. "Big-O"');
    expect(out).toContain('Text elements on the canvas:');
    expect(out).toContain('1. "recurrence"');
    // the whitespace-only text element is filtered out
    expect(out).not.toContain('2. "   "');
  });
});

describe("buildSummaryUserPrompt", () => {
  it("embeds session metadata", () => {
    const p = buildSummaryUserPrompt(ctx, { notes: [], textElements: [] });
    expect(p).toContain('Session: "Study"');
    expect(p).toContain("Duration: 30 minutes");
    expect(p).toContain("Participants: 2 people");
  });

  it("biases toward a TL;DR in short mode and a full breakdown otherwise", () => {
    const empty = { notes: [], textElements: [] };
    expect(buildSummaryUserPrompt({ ...ctx, mode: "short" }, empty)).toMatch(/Keep this brief/);
    expect(buildSummaryUserPrompt({ ...ctx, mode: "detailed" }, empty)).toMatch(/Be thorough/);
    // default (no mode) is the detailed breakdown
    expect(buildSummaryUserPrompt(ctx, empty)).toMatch(/Be thorough/);
  });
});

describe("parseSummaryResponse", () => {
  it("parses a clean JSON object into the structured shape", () => {
    const out = parseSummaryResponse(
      '{"tldr":"Did stuff","actionItems":["a","b"],"decisions":["d"],"openQuestions":[]}'
    );
    expect(out).toEqual({
      tldr: "Did stuff",
      actionItems: ["a", "b"],
      decisions: ["d"],
      openQuestions: [],
    });
  });

  it("recovers JSON wrapped in markdown fences or surrounding prose", () => {
    const out = parseSummaryResponse(
      'Here you go:\n```json\n{"tldr":"X","actionItems":[],"decisions":[],"openQuestions":[]}\n```'
    );
    expect(out.tldr).toBe("X");
  });

  it("falls back to TL;DR-only on a non-JSON reply", () => {
    const out = parseSummaryResponse("Just some prose, no JSON here.");
    expect(out).toEqual({
      tldr: "Just some prose, no JSON here.",
      actionItems: [],
      decisions: [],
      openQuestions: [],
    });
  });

  it("drops non-string and blank array entries", () => {
    const out = parseSummaryResponse(
      '{"tldr":"X","actionItems":["keep",2,"  "],"decisions":null,"openQuestions":[]}'
    );
    expect(out.actionItems).toEqual(["keep"]);
    expect(out.decisions).toEqual([]);
  });
});

describe("buildSummaryMessages", () => {
  it("produces a text-only user turn without an image", () => {
    const msgs = buildSummaryMessages(ctx, { notes: [], textElements: [] });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(typeof msgs[1].content).toBe("string");
  });

  it("produces a multimodal user turn with an image", () => {
    const msgs = buildSummaryMessages(
      ctx,
      { notes: [], textElements: [] },
      "data:image/png;base64,AAAA"
    );
    const content = msgs[1].content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
    expect(parts.some((p) => p.type === "text")).toBe(true);
  });
});
