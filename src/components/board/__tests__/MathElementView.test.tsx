import React from "react";
import { render } from "@testing-library/react-native";
import { G, Path } from "react-native-svg";
import MathElementView from "../MathElementView";
import { MATH_DEFAULT_COLOR, mathTransform } from "../../../lib/mathInk";
import type { MathElement } from "../../../types";

/**
 * MathElementView.test.tsx — Month 6 math elements.
 *
 * The architectural claim this renderer exists to deliver is that an equation
 * is an ORDINARY `<Path>` on the canvas, which is what buys it selection,
 * transform, export and print with no special-casing. These tests assert that
 * literally: a Path node, with the equation's own `d`, under the shared
 * placement transform — and that a corrupt stored number cannot silently
 * erase the element by putting NaN in that transform.
 */

function makeMath(overrides: Partial<MathElement> = {}): MathElement {
  return {
    id: "m1",
    schemaVersion: 1,
    type: "math",
    boardId: "b1",
    userId: "u1",
    latex: "x^2",
    svgPath: "M 0 0 L 10 0 L 10 8 Z",
    x: 40,
    y: 60,
    width: 30,
    height: 12,
    scale: 1.5,
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Rendered WITHOUT an `<Svg>` wrapper, deliberately. `Svg` mounts a `<G>` of
 * its own for style/font defaults, and that wrapper sorts BEFORE this
 * component's own group — so `findAll(G)[0]` would be the library's node,
 * whose `transform` is undefined, and every assertion below would be reading
 * the wrong element. react-native-svg renders each node standalone in the
 * test renderer, so omitting the root removes the ambiguity entirely.
 */
function renderMath(el: MathElement, color?: string) {
  return render(<MathElementView element={el} color={color} />);
}

/** Rendered nodes of a given react-native-svg component, matched by identity
 *  rather than by display name — the library mounts internal host wrappers
 *  (`RNSVGGroup`, `RNSVGPath`) alongside each public component. */
function nodesOfType(tree: ReturnType<typeof render>, type: React.ElementType) {
  return tree.UNSAFE_root.findAll((n: { type: unknown }) => n.type === type);
}

describe("MathElementView (Month 6)", () => {
  it("renders the equation as a single Path carrying its own path data", () => {
    const el = makeMath();
    const tree = renderMath(el);
    const paths = nodesOfType(tree, Path);
    expect(paths).toHaveLength(1);
    expect(paths[0].props.d).toBe(el.svgPath);
    expect(paths[0].props.fill).toBe(MATH_DEFAULT_COLOR);
    expect(paths[0].props.stroke).toBe("none");
    // Font counters (the hole in an "a") are wound against their outer
    // contour, and one `d` here carries every glyph of the expression.
    expect(paths[0].props.fillRule).toBe("nonzero");
  });

  it("places it with the SAME transform the export serializer uses", () => {
    const el = makeMath();
    const tree = renderMath(el);
    const groups = nodesOfType(tree, G);
    expect(groups[0].props.transform).toBe("translate(40, 60) scale(1.5)");
    // Shared definition, so a printed equation lands where the drawn one did.
    expect(groups[0].props.transform).toBe(mathTransform(el));
  });

  it("honours an explicit colour override", () => {
    const tree = renderMath(makeMath(), "#ff0000");
    expect(nodesOfType(tree, Path)[0].props.fill).toBe("#ff0000");
  });

  it("renders nothing for an element with no path data", () => {
    // There is genuinely nothing to draw; an empty <Path> would be a node
    // that exists, can be hit, and shows nothing.
    const tree = renderMath(makeMath({ svgPath: "" }));
    expect(nodesOfType(tree, Path)).toHaveLength(0);
  });

  it.each([
    ["a NaN x", { x: NaN }, "translate(0, 60) scale(1.5)"],
    ["an Infinity y", { y: Infinity }, "translate(40, 0) scale(1.5)"],
    ["a NaN scale", { scale: NaN }, "translate(40, 60) scale(1)"],
    ["a zero scale", { scale: 0 }, "translate(40, 60) scale(1)"],
    ["a negative scale", { scale: -2 }, "translate(40, 60) scale(1)"],
  ])("fails %s closed instead of emitting it into the transform", (_label, over, expected) => {
    // `typeof NaN === "number"`. A NaN in an SVG transform drops the whole
    // subtree with NO error anywhere — the equation would simply vanish, and
    // a zero/negative scale would collapse or mirror it.
    const tree = renderMath(makeMath(over as Partial<MathElement>));
    expect(nodesOfType(tree, G)[0].props.transform).toBe(expected);
    // And it still draws.
    expect(nodesOfType(tree, Path)).toHaveLength(1);
  });
});
