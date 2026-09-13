/**
 * Month 6 — sticky-note polish. A small, hand-rolled markdown reader for
 * exactly what the brief names — bold, italic, lists, links — and nothing
 * else (no headers, blockquotes, code spans, or nested emphasis). No
 * dependency: `markdown-it`/`marked`/`remark` are all out of scope for this
 * task; this file is the entire parser.
 *
 * Pure and synchronous throughout — no React Native import here — so it's
 * fully unit-testable on its own, which is where the real logic belongs:
 * `src/hooks/useBoardElements.ts` — this codebase's single largest file, by
 * a wide margin — has zero test coverage of any kind, so nothing that can
 * live in a pure module should live there instead.
 *
 * `parseMarkdown` is line-oriented: each line of `source` becomes exactly one
 * `MarkdownBlock` (a sticky note is short free text, not a flowed document —
 * there is no multi-line paragraph merging). A line is a list item when it
 * starts with `- `/`* ` (unordered) or `N. ` (ordered); every other line is a
 * plain paragraph. Within a line, `[text](url)`, `**bold**`/`__bold__`, and
 * `*italic*`/`_italic_` are recognized as flat, NON-nested spans — the first
 * one found wins at each position, and mixing the two markers on one span is
 * unsupported, not silently flattened: `**bold *word* bold**` does NOT parse
 * as one bold run. The bold alternative's content class excludes `*`, so it
 * can never span the inner `*word*` — bold simply never matches there, and
 * the inner `*italic*` is what does instead, leaving five runs: a literal
 * `*`, an italic `bold `, a plain `word`, an italic ` bold`, and a trailing
 * literal `*`. That is a deliberate simplification, not an oversight: nesting
 * was never named in the brief, and a hand-rolled recursive-descent parser is
 * exactly the kind of scope creep "no dependency" is trying to avoid paying
 * for.
 */

// Allow-list, not a deny-list (the brief's explicit requirement: "deny unless
// provably permitted"). `mailto` is included alongside the two named schemes
// because a sticky note is exactly the kind of place a person writes a real
// contact link.
const ALLOWED_LINK_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * Whether `rawUrl` is safe to ever hand to a link-opening API. Fails closed:
 * anything that isn't a recognized scheme is rejected, including a URL with
 * no scheme at all (a bare "evil.com" or a protocol-relative "//evil.com").
 *
 * Two checks, in this order, and both matter:
 *
 * 1. Control characters (including an embedded `\n`/`\t`) anywhere in the
 *    raw string are an immediate reject. This is what stops the "slips past
 *    a naive check" case named in the brief: a scheme regex that requires
 *    the colon to sit directly after the scheme letters (as this function's
 *    own regex does, below) will already fail to match "java\nscript:..."
 *    since `\n` isn't a valid scheme character — but a DIFFERENT naive
 *    implementation that first strips/collapses whitespace to tolerate
 *    leading spaces (to accept " http://example.com") would, as a side
 *    effect, also collapse an embedded newline and reassemble exactly
 *    "javascript:...". Rejecting any control character up front closes that
 *    off regardless of how the rest of the check is written.
 * 2. Only LEADING/TRAILING whitespace is trimmed (never anything internal)
 *    before extracting the scheme (the part before the first `:`), which is
 *    then lower-cased and checked against the allow-list. Trimming handles
 *    the "leading whitespace" case (`"   javascript:..."` must still resolve
 *    to the scheme `javascript` and be rejected, not accidentally treated as
 *    schemeless); lower-casing handles the "mixed case" case (`"JavaScript:..."`).
 */
export function isSafeLinkUrl(rawUrl: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(rawUrl)) return false;
  const trimmed = rawUrl.trim();
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!schemeMatch) return false;
  const scheme = schemeMatch[1].toLowerCase();
  return ALLOWED_LINK_SCHEMES.has(scheme);
}

/** One inline run of text within a block, already resolved to its final
 *  style — `bold`/`italic` are independent flags (never both true, given the
 *  "no nesting" design above), and `url` is set ONLY for a link whose target
 *  passed `isSafeLinkUrl` — an unsafe link's `[label](url)` still renders,
 *  but as a plain, non-tappable run carrying just the label, never the raw
 *  scheme. */
export interface MarkdownRun {
  text: string;
  bold: boolean;
  italic: boolean;
  url: string | null;
}

export interface MarkdownBlock {
  type: "paragraph" | "list-item";
  /** Set only for a "list-item" block: "•" for an unordered item (both `-`
   *  and `*` bullets normalize to the same glyph), or the exact typed
   *  ordinal (e.g. "2.") for an ordered one. Rendering, not renumbering —
   *  this is what the author typed, never recomputed. */
  marker: string | null;
  runs: MarkdownRun[];
}

const UNORDERED_MARKER = /^\s*[-*]\s+(.*)$/;
const ORDERED_MARKER = /^\s*(\d+)\.\s+(.*)$/;

// Ordered by priority at each scan position: a link first, then bold (both
// delimiters), then italic (both delimiters). Each alternative's character
// class excludes its own delimiter, so `**bold**` can never be mistaken for
// two empty/adjacent `*italic*` spans and vice versa (see this module's
// header for a worked-through example).
const INLINE_TOKEN =
  /\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;

function parseInline(text: string): MarkdownRun[] {
  const runs: MarkdownRun[] = [];
  let lastIndex = 0;
  // A fresh regex object per call (rather than reusing the module-level
  // `INLINE_TOKEN` directly) so a `g`-flag regex's own mutable `lastIndex`
  // can never leak state between calls — reusing the shared instance would
  // work today (every call runs its `exec` loop to completion), but would be
  // a real, easy-to-reintroduce bug the moment any future call short-circuits
  // (a `break`, an early return) partway through the loop.
  const token = new RegExp(INLINE_TOKEN.source, INLINE_TOKEN.flags);
  let m: RegExpExecArray | null;
  while ((m = token.exec(text))) {
    if (m.index > lastIndex) {
      runs.push({ text: text.slice(lastIndex, m.index), bold: false, italic: false, url: null });
    }
    if (m[1] !== undefined) {
      const safe = isSafeLinkUrl(m[2]);
      runs.push({ text: m[1], bold: false, italic: false, url: safe ? m[2] : null });
    } else if (m[3] !== undefined) {
      runs.push({ text: m[3], bold: true, italic: false, url: null });
    } else if (m[4] !== undefined) {
      runs.push({ text: m[4], bold: true, italic: false, url: null });
    } else if (m[5] !== undefined) {
      runs.push({ text: m[5], bold: false, italic: true, url: null });
    } else {
      runs.push({ text: m[6], bold: false, italic: true, url: null });
    }
    lastIndex = token.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push({ text: text.slice(lastIndex), bold: false, italic: false, url: null });
  }
  if (runs.length === 0) {
    runs.push({ text: "", bold: false, italic: false, url: null });
  }
  return runs;
}

/** Parse `source` into one block per line. Never throws — there is no
 *  malformed input here, only text that doesn't happen to match any inline
 *  token and so renders as a single plain run, unchanged. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  return source.split("\n").map((line) => {
    const ordered = ORDERED_MARKER.exec(line);
    if (ordered) {
      return {
        type: "list-item" as const,
        marker: `${ordered[1]}.`,
        runs: parseInline(ordered[2]),
      };
    }
    const unordered = UNORDERED_MARKER.exec(line);
    if (unordered) {
      return { type: "list-item" as const, marker: "•", runs: parseInline(unordered[1]) };
    }
    return { type: "paragraph" as const, marker: null, runs: parseInline(line) };
  });
}
