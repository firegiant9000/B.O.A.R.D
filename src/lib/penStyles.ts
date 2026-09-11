import { DrawPath } from "../types";

/**
 * Pen-variant render parameters (ROADMAP item 12 — highlighter/marker/
 * calligraphy). Pure lookup, no React/SVG import, so it unit-tests without
 * react-native-svg and `DrawingCanvas.tsx` (the one renderer) stays a thin
 * consumer rather than re-deriving these numbers per variant inline.
 *
 * `calligraphy` is deliberately excluded from `renderParamsFor`'s width/cap
 * fields — it renders as a filled variable-width ribbon
 * (`src/lib/calligraphy.ts`), not a constant-width stroked `<Path>`, so this
 * module's `strokeWidth`/`linecap`/`linejoin` would be meaningless for it.
 * `DrawingCanvas.tsx` branches on `penStyle === "calligraphy"` before ever
 * calling this function for the stroke-rendering path.
 */

export type PenStyle = NonNullable<DrawPath["penStyle"]>;

export const PEN_STYLES: PenStyle[] = ["pen", "highlighter", "marker", "calligraphy"];

/** Alpha a pen variant defaults to the moment it's selected (Month 5's picker
 *  UI applies this via `useBoardTools#setActivePenStyle`) — every variant but
 *  the highlighter stays fully opaque; the highlighter's whole point is the
 *  translucent wash, so it needs a sub-1 default or every highlighter stroke
 *  would render as solid ink until a user found the alpha slider themselves. */
export const DEFAULT_ALPHA_FOR_STYLE: Record<PenStyle, number> = {
  pen: 1,
  highlighter: 0.35,
  marker: 1,
  calligraphy: 1,
};

export interface StrokeRenderParams {
  strokeWidth: number;
  opacity: number;
  linecap: "round" | "butt" | "square";
  linejoin: "round" | "miter" | "bevel";
  /** True only for the highlighter — see `DrawingCanvas.tsx`'s render site
   *  for how (and how incompletely) this is honored across platforms. */
  multiplyBlend: boolean;
}

// Render-time multipliers on the user's chosen base width — kept separate
// from the persisted `strokeWidth` (the picker's own 6-preset+slider value)
// so that value stays one honest number across every variant, and a stroke's
// visual "wide/thin" character comes from the variant, not from silently
// stashing a scaled number on disk.
const HIGHLIGHTER_WIDTH_MULTIPLIER = 1.6;
const MARKER_WIDTH_MULTIPLIER = 1.3;

/**
 * Resolves the SVG stroke attributes for one path, given its persisted
 * `penStyle` (`undefined` reads as `"pen"` — the pre-Month-5 default) and
 * `opacity` (`undefined` reads as the variant's own default above, so an
 * old highlighter stroke saved before a caller started persisting `opacity`
 * explicitly still renders translucent instead of silently turning opaque).
 */
export function renderParamsFor(
  penStyle: PenStyle | undefined,
  baseWidth: number,
  opacity: number | undefined
): StrokeRenderParams {
  const style = penStyle ?? "pen";
  const alpha = opacity ?? DEFAULT_ALPHA_FOR_STYLE[style];
  if (style === "highlighter") {
    return {
      strokeWidth: baseWidth * HIGHLIGHTER_WIDTH_MULTIPLIER,
      opacity: alpha,
      linecap: "round",
      linejoin: "round",
      multiplyBlend: true,
    };
  }
  if (style === "marker") {
    return {
      strokeWidth: baseWidth * MARKER_WIDTH_MULTIPLIER,
      opacity: alpha,
      linecap: "butt",
      linejoin: "miter",
      multiplyBlend: false,
    };
  }
  // "pen" and "calligraphy" (the latter never actually reaches the stroked-
  // Path renderer — see the module comment) share the plain round/round look.
  return {
    strokeWidth: baseWidth,
    opacity: alpha,
    linecap: "round",
    linejoin: "round",
    multiplyBlend: false,
  };
}

/** The calligraphy ribbon's [min, max] half-width band, derived from the
 *  user's chosen base width so a wider slider setting scales the whole
 *  nib, not just its thickest edge. */
export function calligraphyWidthRange(baseWidth: number): [min: number, max: number] {
  return [Math.max(1, baseWidth * 0.4), baseWidth * 1.3];
}
