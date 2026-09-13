// Month 6 — math elements. The pure bits BOTH renderers of a math element
// need: the live canvas (`components/board/MathElementView.tsx`,
// `react-native-svg`) and the standalone SVG/PNG/PDF export serializer
// (`lib/svgExport.ts`, plain strings).
//
// It lives here for the same reason `penStyles.renderParamsFor` and
// `shapes.trianglePoints` do: svgExport is a SECOND renderer of the same
// element data, and anything the two must agree on has to have exactly one
// definition or they drift silently — an equation that prints a different
// size or colour than it shows on screen, with nothing failing anywhere.

/**
 * Longest LaTeX the composer will let someone type. ADVISORY ONLY — a
 * client-side cap is an affordance, not a gate. The real limit is
 * `MAX_LATEX_LENGTH` in functions/src/math/mathRender.ts, enforced inside the
 * `renderMath` callable, which is the trust boundary; this exists so the
 * input stops accepting characters the server would only refuse a moment
 * later. Deliberately the same number as the server's.
 *
 * It lives in this pure module rather than in mathService so the composer —
 * a presentational component — can read it without importing the Firestore
 * SDK through the service.
 */
export const MAX_LATEX_LENGTH = 1000;

/** Ink colour for an equation. Math elements carry no per-element colour:
 *  the callable emits ONE monochrome outline (it refuses `\color` precisely
 *  because a single filled path cannot express a second fill), so there is no
 *  stored colour to honour. Near-black rather than pure black, matching the
 *  app's body text. */
export const MATH_DEFAULT_COLOR = "#111827";

/** Placement transform for a math element's path data.
 *
 * `svgPath` is board units at `scale: 1` with its origin at the element's
 * top-left (see MathElement's type comment), so placement is a translate then
 * a uniform scale — nothing here needs to know anything about MathJax's
 * coordinate system.
 *
 * Every input is a stored number a corrupt document could poison, and
 * `typeof NaN === "number"`: a NaN reaching an SVG transform drops the whole
 * subtree with no error anywhere, and a zero or negative scale collapses or
 * mirrors the equation. Both fail closed here so neither renderer has to
 * remember to.
 */
export function mathTransform(el: { x: number; y: number; scale: number }): string {
  const x = Number.isFinite(el.x) ? el.x : 0;
  const y = Number.isFinite(el.y) ? el.y : 0;
  const scale = Number.isFinite(el.scale) && el.scale > 0 ? el.scale : 1;
  return `translate(${x}, ${y}) scale(${scale})`;
}
