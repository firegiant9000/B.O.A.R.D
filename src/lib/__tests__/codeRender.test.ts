import {
  CODE_DEFAULT_FONT_SIZE,
  CODE_DEFAULT_FOREGROUND,
  CODE_LANGUAGES,
  codeTransform,
  isCodeLanguage,
  layoutCodeBox,
  tokenizeCode,
} from "../codeRender";
import type { CodeLanguage } from "../../types";

// A representative snippet per supported language — each one deliberately
// mixes a keyword with an identifier/literal so a real tokenizer produces
// MORE than one run per line and MORE than one distinct color. A tokenizer
// that returned "one undifferentiated run per line" (the brief's own
// cautionary example) would fail every assertion below that checks for a
// second color or a split run, not just a "non-empty array" check.
const SAMPLES: Record<CodeLanguage, string> = {
  ts: "const total: number = 1;",
  js: "const total = 1;",
  py: "def total():\n    return 1",
  java: "class Total { int x = 1; }",
  c: "int total() { return 1; }",
  cpp: "int total() { return 1; }",
  sql: "SELECT id FROM users WHERE id = 1;",
  json: '{"total": 1}',
  bash: 'echo "$TOTAL"',
};

describe("CODE_LANGUAGES", () => {
  it("is exactly the brief's nine grammars, in the brief's order", () => {
    expect(CODE_LANGUAGES).toEqual(["ts", "js", "py", "java", "c", "cpp", "sql", "json", "bash"]);
  });

  it("accepts every supported language and rejects an unsupported one", () => {
    for (const lang of CODE_LANGUAGES) {
      expect(isCodeLanguage(lang)).toBe(true);
    }
    expect(isCodeLanguage("python")).toBe(false); // the Shiki grammar name, not the brief's key
    expect(isCodeLanguage("rust")).toBe(false);
    expect(isCodeLanguage(42)).toBe(false);
    expect(isCodeLanguage(undefined)).toBe(false);
  });
});

describe("tokenizeCode", () => {
  it.each(CODE_LANGUAGES)("produces more than one colored run for %s", (lang) => {
    const lines = tokenizeCode(SAMPLES[lang], lang);
    const totalRuns = lines.reduce((n, line) => n + line.length, 0);
    const colors = new Set(lines.flatMap((line) => line.map((r) => r.color)));
    // A tokenizer returning one undifferentiated run per line would have
    // totalRuns === lines.length and colors.size === 1; a real grammar match
    // splits keywords/identifiers/literals apart with different colors.
    expect(totalRuns).toBeGreaterThan(lines.length);
    expect(colors.size).toBeGreaterThan(1);
  });

  it("round-trips the run content back to the original line text", () => {
    const lines = tokenizeCode(SAMPLES.ts, "ts");
    const rebuilt = lines.map((line) => line.map((r) => r.content).join("")).join("\n");
    expect(rebuilt).toBe(SAMPLES.ts);
  });

  it("falls back to one uncolored run per non-empty line for an unrecognized language", () => {
    // A corrupt/future-schema document (see CodeElement's type comment) must
    // not crash or blank the element — every char is still shown, just
    // unhighlighted.
    const lines = tokenizeCode("a\nb", "cobol" as CodeLanguage);
    expect(lines).toEqual([
      [{ content: "a", color: CODE_DEFAULT_FOREGROUND }],
      [{ content: "b", color: CODE_DEFAULT_FOREGROUND }],
    ]);
  });

  it("tokenizes an empty string as a single empty line, not an error", () => {
    expect(tokenizeCode("", "ts")).toEqual([[]]);
  });

  it("splits multi-line input into one entry per line", () => {
    const lines = tokenizeCode(SAMPLES.py, "py");
    expect(lines).toHaveLength(2);
  });
});

describe("layoutCodeBox", () => {
  it("grows taller with more lines, holding fontSize/width inputs fixed", () => {
    const one = layoutCodeBox("x", 14);
    const three = layoutCodeBox("x\nx\nx", 14);
    expect(three.height).toBeGreaterThan(one.height);
    // Exactly two more line-heights of height, since padding is unchanged.
    expect(three.height - one.height).toBeCloseTo(2 * one.lineHeight, 5);
  });

  it("grows wider with a longer line", () => {
    const short = layoutCodeBox("x", 14);
    const long = layoutCodeBox("x".repeat(40), 14);
    expect(long.width).toBeGreaterThan(short.width);
  });

  it("scales up with fontSize", () => {
    const small = layoutCodeBox("code", 10);
    const big = layoutCodeBox("code", 30);
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.height).toBeGreaterThan(small.height);
    expect(big.lineHeight).toBeGreaterThan(small.lineHeight);
  });

  it("fails closed to CODE_DEFAULT_FONT_SIZE for a non-finite fontSize", () => {
    const poisoned = layoutCodeBox("code", NaN);
    const fallback = layoutCodeBox("code", CODE_DEFAULT_FONT_SIZE);
    expect(poisoned).toEqual(fallback);
  });

  it("fails closed to CODE_DEFAULT_FONT_SIZE for a zero/negative fontSize", () => {
    expect(layoutCodeBox("code", 0)).toEqual(layoutCodeBox("code", CODE_DEFAULT_FONT_SIZE));
    expect(layoutCodeBox("code", -5)).toEqual(layoutCodeBox("code", CODE_DEFAULT_FONT_SIZE));
  });

  it("lays out an empty string as a single minimal line", () => {
    const empty = layoutCodeBox("", 14);
    const one = layoutCodeBox("x", 14);
    expect(empty.height).toBeCloseTo(one.height, 5);
  });
});

describe("codeTransform", () => {
  it("returns an empty string when there is no rotation", () => {
    expect(codeTransform({ x: 0, y: 0, width: 100, height: 40 })).toBe("");
    expect(codeTransform({ x: 0, y: 0, width: 100, height: 40, rotation: 0 })).toBe("");
  });

  it("rotates about the box center", () => {
    const t = codeTransform({ x: 10, y: 20, width: 100, height: 40, rotation: 45 });
    expect(t).toBe("rotate(45, 60, 40)");
  });

  it("fails closed on non-finite geometry instead of emitting NaN", () => {
    const t = codeTransform({
      x: NaN,
      y: NaN,
      width: NaN,
      height: NaN,
      rotation: 30,
    });
    expect(t).not.toMatch(/NaN/);
    expect(t).toBe("rotate(30, 0, 0)");
  });
});
