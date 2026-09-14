import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "@shikijs/langs/bash";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import python from "@shikijs/langs/python";
import sql from "@shikijs/langs/sql";
import typescript from "@shikijs/langs/typescript";
import githubLight from "@shikijs/themes/github-light";
import type { CodeElement, CodeLanguage } from "../types";

// Month 6 — code elements. The pure bits the live canvas
// (`components/board/CodeElementView.tsx`) needs: tokenizing source into
// colored runs, and laying those runs out into lines and a box. Nothing here
// touches Firestore (`services/codeService.ts` does) or React Native SVG —
// this module is plain data in, plain data out, so it is unit-testable
// without rendering anything.
//
// ── THE REGEX ENGINE ─────────────────────────────────────────────────────
// Shiki's DEFAULT engine compiles Oniguruma to WebAssembly
// (`shiki/engine/oniguruma`, `shiki/wasm`). That is not a safe assumption on
// this stack: a `.wasm` load needs an instantiation step neither this repo's
// Jest transform nor a React Native/Metro/Hermes bundle can be assumed to
// provide for free, and — decisively — it makes tokenizing asynchronous
// (awaiting the module instantiation) for every caller, forever.
//
// Shiki also ships a pure-JavaScript engine
// (`shiki/engine/javascript`, `createJavaScriptRegexEngine`) that translates
// each grammar's Oniguruma patterns to native `RegExp` ahead of time. It has
// no WASM, no instantiation step, and — the actual point of choosing it —
// `createHighlighterCoreSync` + a highlighter instance's own `.codeToTokens()`
// are BOTH fully synchronous with this engine (verified against the
// installed version: `result instanceof Promise === false`). So unlike
// MathElement's server-rendered path, there is no async render step to
// reconcile with React render timing here at all — tokenizing is just a
// function call, made directly from the component on every render (memoized
// by the component on `code`/`language`/`fontSize`, not by this module).
//
// ── THE GRAMMAR BUNDLE ───────────────────────────────────────────────────
// `shiki`'s own convenience entry points (`createHighlighter`,
// `codeToHtml`/`codeToTokens` as bare imports) bundle EVERY grammar Shiki
// ships, because they don't know ahead of time which languages a caller
// wants. That is a large, unbounded mobile bundle cost for the nine
// languages this board actually needs. The fine-grained/"core" API sidesteps
// it: `createHighlighterCoreSync` takes an explicit `langs`/`themes` array,
// and importing each grammar/theme from its own subpath (`@shikijs/langs/*`,
// `@shikijs/themes/*` — both are `shiki`'s own dependencies, already on disk
// because `shiki` is installed; nothing beyond `shiki` was added to
// package.json) pulls in only the nine grammars and one theme below, not
// the ~200 Shiki bundles. `@shikijs/langs/bash` is an alias re-export of
// `shellscript` (Shiki's canonical grammar name for it) — imported by its
// brief-given name so the language list here reads the same as the brief's.
//
// One theme — the same bundle-cost reasoning the brief applies to grammars
// (the brief does not itself mention themes; this is this module's own
// extension of that reasoning, not a quoted requirement).
// `github-light` was picked because it renders correctly on this board's
// white canvas (`DrawingCanvas.tsx`'s `#FFFFFF` background) without this
// element needing its own opaque backdrop first.
//
// KNOWN BUNDLE COST (reported, not hidden): even the tokens-only entry point
// (`shiki/core`) is one pre-built file that also exports `codeToHtml`/
// `codeToHast`, so it statically pulls in Shiki's HTML/HAST serialization
// stack (`hast-util-to-html` and the small unist/mdast/micromark packages
// under it) whether or not anything here calls those functions — there is no
// narrower "tokens only" entry point upstream to import instead. That is
// also why `jest.config.js`'s `transformIgnorePatterns` had to grow beyond
// `shiki`/`@shikijs/*`: those packages are pure ESM too.
const highlighterLangs = [bash, c, cpp, java, javascript, json, python, sql, typescript];

/** The brief's nine, in the order it lists them. Each is either a grammar's
 *  canonical Shiki name or a registered alias (verified against the
 *  installed version) — no separate translation table between "the id this
 *  module accepts" and "the id Shiki matches" is needed. */
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
 *  no per-glyph width (there is no DOM/text-shaping step here — see this
 *  file's header), so the box is sized from character COUNT, not measured
 *  text, the same tradeoff `functions/src` never has to make for LaTeX
 *  because MathJax already hands back exact glyph outlines. Both ratios are
 *  standard monospace-font proportions (a fixed-width face's advance width
 *  and a typical code-editor line height), not measured from any specific
 *  font this app bundles. */
const MONO_CHAR_WIDTH_RATIO = 0.6;
const CODE_LINE_HEIGHT_RATIO = 1.4;

/** Colors matching the `github-light` theme's own editor background/
 *  foreground, hardcoded rather than read back off the loaded theme object
 *  at runtime (its color keys are VS Code theme internals, not a stable
 *  Shiki API) — verified once against the installed version's
 *  `@shikijs/themes/github-light` (`editor.background` #fff, `.foreground`
 *  #24292e) and pinned here the same way `MATH_DEFAULT_COLOR` pins a fixed
 *  ink color for math elements. */
export const CODE_BACKGROUND_COLOR = "#ffffff";
export const CODE_BORDER_COLOR = "#d0d7de";
export const CODE_DEFAULT_FOREGROUND = "#24292e";

/** One highlighted run — Shiki's own token shape trimmed to exactly what a
 *  renderer needs (a `<TSpan>` per run): the text and its color. `offset`/
 *  `fontStyle` are dropped; nothing here reads them today, and carrying them
 *  through would let a future caller quietly depend on a shape this module
 *  doesn't promise to keep stable. */
export interface CodeTokenRun {
  content: string;
  color: string;
}
export type CodeTokenLine = CodeTokenRun[];

let highlighterInstance: ReturnType<typeof createHighlighterCoreSync> | null = null;

/** Built once, lazily (not at module load) — so importing this module (e.g.
 *  from a test that only exercises `layoutCodeBox`) never pays the grammar-
 *  compile cost unless something actually tokenizes. Synchronous: see this
 *  file's header on the JS regex engine. */
function getHighlighter(): ReturnType<typeof createHighlighterCoreSync> {
  if (!highlighterInstance) {
    highlighterInstance = createHighlighterCoreSync({
      themes: [githubLight],
      langs: highlighterLangs,
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterInstance;
}

/**
 * Tokenize `code` into one array of colored runs per line. Synchronous (see
 * this file's header) — a caller never awaits this.
 *
 * An unrecognized `language` (a corrupt or future-schema document — see
 * `CodeElement`'s type comment) falls back to ONE uncolored run per line
 * rather than throwing or crashing the render: the text is still fully
 * readable, just unhighlighted, which is strictly better than a blank
 * element or a thrown error for a value this module never wrote itself.
 */
export function tokenizeCode(code: string, language: CodeLanguage): CodeTokenLine[] {
  const lines = code.length > 0 ? code.split("\n") : [""];
  if (!isCodeLanguage(language)) {
    return lines.map((line) => (line ? [{ content: line, color: CODE_DEFAULT_FOREGROUND }] : []));
  }
  const { tokens } = getHighlighter().codeToTokens(code, {
    lang: language,
    theme: "github-light",
    // ── WHY THE TIME LIMIT IS DISABLED ────────────────────────────────────
    // Shiki defaults `tokenizeTimeLimit` to 500 (ms, PER LINE — see
    // `@shikijs/primitive`'s `_tokenizeWithTheme`, which destructures that
    // default and hands it to `grammar.tokenizeLine2`). When a line exceeds
    // it, `vscode-textmate`'s `_tokenizeString` returns early with
    // `stoppedEarly: true` and every character it had not scanned yet
    // collapses into ONE token carrying whatever scope was open at the time.
    // `codeToTokens` does not surface `stoppedEarly`, so a caller cannot
    // distinguish a truncated line from a correctly tokenized one — the
    // failure is silent and renders as a plausible-looking solid-colored
    // line.
    //
    // That budget is charged the ONE-TIME cost of compiling a grammar's
    // rules on first use (each Oniguruma pattern converted to a native
    // RegExp by `oniguruma-to-es`, then compiled by V8), because TextMate
    // compiles rules lazily as it reaches them. So it is only ever the FIRST
    // tokenization with a given grammar that can blow the budget, and it
    // does so on a cold, not-yet-JIT-compiled process — which is exactly
    // what CI and a cold app launch are, and is not what a warm dev machine
    // is. `sql` surfaced it first because it carries the longest single
    // pattern of the nine (9,925 chars, converting to a 9,921-char RegExp),
    // but this is not sql-specific: `cpp` compiles 2,534 patterns and
    // already measured 603 ms on a warm machine, i.e. past the same cliff.
    //
    // 0 disables the limit, so tokenizing always runs to completion. The
    // cost is that a pathological line has no wall-clock escape hatch; the
    // benefit is that this module can never again hand a renderer a line it
    // silently failed to tokenize. A visibly slow first render is
    // recoverable and self-evident; a permanently mis-colored one is
    // neither.
    tokenizeTimeLimit: 0,
  });
  return tokens.map((line) =>
    line.map((t) => ({ content: t.content, color: t.color ?? CODE_DEFAULT_FOREGROUND }))
  );
}

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

/**
 * Placement transform for a code element's group — rotation only (unlike
 * `mathInk.mathTransform`, there is no translate+scale here: a code
 * element's `<TSpan>` runs are laid out at absolute `x`/`y` board
 * coordinates directly, not against a local origin baked into path data).
 * Returns "" when there is nothing to rotate, so a caller can skip wrapping
 * in a `<G>` entirely — the same convention `DrawingCanvas`'s `ImageSvg`/
 * `ShapeSvg` already use for their own optional rotation.
 *
 * Every input is a stored number a corrupt document could poison; fails
 * closed to an unrotated, zero-sized pivot rather than emitting a `NaN`
 * that would drop the whole subtree from the SVG tree with no error
 * anywhere.
 */
export function codeTransform(el: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}): string {
  const rotation = Number.isFinite(el.rotation) ? (el.rotation as number) : 0;
  if (!rotation) return "";
  const x = Number.isFinite(el.x) ? el.x : 0;
  const y = Number.isFinite(el.y) ? el.y : 0;
  const width = Number.isFinite(el.width) && el.width > 0 ? el.width : 0;
  const height = Number.isFinite(el.height) && el.height > 0 ? el.height : 0;
  const cx = x + width / 2;
  const cy = y + height / 2;
  return `rotate(${rotation}, ${cx}, ${cy})`;
}

/** Re-exported so a caller already holding this module doesn't need a
 *  second import for the discriminant type. */
export type { CodeElement, CodeLanguage };
