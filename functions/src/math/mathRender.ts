import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
// Imported for its registration side effect only: every TeX extension
// registers its Configuration when its module is loaded, and `packages` below
// can only SELECT from what is registered. AllPackages deliberately excludes
// `require`/`autoload`, so user LaTeX cannot pull in an extension this file's
// own list leaves out.
import "mathjax-full/js/input/tex/AllPackages.js";
import {
  Matrix,
  PathBox,
  boxPathData,
  boxWithin,
  intersectBoxes,
  multiply,
  parseTransform,
  rectPathData,
  scaling,
  transformPathData,
  translation,
} from "./svgPath";

// Month 6 — math elements, the rendering half. LaTeX in, flat SVG path data
// out, in-process (MathJax runs here; there is no provider and no per-call
// spend — see the callable's header for what that does and does not excuse).
//
// WHY PATH DATA AND NOT A WEBVIEW OR KaTeX: this board is a `react-native-svg`
// tree with no DOM on native, so KaTeX — which emits DOM HTML — cannot render
// into it at all. A WebView per equation is unusable at thirty equations on a
// board AND, decisively, opts the element out of selection, transform, export
// and print. Rendering to path data means a math element is an ordinary
// `<Path>` and gets all four for free.
//
// DETERMINISM. The brief requires byte-identical path data for identical
// LaTeX, and it is not free: MathJax's DEFAULT SVG output puts each glyph in
// a `<defs>` block under an id carrying a per-document counter
// (`MJX-1-TEX-I-1D465`, `MJX-2-...`) and references it with `<use>`, so two
// renders of the same expression differ in every id. `fontCache: "none"`
// below is what removes that: glyphs are emitted as inline `<path d=...>`
// with no ids, no `<defs>` and no counter. Verified byte-identical both
// across fresh documents and across reuses of the shared document below,
// including interleaved with other expressions. The remaining nondeterminism
// risk is float formatting, which `transformPathData`'s fixed rounding pins.
//
// FAIL CLOSED, ALWAYS. Everything below refuses rather than guesses: an
// element it does not know, a transform it cannot parse, a paint attribute a
// single monochrome `<Path>` cannot express, a clip that actually removes
// geometry. A refusal reaches the user as a sentence they can read; a guess
// reaches them as an equation that is quietly wrong, which is worse.

/** Board units per em. Matches the board's default text size (the 20 that
 *  `useBoardElements.createTextElement` stamps on a new TextElement), so an
 *  equation dropped next to a line of text reads at the same weight. The
 *  scale is baked INTO the path data — `svgPath` is already in board units at
 *  `scale: 1` — so nothing downstream has to know MathJax's internal unit. */
export const MATH_EM_BOARD_UNITS = 20;

/** MathJax's SVG output uses 1000 internal units per em. */
const MATHJAX_UNITS_PER_EM = 1000;

/** Decimal places kept in the emitted path data. Three is ~0.001 board units
 *  — far below a pixel at any sane zoom — and is what makes the output
 *  byte-identical run to run. */
const DECIMALS = 3;

/** Tolerance when testing a nested `<svg>`'s clip, in output units. Must
 *  exceed the rounding above so a clip that is exactly tight is not read as
 *  one that removes geometry. */
const CLIP_EPSILON = 0.05;

/**
 * Longest LaTeX source accepted. Enforced HERE, in the function — this is the
 * real limit. The composer's matching `maxLength` is advisory only (see
 * src/components/board/MathComposer.tsx).
 *
 * ⚠️ DUPLICATED NUMBER. `src/lib/mathInk.ts`'s own `MAX_LATEX_LENGTH` must
 * equal this one; `src/lib/__tests__/mathInk.test.ts` parses this file as
 * text and fails if the two disagree. Edit both files together.
 */
export const MAX_LATEX_LENGTH = 1000;

/**
 * Longest emitted path data accepted. A Firestore document is capped at 1 MiB
 * and `svgPath` is stored on the element, so an expression whose flattened
 * outline is enormous must be refused with a readable message rather than
 * left to fail as an opaque write error on the client.
 */
export const MAX_SVG_PATH_CHARS = 200_000;

/**
 * Bumped whenever anything here changes the BYTES of `svgPath` for unchanged
 * LaTeX — the em size, the decimal places, the package list, the MathJax
 * version. The cache key mixes it in (see mathCache.ts), so old entries miss
 * instead of serving output the current renderer would not produce. A cache
 * keyed on a DERIVED rendering needs this; ocrCache.ts/flashcardCache.ts key
 * on their inputs' identity and so do not.
 */
export const RENDER_VERSION = 1;

/**
 * The TeX extensions enabled. Curated, not `AllPackages`, and every exclusion
 * is load-bearing:
 *
 *   - `noerrors` / `noundefined` turn a TeX error into red text in the OUTPUT
 *     instead of raising it. They would defeat `formatError` below and turn a
 *     user's typo into a rendered equation that silently says the wrong thing.
 *   - `color` / `colortbl` / `bbox` carry paint (fill, stroke, a background
 *     rect) that ONE monochrome `<Path>` cannot express. The flattener would
 *     drop the colour without a word.
 *   - `cancel` / `enclose` emit STROKED `<line>`/`<ellipse>` geometry, which
 *     is not fillable path data.
 *   - `html` injects link/class/style wrappers into the SVG — meaningless on
 *     a canvas, and a way to smuggle attributes into the output.
 *   - `unicode` deliberately routes arbitrary code points to MathJax's
 *     `<text>` font fallback, which has no path data at all.
 *
 * `require` and `autoload` are not in AllPackages to begin with, so `\require`
 * cannot be used to load any of the above back in.
 */
export const TEX_PACKAGES = [
  "base",
  "ams",
  "amscd",
  "boldsymbol",
  "braket",
  "cases",
  "centernot",
  "extpfeil",
  "gensymb",
  "mathtools",
  "mhchem",
  "newcommand",
  "textcomp",
  "textmacros",
  "upgreek",
  "configmacros",
];

/** The result of a render. `error` is set exactly when the LaTeX could not be
 *  turned into path data, and `svgPath` is then "" with zero dimensions —
 *  this NEVER throws for bad input, because a throw here surfaces to a user
 *  mid-typo as a crash. Dimensions are board units at `scale: 1`. */
export interface MathRenderResult {
  svgPath: string;
  width: number;
  height: number;
  error?: string;
}

function failure(error: string): MathRenderResult {
  return { svgPath: "", width: 0, height: 0, error };
}

// --- the shared MathJax document -------------------------------------------
// Built once per process and reused: the module load is ~160ms and the first
// conversion ~6ms (font metrics), while every later conversion is ~1ms. Reuse
// was verified not to affect the output — see this file's determinism note.

interface Engine {
  adaptor: ReturnType<typeof liteAdaptor>;
  doc: any;
}

let engine: Engine | null = null;

function getEngine(): Engine {
  if (engine) return engine;
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({
    packages: TEX_PACKAGES,
    // MathJax's default is to CATCH a TeX error and render it as an `merror`
    // node. Rethrowing is what lets a malformed expression become a structured
    // error the user can read instead of a red blob on the canvas.
    formatError: (_jax: unknown, err: Error) => {
      throw err;
    },
    // Bound a macro bomb (`\def\x{\x\x}\x`). Without these, user LaTeX can
    // pin a function instance's CPU for as long as the platform allows.
    maxMacros: 1000,
    maxBuffer: 16 * 1024,
  });
  const svg = new SVG({ fontCache: "none" });
  engine = { adaptor, doc: mathjax.document("", { InputJax: tex, OutputJax: svg }) };
  return engine;
}

/** Test-only: drop the process-lifetime engine so the next `renderMath` call
 *  builds a brand-new adaptor/TeX/SVG/document instead of reusing this one —
 *  what actually exercises the "across fresh documents" half of the
 *  determinism claim above, as opposed to "across reuses of the shared
 *  document", which every render in this file's test suite already covers by
 *  default. Never called from production code. */
export function resetEngineForTests(): void {
  engine = null;
}

// --- flattening -------------------------------------------------------------

interface Walker {
  adaptor: Engine["adaptor"];
  parts: string[];
  /** For each entry in `parts`, its box if that part is one axis-aligned
   *  rectangle, else null. Only a nested `<svg>`'s clip consults this — see
   *  the `svg` branch of `walk`. */
  rects: (PathBox | null)[];
  box: PathBox;
  /** Set on the first refusal; the walk unwinds without overwriting it. */
  error: string | null;
}

const EMPTY_BOX = (): PathBox => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
});

function growBox(target: PathBox, b: PathBox): void {
  if (b.minX < target.minX) target.minX = b.minX;
  if (b.minY < target.minY) target.minY = b.minY;
  if (b.maxX > target.maxX) target.maxX = b.maxX;
  if (b.maxY > target.maxY) target.maxY = b.maxY;
}

const UNSUPPORTED_PAINT =
  "This equation uses styling (colour, a box, or a stroked rule) that can't be " +
  "flattened into a single path. Try it without that decoration.";

const UNSUPPORTED_STRETCH =
  "This equation uses a stretched symbol (\\underbrace, \\overbrace, " +
  "\\overrightarrow, a wide accent, or a CD arrow) whose curved outline can't be " +
  "clipped into a single path yet.";

const UNSUPPORTED_GLYPH =
  "This equation uses characters the maths font has no glyph for (CJK or emoji, " +
  "usually inside \\text{...}), so there is no outline to draw.";

/** Paint attributes a single monochrome `<Path>` can honour. Anything else on
 *  any node is a refusal: the flattened output has exactly one fill and no
 *  stroke, so a node asking for a second colour, a real stroke width or a
 *  partial opacity would render differently from what MathJax intended. */
function paintIsPlain(w: Walker, node: unknown): boolean {
  const get = (n: string) => w.adaptor.getAttribute(node as never, n);
  const fill = get("fill");
  if (fill !== null && fill !== undefined && fill !== "currentColor") return false;
  const strokeWidth = get("stroke-width");
  if (strokeWidth !== null && strokeWidth !== undefined && Number(strokeWidth) !== 0) return false;
  for (const attr of ["opacity", "fill-opacity", "stroke-opacity"]) {
    const v = get(attr);
    if (v !== null && v !== undefined && Number(v) !== 1) return false;
  }
  // `stroke` is only meaningful alongside a non-zero stroke-width, which the
  // check above already rejects; MathJax stamps `stroke="currentColor"
  // stroke-width="0"` on its root group, which paints nothing.
  if (get("style")) return false;
  return true;
}

function numberAttr(w: Walker, node: unknown, name: string, fallback: number): number | null {
  const raw = w.adaptor.getAttribute(node as never, name);
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Parse a `viewBox` into a box, or null if it is absent or malformed. */
function parseViewBox(spec: string | null | undefined): { x: number; y: number; w: number; h: number } | null {
  if (!spec) return null;
  const parts = spec.trim().split(/[\s,]+/);
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (!nums.every(Number.isFinite)) return null;
  if (nums[2] <= 0 || nums[3] <= 0) return null;
  return { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
}

function walk(w: Walker, node: unknown, m: Matrix): void {
  if (w.error) return;
  const kind = w.adaptor.kind(node as never);

  if (kind === "#text" || kind === "#comment") {
    // MathJax only emits text nodes for characters its font has no glyph for
    // (CJK, emoji) — and those come wrapped in a `<text>`, handled below.
    // Whitespace between elements is harmless.
    const value = w.adaptor.value(node as never) ?? "";
    if (kind === "#text" && value.trim().length > 0) {
      w.error = UNSUPPORTED_GLYPH;
    }
    return;
  }

  if (kind === "text") {
    // MathJax's font-fallback path: a character with no glyph is emitted as an
    // SVG `<text>` in a system font, which has no outline this pipeline can
    // extract. Named explicitly so the message says what is actually wrong.
    w.error = UNSUPPORTED_GLYPH;
    return;
  }

  // Defence in depth on the structured-error contract. `formatError` above
  // makes a TeX error throw, and it always has in testing — but MathJax's own
  // default is to render the message as an `merror` node instead, and if any
  // path ever reaches here with one, its text would otherwise surface as the
  // generic unsupported-glyph refusal. Read the real message instead.
  const mjxError = w.adaptor.getAttribute(node as never, "data-mjx-error");
  if (mjxError) {
    w.error = mjxError;
    return;
  }

  if (!paintIsPlain(w, node)) {
    w.error = UNSUPPORTED_PAINT;
    return;
  }

  const local = parseTransform(w.adaptor.getAttribute(node as never, "transform") ?? "");
  if (!local) {
    w.error = UNSUPPORTED_PAINT;
    return;
  }
  const here = multiply(m, local);

  if (kind === "g") {
    for (const child of w.adaptor.childNodes(node as never) ?? []) walk(w, child, here);
    return;
  }

  if (kind === "path") {
    const d = w.adaptor.getAttribute(node as never, "d");
    if (!d) return; // a path with no geometry draws nothing
    const out = transformPathData(d, here, DECIMALS);
    if (!out) {
      w.error = UNSUPPORTED_PAINT;
      return;
    }
    w.parts.push(out.d);
    w.rects.push(out.rect);
    growBox(w.box, out.box);
    return;
  }

  if (kind === "rect") {
    const x = numberAttr(w, node, "x", 0);
    const y = numberAttr(w, node, "y", 0);
    const width = numberAttr(w, node, "width", 0);
    const height = numberAttr(w, node, "height", 0);
    if (x === null || y === null || width === null || height === null) {
      w.error = UNSUPPORTED_PAINT;
      return;
    }
    const out = rectPathData(x, y, width, height, here, DECIMALS);
    if (!out) {
      w.error = UNSUPPORTED_PAINT;
      return;
    }
    w.parts.push(out.d);
    w.rects.push(out.rect);
    growBox(w.box, out.box);
    return;
  }

  if (kind === "svg") {
    // A NESTED `<svg>`: MathJax uses one to place AND CLIP a deliberately
    // over-stretched glyph (`\overline`'s rule, `\underbrace`'s brace, a CD
    // arrow's shaft). The placement is just a matrix and is applied below —
    // but the CLIP genuinely removes geometry, and a flat `d` string cannot
    // express "this outline, trimmed". Three outcomes, in order:
    //
    //   1. The clip removes nothing (the subtree already fits) — emit as is.
    //   2. It removes something, but every part is an axis-aligned RECTANGLE
    //      — intersect each with the clip and emit the result. Rectangle by
    //      rectangle is exact, not an approximation, and it is what makes
    //      `\overline` / `\underline` (an over-long rule, clipped to length)
    //      render rather than being refused.
    //   3. Anything else (a clipped curve) — refuse. Emitting the unclipped
    //      outline would draw an overbrace several times too wide with no
    //      indication anything was wrong.
    const vx = numberAttr(w, node, "x", 0);
    const vy = numberAttr(w, node, "y", 0);
    const vw = numberAttr(w, node, "width", 0);
    const vh = numberAttr(w, node, "height", 0);
    if (vx === null || vy === null || vw === null || vh === null) {
      w.error = UNSUPPORTED_STRETCH;
      return;
    }
    const viewBox = parseViewBox(w.adaptor.getAttribute(node as never, "viewBox"));
    let inner = translation(vx, vy);
    if (viewBox) {
      inner = multiply(
        multiply(inner, scaling(vw / viewBox.w, vh / viewBox.h)),
        translation(-viewBox.x, -viewBox.y)
      );
    }

    const sub: Walker = {
      adaptor: w.adaptor,
      parts: [],
      rects: [],
      box: EMPTY_BOX(),
      error: null,
    };
    for (const child of w.adaptor.childNodes(node as never) ?? []) {
      walk(sub, child, multiply(here, inner));
    }
    if (sub.error) {
      w.error = sub.error;
      return;
    }
    if (sub.parts.length === 0) return;

    // The clip rectangle is the nested viewport, expressed in the SAME output
    // space the flattened geometry now lives in.
    const clip = rectPathData(vx, vy, vw, vh, here, DECIMALS);
    if (!clip) {
      w.error = UNSUPPORTED_STRETCH;
      return;
    }

    // (1) Nothing to trim.
    if (boxWithin(sub.box, clip.box, CLIP_EPSILON)) {
      w.parts.push(...sub.parts);
      w.rects.push(...sub.rects);
      growBox(w.box, sub.box);
      return;
    }

    // (2) Rectangles only, and a clip rectangle that is itself axis-aligned in
    // output space (it would not be under a rotation, and `clip.box` would
    // then be a loose bounding box that under-clips).
    if (!clip.rect || sub.rects.some((r) => r === null)) {
      w.error = UNSUPPORTED_STRETCH;
      return;
    }
    for (const rect of sub.rects) {
      const trimmed = intersectBoxes(rect as PathBox, clip.rect);
      if (!trimmed) continue; // clipped away entirely — draws nothing
      w.parts.push(boxPathData(trimmed, DECIMALS));
      w.rects.push(trimmed);
      growBox(w.box, trimmed);
    }
    return;
  }

  // `text`, `line`, `ellipse`, `use`, `a`, anything future — all carry
  // geometry or meaning this flattener would drop. Refuse.
  w.error = UNSUPPORTED_PAINT;
}

/**
 * Turn a MathJax/TeX exception into one readable sentence. TeX messages
 * ("Missing close brace", "Undefined control sequence \foo") are already
 * user-facing and are exactly what makes this feature usable — the whole
 * point of returning a structured error rather than throwing is that the
 * person who mistyped can see what they mistyped.
 *
 * Reads `.message` off ANY thrown value, deliberately not `err instanceof
 * Error`: MathJax's `TexError` is a plain class that does NOT extend Error
 * (and leaves `.name` undefined), so an `instanceof` guard silently discards
 * every TeX message and replaces it with the generic fallback below — which
 * is precisely the bug this comment exists to stop coming back.
 */
function messageFor(err: unknown): string {
  const raw =
    err && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : "";
  // Cap the length so an internal failure can't spill a stack-sized string at
  // the client; the fallback is deliberately vague for the same reason.
  if (raw && raw.length <= 200) return raw;
  return "That LaTeX couldn't be rendered.";
}

/**
 * Render LaTeX to flat SVG path data in board units.
 *
 * Resolves to `{ error }` — never rejects — for every kind of bad input: an
 * empty expression, one over `MAX_LATEX_LENGTH`, a TeX syntax error, a
 * construct this flattener refuses. The one thing it does not catch is a
 * programming error inside MathJax itself, which should surface.
 */
export async function renderMath(latex: string, displayMode = true): Promise<MathRenderResult> {
  if (typeof latex !== "string") return failure("Enter an equation.");
  const source = latex.trim();
  if (!source) return failure("Enter an equation.");
  if (source.length > MAX_LATEX_LENGTH) {
    return failure(`That equation is too long (limit ${MAX_LATEX_LENGTH} characters).`);
  }

  const { adaptor, doc } = getEngine();

  let container: unknown;
  try {
    container = doc.convert(source, { display: displayMode });
  } catch (err) {
    return failure(messageFor(err));
  }

  const svgEl = (adaptor.childNodes(container as never) ?? []).find(
    (n: unknown) => adaptor.kind(n as never) === "svg"
  );
  if (!svgEl) return failure("That LaTeX couldn't be rendered.");

  const viewBox = parseViewBox(adaptor.getAttribute(svgEl as never, "viewBox"));
  if (!viewBox) return failure("That LaTeX couldn't be rendered.");

  // Normalise into board units with the origin at the box's top-left: shift
  // the viewBox to (0,0), then scale em → board units. `svgPath` is therefore
  // already positioned and sized for `scale: 1`, and the element's own
  // `scale` multiplies on top of it at render time.
  const k = MATH_EM_BOARD_UNITS / MATHJAX_UNITS_PER_EM;
  const base = multiply(scaling(k, k), translation(-viewBox.x, -viewBox.y));

  const w: Walker = { adaptor, parts: [], rects: [], box: EMPTY_BOX(), error: null };
  for (const child of adaptor.childNodes(svgEl as never) ?? []) walk(w, child, base);
  if (w.error) return failure(w.error);

  const svgPath = w.parts.join(" ");
  if (!svgPath) return failure("That expression renders nothing.");
  if (svgPath.length > MAX_SVG_PATH_CHARS) {
    return failure("That equation is too complex to store as a canvas element.");
  }

  // Dimensions come from the viewBox, NOT from the flattened geometry's own
  // bounds: the viewBox is the typeset box MathJax laid out, including the
  // side bearings and the descender room that make an equation sit correctly
  // next to other content. The ink's bounding box would crop both away.
  const width = Number((viewBox.w * k).toFixed(DECIMALS));
  const height = Number((viewBox.h * k).toFixed(DECIMALS));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return failure("That LaTeX couldn't be rendered.");
  }

  return { svgPath, width, height };
}
