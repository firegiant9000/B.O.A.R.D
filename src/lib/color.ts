/**
 * Colour model for the Month 5 custom picker (ROADMAP item 12 — colour +
 * stroke polish). Pure, dependency-free RGBA hex handling: the picker's hex
 * input, alpha slider and swatch/recent-colours rows all read and write
 * through this module rather than each parsing hex by hand.
 *
 * Deliberately separate from `src/lib/shapes.ts#hexToRgba` (shape fill's
 * fixed-alpha CSS-string helper) — this module is the two-way model (parse
 * AND format, with a real `RGBA` struct in between) the picker UI needs,
 * where `hexToRgba` is a one-way "hex → CSS string" convenience.
 *
 * `DrawPath.color` on the canvas stays a plain opaque `#RRGGBB` string (see
 * that field's own comment) — an 8-digit hex embedding alpha is a picker-UI
 * concept only, never how a stroke is persisted or rendered. Rendering alpha
 * goes through the separate `DrawPath.opacity` field / SVG `strokeOpacity`,
 * so this module's `RGBA`/hex8 round-trip never has to agree with SVG's own
 * (inconsistent, across web vs. native RNSVG) support for 8-digit hex colors.
 */

export interface RGBA {
  /** 0-255 */
  r: number;
  /** 0-255 */
  g: number;
  /** 0-255 */
  b: number;
  /** 0-1 */
  a: number;
}

const HEX6_RE = /^#?([0-9a-fA-F]{6})$/;
const HEX8_RE = /^#?([0-9a-fA-F]{8})$/;

/** Clamps to [0, 255] and rounds — shared by every channel parse/format below. */
function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Clamps alpha to [0, 1]. `NaN` (an unparseable/garbage input) maps to fully
 *  opaque rather than propagating — a picker showing "invisible" for a value
 *  that was never really a number would be a worse failure mode than opaque. */
export function clampAlpha(a: number): number {
  if (Number.isNaN(a)) return 1;
  return Math.max(0, Math.min(1, a));
}

/** True for a bare or `#`-prefixed 6- or 8-digit hex string — the two shapes
 *  `fromHex8` accepts. Used by the picker's hex text input to colour its own
 *  validity state without constructing (and discarding) a full `RGBA`. */
export function isValidHex(input: string): boolean {
  return HEX6_RE.test(input) || HEX8_RE.test(input);
}

/**
 * Parses a `#RRGGBB` or `#RRGGBBAA` string (the `#` is optional, case is
 * ignored) into an `RGBA`. A 6-digit hex carries no alpha byte, so it maps to
 * fully opaque (`a: 1`) — never a parse failure. Anything else — wrong
 * length, non-hex characters, empty string — returns `null` rather than
 * throwing, so a caller mid-keystroke on the hex input never crashes the
 * picker on a not-yet-complete value.
 */
export function fromHex8(input: string): RGBA | null {
  if (typeof input !== "string") return null;
  const hex8 = HEX8_RE.exec(input);
  if (hex8) {
    const h = hex8[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: clampAlpha(parseInt(h.slice(6, 8), 16) / 255),
    };
  }
  const hex6 = HEX6_RE.exec(input);
  if (hex6) {
    const h = hex6[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  return null;
}

function byteToHex(n: number): string {
  return clampByte(n).toString(16).padStart(2, "0");
}

/** Formats an `RGBA` back to a lowercase `#rrggbbaa` string. Out-of-range
 *  channel/alpha values are clamped rather than emitting invalid hex, so this
 *  never throws on a caller-constructed `RGBA` with a stray out-of-band value. */
export function toHex8(color: RGBA): string {
  const a = clampByte(clampAlpha(color.a) * 255);
  return `#${byteToHex(color.r)}${byteToHex(color.g)}${byteToHex(color.b)}${byteToHex(a)}`;
}

/** Formats an `RGBA` back to the plain opaque `#rrggbb` a `DrawPath.color` /
 *  `ShapeElement.stroke` field stores — alpha is dropped, not encoded. */
export function toHex6(color: RGBA): string {
  return `#${byteToHex(color.r)}${byteToHex(color.g)}${byteToHex(color.b)}`;
}

/** Formats an `RGBA` as a `rgba(r, g, b, a)` CSS string — valid as a React
 *  Native `backgroundColor` style value, used by the picker's own preview
 *  swatch (over a checkerboard, so alpha is visible) rather than relying on
 *  8-digit hex support that RNSVG/RN's style parser don't consistently have. */
export function toCssRgba(color: RGBA): string {
  return `rgba(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}, ${clampAlpha(color.a)})`;
}
