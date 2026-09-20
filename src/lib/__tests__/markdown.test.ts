import { parseMarkdown, isSafeLinkUrl, MarkdownRun } from "../markdown";

describe("isSafeLinkUrl (allow-list, deny-by-default)", () => {
  it("allows http and https", () => {
    expect(isSafeLinkUrl("http://example.com")).toBe(true);
    expect(isSafeLinkUrl("https://example.com/path?x=1")).toBe(true);
  });

  it("allows mailto", () => {
    expect(isSafeLinkUrl("mailto:alice@example.com")).toBe(true);
  });

  it("rejects javascript:", () => {
    expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects data:", () => {
    expect(isSafeLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects file:", () => {
    expect(isSafeLinkUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects an unrecognized scheme (fail closed, not a deny-list)", () => {
    expect(isSafeLinkUrl("ftp://example.com")).toBe(false);
    expect(isSafeLinkUrl("intent://evil")).toBe(false);
  });

  it("rejects a schemeless / protocol-relative URL", () => {
    expect(isSafeLinkUrl("evil.com")).toBe(false);
    expect(isSafeLinkUrl("//evil.com/x")).toBe(false);
  });

  // The brief's named traps: each is a case a naive check could slip past.
  it("rejects mixed-case javascript:", () => {
    expect(isSafeLinkUrl("JavaScript:alert(1)")).toBe(false);
  });

  // The case above is rejected either way ("JavaScript" isn't in the
  // allow-list regardless of case) — this is the test that actually
  // isolates the lower-casing step: an ALLOWED scheme typed in a
  // different case must still be recognized, or a naive exact-case
  // comparison would wrongly reject a perfectly legitimate link.
  it("allows an allow-listed scheme typed in a different case", () => {
    expect(isSafeLinkUrl("HTTPS://example.com")).toBe(true);
    expect(isSafeLinkUrl("MailTo:alice@example.com")).toBe(true);
  });

  it("rejects javascript: with leading whitespace", () => {
    // Denied even without `.trim()` at all (leading whitespace means the
    // scheme regex's required leading letter never matches) — kept as a
    // named regression test for the brief's exact wording, but
    // "still allows a legitimate URL with leading/trailing whitespace"
    // below is what actually isolates the `.trim()` call itself.
    expect(isSafeLinkUrl("   javascript:alert(1)")).toBe(false);
  });

  it("rejects javascript: with an embedded newline splitting the scheme", () => {
    // A check that first strips/collapses all whitespace (to tolerate the
    // leading-whitespace case above) would reassemble this into a clean
    // "javascript:alert(1)" and wrongly allow it. isSafeLinkUrl must not.
    expect(isSafeLinkUrl("java\nscript:alert(1)")).toBe(false);
  });

  // The case above is caught by the scheme regex alone (a `\n` mid-scheme
  // already breaks the match) — this one isolates the SEPARATE control-
  // character check: a perfectly valid "https" scheme with a control
  // character later in the URL. Without that check specifically, this would
  // be allowed (the scheme regex only ever looks at the prefix before the
  // first colon, never the rest of the string).
  it("rejects an otherwise-valid https URL carrying an embedded control character after the scheme", () => {
    expect(isSafeLinkUrl("https://example.com/\npath")).toBe(false);
    expect(isSafeLinkUrl("https://example.com/\u0000path")).toBe(false);
  });

  it("still allows a legitimate URL with leading/trailing whitespace", () => {
    expect(isSafeLinkUrl("  https://example.com  ")).toBe(true);
  });
});

function findRun(runs: MarkdownRun[], text: string): MarkdownRun | undefined {
  return runs.find((r) => r.text === text);
}

describe("parseMarkdown — bold", () => {
  it("recognizes **bold**", () => {
    const [block] = parseMarkdown("this is **bold** text");
    const run = findRun(block.runs, "bold");
    expect(run).toBeDefined();
    expect(run!.bold).toBe(true);
    expect(run!.italic).toBe(false);
  });

  it("recognizes __bold__", () => {
    const [block] = parseMarkdown("this is __bold__ text");
    const run = findRun(block.runs, "bold");
    expect(run!.bold).toBe(true);
  });

  it("leaves surrounding plain text as separate, unstyled runs", () => {
    const [block] = parseMarkdown("before **bold** after");
    expect(block.runs.map((r) => ({ text: r.text, bold: r.bold }))).toEqual([
      { text: "before ", bold: false },
      { text: "bold", bold: true },
      { text: " after", bold: false },
    ]);
  });
});

describe("parseMarkdown — italic", () => {
  it("recognizes *italic*", () => {
    const [block] = parseMarkdown("this is *italic* text");
    const run = findRun(block.runs, "italic");
    expect(run!.italic).toBe(true);
    expect(run!.bold).toBe(false);
  });

  it("recognizes _italic_", () => {
    const [block] = parseMarkdown("this is _italic_ text");
    const run = findRun(block.runs, "italic");
    expect(run!.italic).toBe(true);
  });

  it("does not confuse **bold** for two adjacent *italic* spans", () => {
    const [block] = parseMarkdown("**bold**");
    expect(block.runs).toHaveLength(1);
    expect(block.runs[0]).toMatchObject({ text: "bold", bold: true, italic: false });
  });
});

describe("parseMarkdown — lists", () => {
  it("recognizes an unordered list item starting with '- '", () => {
    const [block] = parseMarkdown("- first item");
    expect(block.type).toBe("list-item");
    expect(block.marker).toBe("•");
    expect(block.runs[0].text).toBe("first item");
  });

  it("recognizes an unordered list item starting with '* '", () => {
    const [block] = parseMarkdown("* first item");
    expect(block.type).toBe("list-item");
    expect(block.marker).toBe("•");
  });

  it("recognizes an ordered list item and keeps the typed ordinal", () => {
    const [block] = parseMarkdown("2. second item");
    expect(block.type).toBe("list-item");
    expect(block.marker).toBe("2.");
    expect(block.runs[0].text).toBe("second item");
  });

  it("treats a line with no marker as a plain paragraph", () => {
    const [block] = parseMarkdown("just text");
    expect(block.type).toBe("paragraph");
    expect(block.marker).toBeNull();
  });

  it("does not treat '*emphasis*' (no space after the leading *) as a list item", () => {
    const [block] = parseMarkdown("*emphasis* right away");
    expect(block.type).toBe("paragraph");
  });

  it("parses each line independently, in order", () => {
    const blocks = parseMarkdown("- one\n- two\nplain");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: "list-item", marker: "•" });
    expect(blocks[1]).toMatchObject({ type: "list-item", marker: "•" });
    expect(blocks[2]).toMatchObject({ type: "paragraph", marker: null });
  });
});

describe("parseMarkdown — links", () => {
  it("recognizes [text](url) and carries a safe http url on the run", () => {
    const [block] = parseMarkdown("see [my site](https://example.com) here");
    const run = findRun(block.runs, "my site");
    expect(run).toBeDefined();
    expect(run!.url).toBe("https://example.com");
  });

  it("renders an unsafe-scheme link as a plain, non-tappable run (fails closed, not dropped silently)", () => {
    const [block] = parseMarkdown("click [here](javascript:alert(1))");
    const run = findRun(block.runs, "here");
    expect(run).toBeDefined();
    expect(run!.url).toBeNull();
    expect(run!.bold).toBe(false);
    expect(run!.italic).toBe(false);
  });

  it("does not swallow text around the link", () => {
    const [block] = parseMarkdown("before [link](https://example.com) after");
    expect(block.runs.map((r) => r.text)).toEqual(["before ", "link", " after"]);
  });
});

describe("parseMarkdown — mixed content", () => {
  it("handles bold, italic and a link together on one line", () => {
    const [block] = parseMarkdown("**bold** and *italic* and [link](https://x.com)");
    expect(block.runs).toEqual([
      { text: "bold", bold: true, italic: false, url: null },
      { text: " and ", bold: false, italic: false, url: null },
      { text: "italic", bold: false, italic: true, url: null },
      { text: " and ", bold: false, italic: false, url: null },
      { text: "link", bold: false, italic: false, url: "https://x.com" },
    ]);
  });

  it("returns a single empty plain run for an empty line, rather than an empty array", () => {
    const [block] = parseMarkdown("");
    expect(block.runs).toEqual([{ text: "", bold: false, italic: false, url: null }]);
  });

  it("does NOT parse '**bold *word* bold**' as one bold run (locks the module header's worked example)", () => {
    // The bold alternative's content class excludes `*`, so it can never span
    // the inner `*word*` — bold never matches here at all, and the inner
    // `*italic*` is what matches instead. Exactly five runs: a literal `*`,
    // an italic "bold ", a plain "word", an italic " bold", and a trailing
    // literal `*`. See this module's header for the full explanation — this
    // test exists so a future edit that silently changes this behavior can't
    // leave the header's claim wrong without a red test.
    const [block] = parseMarkdown("**bold *word* bold**");
    expect(block.runs).toEqual([
      { text: "*", bold: false, italic: false, url: null },
      { text: "bold ", bold: false, italic: true, url: null },
      { text: "word", bold: false, italic: false, url: null },
      { text: " bold", bold: false, italic: true, url: null },
      { text: "*", bold: false, italic: false, url: null },
    ]);
  });

  it("is stateless across repeated calls (no leaked regex lastIndex)", () => {
    // Calling twice back-to-back with content that would desync a shared,
    // reused `g`-flag regex's `lastIndex` must still parse the second call
    // correctly from its own start.
    parseMarkdown("**bold**");
    const [block] = parseMarkdown("**bold** again");
    expect(block.runs[0]).toMatchObject({ text: "bold", bold: true });
    expect(block.runs[1]).toMatchObject({ text: " again", bold: false });
  });
});
