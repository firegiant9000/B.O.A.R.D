import React from "react";
import { render, waitFor } from "@testing-library/react-native";
import { G, Rect, Text as SvgText, TSpan } from "react-native-svg";
import CodeElementView from "../CodeElementView";
import { CODE_BACKGROUND_COLOR, CODE_BORDER_COLOR, layoutCodeBox } from "../../../lib/codeRender";
import type { CodeElement } from "../../../types";

jest.mock("../../../lib/osClipboard", () => ({
  setClipboardText: jest.fn(),
}));
import { setClipboardText } from "../../../lib/osClipboard";
const mockSetClipboardText = setClipboardText as jest.Mock;

/**
 * CodeElementView.test.tsx — Month 6 code elements.
 *
 * The architectural claim under test: a code element draws as a background
 * card plus one `<TSpan>` run per Shiki-colored token, laid out with
 * `dy`-chained line `<TSpan>`s — no HTML/DOM anywhere (see
 * `lib/codeRender.ts`'s header). The copy badge is the element-level "copy
 * code" action the brief asks for, gated on `selected` so it doesn't clutter
 * every code block on the board at once.
 */

function makeCode(overrides: Partial<CodeElement> = {}): CodeElement {
  return {
    id: "c1",
    schemaVersion: 1,
    type: "code",
    boardId: "b1",
    userId: "u1",
    code: "const x = 1;",
    language: "ts",
    x: 40,
    y: 60,
    width: 160,
    height: 50,
    fontSize: 14,
    rotation: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function renderCode(props: Partial<React.ComponentProps<typeof CodeElementView>> = {}) {
  const el = props.element ?? makeCode();
  return render(<CodeElementView element={el} selected={props.selected} onCopied={props.onCopied} />);
}

function nodesOfType(tree: ReturnType<typeof render>, type: React.ElementType) {
  return tree.UNSAFE_root.findAll((n: { type: unknown }) => n.type === type);
}

describe("CodeElementView (Month 6)", () => {
  beforeEach(() => {
    mockSetClipboardText.mockReset();
    mockSetClipboardText.mockResolvedValue(true);
  });

  it("draws a background card at the element's own box", () => {
    const el = makeCode();
    const tree = renderCode({ element: el });
    const rects = nodesOfType(tree, Rect);
    const card = rects.find((r: any) => r.props.testID !== "code-copy-badge");
    expect(card?.props.x).toBe(40);
    expect(card?.props.y).toBe(60);
    expect(card?.props.width).toBe(160);
    expect(card?.props.height).toBe(50);
    expect(card?.props.fill).toBe(CODE_BACKGROUND_COLOR);
    expect(card?.props.stroke).toBe(CODE_BORDER_COLOR);
  });

  it("renders one line-level TSpan per source line, each carrying the tokenized runs", () => {
    const el = makeCode({ code: "const x = 1;\nconsole.log(x);" });
    const tree = renderCode({ element: el });
    const svgText = nodesOfType(tree, SvgText);
    expect(svgText).toHaveLength(1);
    const lineSpans = svgText[0].props.children;
    expect(lineSpans).toHaveLength(2);
    // Content round-trips back through the nested run TSpans.
    const flatten = (node: any): string =>
      typeof node === "string"
        ? node
        : Array.isArray(node)
          ? node.map(flatten).join("")
          : node?.props?.children != null
            ? flatten(node.props.children)
            : "";
    expect(lineSpans.map(flatten).join("\n")).toBe(el.code);
    // Every line after the first carries the line-height step; the first
    // does not (its position comes from the parent <Text>'s own x/y).
    const layout = layoutCodeBox(el.code, el.fontSize);
    expect(lineSpans[0].props.dy).toBe(0);
    expect(lineSpans[1].props.dy).toBeCloseTo(layout.lineHeight, 5);
  });

  it("does not render the copy badge when not selected", () => {
    const tree = renderCode({ selected: false });
    expect(nodesOfType(tree, Rect).some((r: any) => r.props.testID === "code-copy-badge")).toBe(false);
  });

  it("renders the copy badge when selected, and copies the source on press", async () => {
    const el = makeCode({ code: "print('hi')" });
    const onCopied = jest.fn();
    const tree = renderCode({ element: el, selected: true, onCopied });
    const badge = nodesOfType(tree, Rect).find((r: any) => r.props.testID === "code-copy-badge");
    expect(badge).toBeDefined();
    badge!.props.onPress();
    expect(mockSetClipboardText).toHaveBeenCalledWith("print('hi')");
    await waitFor(() => expect(onCopied).toHaveBeenCalledWith(true));
  });

  it("reports a failed clipboard write through onCopied rather than throwing", async () => {
    mockSetClipboardText.mockResolvedValueOnce(false);
    const onCopied = jest.fn();
    const tree = renderCode({ selected: true, onCopied });
    const badge = nodesOfType(tree, Rect).find((r: any) => r.props.testID === "code-copy-badge");
    badge!.props.onPress();
    await waitFor(() => expect(onCopied).toHaveBeenCalledWith(false));
  });

  it("wraps in a rotation transform only when rotation is non-zero", () => {
    const flat = renderCode({ element: makeCode({ rotation: 0 }) });
    // No G at all should carry a `rotate(...)` transform when rotation is 0.
    expect(nodesOfType(flat, G).some((g: any) => String(g.props.transform).startsWith("rotate"))).toBe(
      false
    );

    const rotated = renderCode({ element: makeCode({ rotation: 45, width: 100, height: 40, x: 10, y: 20 }) });
    const groups = nodesOfType(rotated, G).filter((g: any) =>
      String(g.props.transform).startsWith("rotate")
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].props.transform).toBe("rotate(45, 60, 40)");
  });

  it("fails closed on non-finite geometry instead of emitting NaN into the rotation transform", () => {
    const tree = renderCode({
      element: makeCode({ rotation: 30, x: NaN, y: NaN, width: NaN, height: NaN }),
    });
    const rotating = nodesOfType(tree, G).find((g: any) => String(g.props.transform).startsWith("rotate"));
    expect(rotating?.props.transform).not.toMatch(/NaN/);
    expect(rotating?.props.transform).toBe("rotate(30, 0, 0)");
  });
});
