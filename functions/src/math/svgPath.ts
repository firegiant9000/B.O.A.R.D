// Month 6 — math elements. The pure geometry half of LaTeX → SVG path data:
// an affine matrix, an SVG `transform=` parser, and an SVG path-data rewriter
// that bakes a matrix into `d` so a nested `<g transform=...>` tree collapses
// into ONE flat `d` string with no transforms left in it.
//
// Why flatten at all: the board is a `react-native-svg` tree, and the whole
// point of shipping path data (rather than a WebView) is that a math element
// becomes an ordinary `<Path>` — so it gets selection, transform, export and
// print for free, like every other canvas element. A `<Path>` takes one `d`;
// it cannot take MathJax's nested `<g>`/`<use>`/`<defs>` structure.
//
// EVERY function here fails CLOSED — it returns `null` rather than guessing —
// on anything it does not fully understand: an unknown transform function, an
// unknown path command, an elliptical arc. A dropped transform or a
// misparsed command does not produce a visible error, it produces a silently
// WRONG equation, which is far worse than refusing to render one. The caller
// (mathRender.ts) turns a `null` into a structured error the user can read.

/** A 2-D affine matrix in SVG's own `matrix(a b c d e f)` order:
 *  `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Board-space axis-aligned box accumulated while rewriting path data. */
export interface PathBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** `m` then `n` — i.e. the matrix that applies `n` to a point already
 *  transformed by `m`, matching how SVG nests `transform` down a tree. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export function translation(tx: number, ty: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scaling(sx: number, sy: number): Matrix {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/** Every number this module reads comes from a third-party renderer's output,
 *  so `typeof x === "number"` is not enough — `Number("abc")` is NaN and NaN
 *  propagates silently through every multiply below, producing a `d` string
 *  full of "NaN" that renders as nothing at all. Fail closed instead. */
function finiteNumbers(parts: string[]): number[] | null {
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

const TRANSFORM_FN = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

/**
 * Parse an SVG `transform` attribute into a single matrix. Handles the four
 * forms this pipeline can see (`translate`, `scale`, `matrix`, `rotate`),
 * each with comma- OR space-separated arguments, chained left-to-right.
 *
 * Returns null for an unrecognised function (`skewX`, `skewY`, anything new),
 * a wrong argument count, or a non-finite argument — see this file's header
 * on why that is a refusal and not a shrug.
 */
export function parseTransform(spec: string): Matrix | null {
  if (!spec || !spec.trim()) return IDENTITY;
  let m = IDENTITY;
  let consumed = 0;
  TRANSFORM_FN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TRANSFORM_FN.exec(spec)) !== null) {
    consumed += match[0].length;
    const name = match[1];
    const args = finiteNumbers(match[2].split(/[\s,]+/).filter((s) => s.length > 0));
    if (!args) return null;
    let step: Matrix;
    if (name === "translate") {
      if (args.length === 1) step = translation(args[0], 0);
      else if (args.length === 2) step = translation(args[0], args[1]);
      else return null;
    } else if (name === "scale") {
      if (args.length === 1) step = scaling(args[0], args[0]);
      else if (args.length === 2) step = scaling(args[0], args[1]);
      else return null;
    } else if (name === "matrix") {
      if (args.length !== 6) return null;
      step = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
    } else if (name === "rotate") {
      if (args.length !== 1 && args.length !== 3) return null;
      const rad = (args[0] * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rot: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      step =
        args.length === 3
          ? multiply(multiply(translation(args[1], args[2]), rot), translation(-args[1], -args[2]))
          : rot;
    } else {
      return null;
    }
    m = multiply(m, step);
  }
  // Anything left over after stripping the functions we matched (and the
  // whitespace/commas between them) is syntax we did not understand.
  const leftover = spec.replace(TRANSFORM_FN, "").trim();
  TRANSFORM_FN.lastIndex = 0;
  if (consumed === 0 || leftover.length > 0) return null;
  return m;
}

/** Round to `decimals` and render without a trailing ".000" or a signed zero.
 *  Rounding is what makes the output byte-identical for identical input: the
 *  matrix multiplies above are IEEE-754 deterministic, but a full-precision
 *  float prints 17 significant digits of noise that bloats the stored string
 *  for no visual difference. `-0` is normalised to `0` so two arithmetically
 *  equal results can never serialise differently. */
function fmt(n: number, decimals: number): string {
  const r = Number(n.toFixed(decimals));
  return Object.is(r, -0) ? "0" : String(r);
}

/** Path commands this rewriter understands. Elliptical arcs (`A`/`a`) are
 *  deliberately absent: their rx/ry/x-axis-rotation parameters do not survive
 *  an affine transform by rewriting the endpoint alone, so accepting one
 *  would mean emitting a wrong curve. MathJax's SVG fonts emit none. */
const ABSOLUTE_ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };

interface Emitter {
  out: string[];
  box: PathBox;
  decimals: number;
  /** Every emitted command letter and point, kept so `rectangleOf` can decide
   *  whether the whole path happens to be one axis-aligned rectangle. */
  commands: string[];
  points: { x: number; y: number }[];
}

function emitPoint(e: Emitter, m: Matrix, x: number, y: number): void {
  const p = applyMatrix(m, x, y);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new RangeError("non-finite path coordinate");
  }
  e.out.push(`${fmt(p.x, e.decimals)} ${fmt(p.y, e.decimals)}`);
  e.points.push(p);
  if (p.x < e.box.minX) e.box.minX = p.x;
  if (p.y < e.box.minY) e.box.minY = p.y;
  if (p.x > e.box.maxX) e.box.maxX = p.x;
  if (p.y > e.box.maxY) e.box.maxY = p.y;
}

/** Tolerance for treating two emitted coordinates as the same value. Sits an
 *  order of magnitude below the smallest difference three-decimal rounding
 *  can express, so it never merges two genuinely distinct corners. */
const RECT_EPSILON = 1e-6;

/**
 * If the emitted path is exactly ONE axis-aligned rectangle, return its box;
 * otherwise null.
 *
 * This is not a curiosity. MathJax draws a stretched rule — `\overline`'s
 * bar, `\underline`'s — as a deliberately over-long rectangle inside a nested
 * `<svg>` that CLIPS it to length. Clipping a general Bézier outline is not
 * something a flat `d` string can express, but clipping a rectangle by a
 * rectangle is exact, so recognising this one shape is what lets those
 * constructs render at all instead of being refused. See mathRender.ts.
 */
function rectangleOf(commands: string[], points: { x: number; y: number }[]): PathBox | null {
  const shape = commands.join("");
  if (shape !== "MLLL" && shape !== "MLLLZ" && shape !== "MLLLLZ") return null;
  const pts = points.slice();
  if (pts.length === 5) {
    const first = pts[0];
    const last = pts[4];
    if (Math.abs(first.x - last.x) > RECT_EPSILON || Math.abs(first.y - last.y) > RECT_EPSILON) {
      return null;
    }
    pts.pop();
  }
  if (pts.length !== 4) return null;
  // Each edge must move along exactly one axis (and actually be an edge of a
  // rectangle, not a degenerate zig-zag): consecutive corners share exactly
  // one coordinate, all the way around including the closing edge.
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const sameX = Math.abs(a.x - b.x) <= RECT_EPSILON;
    const sameY = Math.abs(a.y - b.y) <= RECT_EPSILON;
    if (sameX === sameY) return null; // both (degenerate) or neither (diagonal)
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** Serialise an axis-aligned box as closed rectangular path data. */
export function boxPathData(box: PathBox, decimals: number): string {
  const f = (n: number) => fmt(n, decimals);
  return (
    `M ${f(box.minX)} ${f(box.minY)} L ${f(box.maxX)} ${f(box.minY)} ` +
    `L ${f(box.maxX)} ${f(box.maxY)} L ${f(box.minX)} ${f(box.maxY)} Z`
  );
}

/** Axis-aligned intersection, or null when the two boxes do not overlap in
 *  both axes (an empty intersection draws nothing, which is exactly what a
 *  clip that excludes a shape entirely should produce). */
export function intersectBoxes(a: PathBox, b: PathBox): PathBox | null {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Rewrite SVG path data with `m` baked in, emitting only ABSOLUTE commands.
 *
 * Relative commands are resolved against the running current point in SOURCE
 * space and emitted absolute; `H`/`V` become `L` (a horizontal segment is no
 * longer horizontal once a matrix with a shear or rotation is applied, and
 * emitting `H` anyway is exactly the kind of silent geometry error this
 * module refuses to make). `S`/`T` shorthands keep their command letter —
 * their implied control point is a reflection through the current point, and
 * an affine map preserves that reflection, so the shorthand stays correct
 * under any matrix.
 *
 * `box` is a CONSERVATIVE bound: it includes Bézier control points, which lie
 * outside the curve they steer. Callers use it only to decide whether
 * geometry escapes a clip rectangle, where over-estimating means refusing a
 * borderline case rather than accepting a clipped one.
 *
 * `rect` is set when the whole path is one axis-aligned rectangle — the shape
 * a stretched rule takes, and the only one this pipeline can clip exactly.
 *
 * Returns null on an unsupported or malformed command.
 */
export function transformPathData(
  d: string,
  m: Matrix,
  decimals: number
): { d: string; box: PathBox; rect: PathBox | null } | null {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens || tokens.length === 0) return null;

  const e: Emitter = {
    out: [],
    box: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    decimals,
    commands: [],
    points: [],
  };

  let i = 0;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let command = "";

  const nextNumber = (): number | null => {
    const t = tokens[i];
    if (t === undefined || /[a-zA-Z]/.test(t)) return null;
    i++;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  try {
    while (i < tokens.length) {
      const token = tokens[i];
      if (/[a-zA-Z]/.test(token)) {
        command = token;
        i++;
      } else if (!command) {
        return null; // numbers before any command
      } else if (command === "M") {
        command = "L"; // repeated moveto args are implicit linetos, per SVG
      } else if (command === "m") {
        command = "l";
      }

      const upper = command.toUpperCase();
      const relative = command !== upper;
      const arity = ABSOLUTE_ARGS[upper];
      if (arity === undefined) return null; // includes A/a — see ABSOLUTE_ARGS

      if (upper === "Z") {
        e.out.push("Z");
        e.commands.push("Z");
        cx = startX;
        cy = startY;
        continue;
      }

      const raw: number[] = [];
      for (let k = 0; k < arity; k++) {
        const n = nextNumber();
        if (n === null) return null;
        raw.push(n);
      }

      // Resolve every argument pair to an ABSOLUTE source-space point.
      const pts: { x: number; y: number }[] = [];
      if (upper === "H") {
        pts.push({ x: relative ? cx + raw[0] : raw[0], y: cy });
      } else if (upper === "V") {
        pts.push({ x: cx, y: relative ? cy + raw[0] : raw[0] });
      } else {
        for (let k = 0; k < raw.length; k += 2) {
          pts.push({
            x: relative ? cx + raw[k] : raw[k],
            y: relative ? cy + raw[k + 1] : raw[k + 1],
          });
        }
      }

      const emitted = upper === "H" || upper === "V" ? "L" : upper;
      e.out.push(emitted);
      e.commands.push(emitted);
      for (const p of pts) emitPoint(e, m, p.x, p.y);

      const last = pts[pts.length - 1];
      cx = last.x;
      cy = last.y;
      if (upper === "M") {
        startX = cx;
        startY = cy;
      }
    }
  } catch {
    return null; // non-finite coordinate — see emitPoint
  }

  if (e.box.minX === Infinity) return null; // no geometry at all
  return { d: e.out.join(" "), box: e.box, rect: rectangleOf(e.commands, e.points) };
}

/** An SVG `<rect>` as path data. MathJax draws every rule — fraction bars,
 *  radical bars, `\overline`'s stroke — as a filled `<rect>`, so this is not
 *  an edge case; it is roughly one in every fraction.
 *
 *  A zero-width/height rect is accepted (it degenerates to an invisible path,
 *  exactly as SVG renders it) but a NEGATIVE one is refused: negative rect
 *  dimensions are invalid SVG, so seeing one means the output is not what
 *  this module thinks it is. */
export function rectPathData(
  x: number,
  y: number,
  width: number,
  height: number,
  m: Matrix,
  decimals: number
): { d: string; box: PathBox; rect: PathBox | null } | null {
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 0 || height < 0) return null;
  const d = `M ${x} ${y} L ${x + width} ${y} L ${x + width} ${y + height} L ${x} ${y + height} Z`;
  return transformPathData(d, m, decimals);
}

/** True when `inner` lies inside `outer` (with a small tolerance for the
 *  rounding the renderer applies). Used to decide whether a nested `<svg>`'s
 *  clip actually removes anything — see mathRender.ts. */
export function boxWithin(inner: PathBox, outer: PathBox, epsilon: number): boolean {
  return (
    inner.minX >= outer.minX - epsilon &&
    inner.minY >= outer.minY - epsilon &&
    inner.maxX <= outer.maxX + epsilon &&
    inner.maxY <= outer.maxY + epsilon
  );
}
