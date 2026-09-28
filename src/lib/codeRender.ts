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
// One-way dependency, and the direction matters: the language list, the
// defaults and the pure box layout live in a leaf module that imports nothing
// at all, so a caller that only needs those never loads a single grammar.
// Never invert this — see `codeLayout.ts`'s header for the measured cost.
import { isCodeLanguage } from "./codeLayout";
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
//
// That cost is the reason this module is now only the TOKENIZER. The language
// list, the defaults and the pure box layout moved to `lib/codeLayout.ts`,
// which imports nothing — so `CodeComposer` (a dropdown), `codeService`
// (persisting a snippet) and `useBoardElements` (a resize re-layout) no longer
// load a grammar to do work that never needed one. Import from there, not from
// here, unless you are actually tokenizing.
const highlighterLangs = [bash, c, cpp, java, javascript, json, python, sql, typescript];

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

/** Built once, lazily (not at module load), so importing this module never
 *  pays the grammar-COMPILE cost unless something actually tokenizes. Note
 *  what that does and does not buy: the grammars are still bundled and still
 *  evaluated at import, which is the cost `lib/codeLayout.ts` exists to let
 *  non-tokenizing callers avoid entirely. Synchronous: see this file's header
 *  on the JS regex engine. */
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
