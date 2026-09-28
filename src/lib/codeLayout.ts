import type { CodeLanguage } from "../types";

// Month 6 — code elements, the half of them that needs no tokenizer.
//
// WHY THIS IS ITS OWN MODULE. `lib/codeRender.ts` statically imports
// `shiki/core`, nine `@shikijs/langs/*` grammars and a theme, and `shiki/core`
// is one pre-built file that also exports `codeToHtml`/`codeToHast` — so it
// drags in Shiki's whole HTML/HAST serialization stack (`hast-util-to-html`
// plus the unist/mdast/micromark packages under it, roughly two dozen
// packages) whether or not anything calls those. There is no narrower
// "tokens only" entry point upstream; see that file's KNOWN BUNDLE COST note.
//
// That cost is real and was measured, not assumed: on a cold-cache
// `jest --coverage` run, `CodeComposerHost` and `MathComposerHost` failed
// three tests on a 5 s timeout purely from module load, and two later
// (warm-cache) runs were green. The same load lands on an Android cold start.
//
// The modules that paid it without needing a single token were
// `components/board/CodeComposer.tsx` (a language dropdown), `codeService.ts`
// (persisting a snippet and its box) and `hooks/useBoardElements.ts` (a resize
// re-layout). Everything they actually wanted is here, and this module imports
// nothing but a type. `lib/codeRender.ts` imports `isCodeLanguage` FROM here,
// never the reverse — that direction is what keeps the leaf a leaf.
//
// What deliberately stayed in `codeRender.ts`: `tokenizeCode` and the colours
// its fallback run uses. Its remaining importers (`CodeElementView.tsx`,
// `lib/svgExport.ts`) tokenize for real, so they pay a cost they are actually
// buying something with.

/** The brief's nine, in the order it lists them. Each is either a grammar's
 *  canonical Shiki name or a registered alias (verified against the
 *  installed version) — no separate translation table between "the id this
 *  module accepts" and "the id Shiki matches" is needed. The grammars
 *  themselves are imported in `codeRender.ts`; this list is the contract both
 *  sides agree on, and keeping it here is what lets a picker enumerate the
 *  languages without loading a single one. */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  "ts",
  "js",
  "py",
  "java",
  "c",
  "cpp",
  "sql",
  "json",
  "bash",
];

const CODE_LANGUAGE_SET = new Set<string>(CODE_LANGUAGES);

/** Type guard for a value read from an untrusted source (a Firestore doc, a
 *  clipboard payload) — a corrupt/future `language` must not reach the
 *  highlighter with a grammar it never loaded. */
export function isCodeLanguage(value: unknown): value is CodeLanguage {
  return typeof value === "string" && CODE_LANGUAGE_SET.has(value);
}

/** First in the brief's own list — as reasonable a default as any other,
 *  and stable so a composer's picker has a deterministic starting value. */
export const CODE_DEFAULT_LANGUAGE: CodeLanguage = "ts";

export const CODE_DEFAULT_FONT_SIZE = 14;
/** Floor for a code element's `fontSize` under a resize drag — mirrors
 *  `useBoardElements`' `MIN_MATH_SCALE`: a block resized to zero/negative is
 *  invisible and (being zero-area) untappable, so it could never be resized
 *  back up or selected to delete. */
export const MIN_CODE_FONT_SIZE = 6;

/** Interior padding (board units) between the box edge and the first/last
 *  line and character, so glyphs never touch the selection outline. */
const CODE_PADDING = 12;
/** Monospace cell metrics as a multiple of `fontSize`. Shiki's tokens carry
 *  no per-glyph width (there is no DOM/text-shaping step here — see
 *  `codeRender.ts`'s header), so the box is sized from character COUNT, not
 *  measured text, the same tradeoff `functions/src` never has to make for
 *  LaTeX because MathJax already hands back exact glyph outlines. Both ratios
 *  are standard monospace-font proportions (a fixed-width face's advance
 *  width and a typical code-editor line height), not measured from any
 *  specific font this app bundles. */
const MONO_CHAR_WIDTH_RATIO = 0.6;
const CODE_LINE_HEIGHT_RATIO = 1.4;

export interface CodeBoxLayout {
  width: number;
  height: number;
  /** Vertical distance (board units) between successive lines' baselines —
   *  what a renderer passes as each line's `<TSpan dy=...>`. */
  lineHeight: number;
  /** Monospace advance width (board units) of one character at this size. */
  charWidth: number;
  /** Padding (board units) from the box edge to the first line/character —
   *  what a renderer offsets the first `<TSpan>`'s `x`/`y` by. */
  padding: number;
}

/**
 * Pure line layout: the box `code` needs at `fontSize`, from character COUNT
 * (monospace assumption — see `MONO_CHAR_WIDTH_RATIO`'s comment), not
 * measured glyphs. Used at CREATE time and whenever `code`/`language` is
 * edited (re-deriving the box from the new source at the CURRENT
 * `fontSize` — see `CodeElement`'s type comment); a plain resize drag does
 * NOT call this — it scales the existing box directly, exactly like
 * TextElement's resize (`useBoardElements.commitResize`).
 *
 * Fails closed on a non-finite/non-positive `fontSize` (a stored number a
 * corrupt document could poison) by substituting `CODE_DEFAULT_FONT_SIZE`,
 * so a poisoned element still lays out into a selectable, deletable box
 * instead of a zero/NaN-sized one nobody could tap.
 */
export function layoutCodeBox(code: string, fontSize: number): CodeBoxLayout {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : CODE_DEFAULT_FONT_SIZE;
  const lines = code.length > 0 ? code.split("\n") : [""];
  const lineCount = Math.max(1, lines.length);
  const longestLine = Math.max(1, ...lines.map((l) => l.length));
  const charWidth = size * MONO_CHAR_WIDTH_RATIO;
  const lineHeight = size * CODE_LINE_HEIGHT_RATIO;
  return {
    width: longestLine * charWidth + CODE_PADDING * 2,
    height: lineCount * lineHeight + CODE_PADDING * 2,
    lineHeight,
    charWidth,
    padding: CODE_PADDING,
  };
}

/** Re-exported so a caller already holding this module doesn't need a second
 *  import for the discriminant type. */
export type { CodeLanguage };
