// Pure-logic tests for the text→diagram seam: prompt assembly (normal vs. the
// stricter retry), Mermaid extraction (fences / prose), family detection, and the
// validation gate that drives the retry. No Firestore, no network — mirrors
// summaryPrompt/explain/ocr tests.

import {
  buildDiagramMessages,
  extractMermaid,
  detectFamily,
  validateMermaid,
} from "../ai/diagram";

describe("buildDiagramMessages", () => {
  it("puts the prompt in the user turn and the rules in the system turn", () => {
    const msgs = buildDiagramMessages("a login flow");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content as string).toContain("a login flow");
  });

  it("appends the stricter instruction on a retry", () => {
    const normal = buildDiagramMessages("x", false)[0].content as string;
    const strict = buildDiagramMessages("x", true)[0].content as string;
    expect(strict.length).toBeGreaterThan(normal.length);
    expect(strict).toContain("could not be parsed");
  });
});

describe("extractMermaid", () => {
  it("returns bare source unchanged", () => {
    expect(extractMermaid("flowchart TD\n  A --> B")).toBe("flowchart TD\n  A --> B");
  });

  it("unwraps a ```mermaid fenced block", () => {
    const reply = "Here:\n```mermaid\nflowchart TD\n  A --> B\n```\nDone";
    expect(extractMermaid(reply)).toBe("flowchart TD\n  A --> B");
  });

  it("unwraps a plain ``` fenced block", () => {
    expect(extractMermaid("```\nsequenceDiagram\n  A->>B: hi\n```")).toBe(
      "sequenceDiagram\n  A->>B: hi"
    );
  });
});

describe("detectFamily", () => {
  it.each([
    ["flowchart TD\nA-->B", "flowchart"],
    ["graph LR\nA-->B", "flowchart"],
    ["sequenceDiagram\nA->>B: x", "sequence"],
    ["classDiagram\nclass A", "class"],
    ["mindmap\n  root", "mindmap"],
  ])("detects %s", (src, family) => {
    expect(detectFamily(src)).toBe(family);
  });

  it("returns null for prose / unknown types", () => {
    expect(detectFamily("Sure, here is a diagram of the flow")).toBeNull();
    expect(detectFamily("gantt\n  title X")).toBeNull();
  });
});

describe("validateMermaid", () => {
  it("accepts a flowchart with content", () => {
    expect(validateMermaid("flowchart TD\n  A --> B")).toEqual({
      valid: true,
      family: "flowchart",
    });
  });

  it("rejects an empty reply", () => {
    expect(validateMermaid("   ").valid).toBe(false);
  });

  it("rejects an unknown diagram type", () => {
    const v = validateMermaid("pie title Pets\n  Dogs : 10");
    expect(v.valid).toBe(false);
    expect(v.family).toBeNull();
  });

  it("rejects a header with no body (drives the retry)", () => {
    const v = validateMermaid("flowchart TD");
    expect(v.valid).toBe(false);
    expect(v.family).toBe("flowchart");
    expect(v.error).toMatch(/no content/i);
  });
});
