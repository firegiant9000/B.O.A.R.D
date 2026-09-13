import React, { useMemo } from "react";
import { G, Rect, Text as SvgText, TSpan } from "react-native-svg";
import {
  CODE_BACKGROUND_COLOR,
  CODE_BORDER_COLOR,
  CODE_DEFAULT_FOREGROUND,
  codeTransform,
  layoutCodeBox,
  tokenizeCode,
} from "../../lib/codeRender";
import { setClipboardText } from "../../lib/osClipboard";
import type { CodeElement } from "../../types";

// Month 6 — code elements. Draws one snippet into the board's SVG element
// tree: a background card (so highlighted text reads correctly regardless of
// what's behind it — a stroke, another element, the canvas background) plus
// one `<TSpan>` run per Shiki token, one `<TSpan>` line wrapping those via
// `dy`, inside a single `<Text>` — exactly the shape `tokenizeCode` returns,
// with no HTML/DOM step anywhere (`lib/codeRender.ts`'s header explains why
// that's the whole point of the fine-grained/JS-engine choice).
//
// Sibling of MathElementView, kept in its own file (and out of any `app/`
// screen) so it can be rendered and asserted on in Jest.

export interface CodeElementViewProps {
  element: CodeElement;
  /** True while this element is the (sole) selection — gates the "copy code"
   *  corner badge, the same way DrawingCanvas already gates a math element's
   *  offset-transform wrapper on its own `isSel(id)`. Defaults to false so a
   *  caller that doesn't track selection (a snapshot preview, a test) never
   *  has to thread one through. */
  selected?: boolean;
  /** Fired after a tap on the copy badge resolves, with whether the OS
   *  clipboard write actually succeeded (`osClipboard.setClipboardText`
   *  returns false rather than throwing when it's unavailable) — so a caller
   *  that wants to show its own toast/message can, without this component
   *  owning any app-level banner UI. Optional; defaults to a no-op. */
  onCopied?: (ok: boolean) => void;
}

const BADGE_SIZE = 20;
const BADGE_MARGIN = 4;

export default function CodeElementView({
  element,
  selected = false,
  onCopied,
}: CodeElementViewProps) {
  if (!element) return null;

  const lines = useMemo(
    () => tokenizeCode(element.code, element.language),
    [element.code, element.language]
  );
  // `layoutCodeBox` here supplies line METRICS (padding/lineHeight) derived
  // from `fontSize` — NOT the box dimensions, which come from the element's
  // own (possibly manually resized) `width`/`height`. See `CodeElement`'s
  // type comment on why those two can legitimately disagree after a resize,
  // same as TextElement.
  const layout = useMemo(
    () => layoutCodeBox(element.code, element.fontSize),
    [element.code, element.fontSize]
  );

  const width = Number.isFinite(element.width) && element.width > 0 ? element.width : 1;
  const height = Number.isFinite(element.height) && element.height > 0 ? element.height : 1;
  const x = Number.isFinite(element.x) ? element.x : 0;
  const y = Number.isFinite(element.y) ? element.y : 0;
  const fontSize =
    Number.isFinite(element.fontSize) && element.fontSize > 0 ? element.fontSize : layout.padding;

  const firstBaselineDy = layout.padding + layout.lineHeight * 0.8;

  const handleCopy = () => {
    setClipboardText(element.code)
      .then((ok) => onCopied?.(ok))
      .catch(() => onCopied?.(false));
  };

  const body = (
    <G>
      <Rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={6}
        fill={CODE_BACKGROUND_COLOR}
        stroke={CODE_BORDER_COLOR}
        strokeWidth={1}
      />
      <SvgText
        x={x + layout.padding}
        y={y + firstBaselineDy}
        fontFamily="Menlo, Consolas, monospace"
        fontSize={fontSize}
      >
        {lines.map((line, i) => (
          <TSpan key={i} x={x + layout.padding} dy={i === 0 ? 0 : layout.lineHeight}>
            {line.length === 0
              ? " "
              : line.map((run, j) => (
                  <TSpan key={j} fill={run.color || CODE_DEFAULT_FOREGROUND}>
                    {run.content}
                  </TSpan>
                ))}
          </TSpan>
        ))}
      </SvgText>
      {selected && (
        <G>
          <Rect
            testID="code-copy-badge"
            x={x + width - BADGE_SIZE - BADGE_MARGIN}
            y={y + BADGE_MARGIN}
            width={BADGE_SIZE}
            height={BADGE_SIZE}
            rx={4}
            fill="#111827"
            onPress={handleCopy}
            accessibilityLabel="Copy code"
          />
          <SvgText
            x={x + width - BADGE_SIZE / 2 - BADGE_MARGIN}
            y={y + BADGE_MARGIN + BADGE_SIZE / 2 + 4}
            fontSize={12}
            fill="#ffffff"
            textAnchor="middle"
            // Decorative echo of the badge above it — the badge itself (not
            // this glyph) carries the accessible name, so this never needs
            // its own onPress or role.
          >
            ⧉
          </SvgText>
        </G>
      )}
    </G>
  );

  const transform = codeTransform(element);
  return transform ? <G transform={transform}>{body}</G> : body;
}
