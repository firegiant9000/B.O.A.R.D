import React from "react";
import { G, Path } from "react-native-svg";
import { MATH_DEFAULT_COLOR, mathTransform } from "../../lib/mathInk";
import type { MathElement } from "../../types";

// Month 6 — math elements. Draws one equation into the board's SVG element
// tree as ORDINARY `<Path>` nodes, which is the entire point of rendering
// LaTeX to path data server-side: because this is a `<Path>` like any stroke
// or shape, the element participates in selection, the group transform,
// export, print and viewport culling with no special-casing anywhere.
//
// Sibling of DrawingCanvas's own `ShapeSvg`/`ImageSvg`, kept in its own file
// (and out of any `app/` screen) so it can be rendered and asserted on in
// Jest.
//
// `svgPath` is flat path data in board units at `scale: 1` with its origin at
// the element's top-left — see MathElement's type comment — so placement is
// `translate(x, y) scale(scale)` and nothing here needs to know anything
// about MathJax's coordinate system.

export interface MathElementViewProps {
  element: MathElement;
  /** Overrides the default ink — used by a future themed/dark export path;
   *  callers on the board pass nothing. */
  color?: string;
}

export default function MathElementView({ element, color }: MathElementViewProps) {
  if (!element?.svgPath) return null;

  // `mathTransform` is shared with the SVG/PNG/PDF export serializer so the
  // printed equation is placed and sized identically to the drawn one, and it
  // fails a corrupt x/y/scale closed on both paths at once — see lib/mathInk.
  return (
    <G transform={mathTransform(element)}>
      <Path
        d={element.svgPath}
        fill={color ?? MATH_DEFAULT_COLOR}
        stroke="none"
        // MathJax glyph outlines are font contours: counters (the hole in an
        // "a") are wound opposite to the outer contour, which is exactly what
        // the nonzero rule is for. Stated explicitly rather than relying on
        // the SVG default, since one `d` here carries every glyph of the
        // expression as subpaths of a single path.
        fillRule="nonzero"
      />
    </G>
  );
}
