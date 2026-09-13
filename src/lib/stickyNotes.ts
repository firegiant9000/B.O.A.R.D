import { StickyColor } from "../types";

/**
 * Month 6 — sticky-note polish (8 colours, 3 sizes). Pure constants + the
 * tolerant-reader guards for both, used by `TextNoteOverlay.tsx` (rendering
 * + the colour/size picker) and, as of Fix Wave F4, by `lib/svgExport.ts`'s
 * `noteNode` too — the exporter resolves a note's colour/size metrics through
 * these SAME helpers rather than a second implementation, so the two cannot
 * drift onto different looks for the same note. (Markdown rendering stays
 * overlay-only; see `noteNode`'s own comment for that boundary.)
 *
 * COLOUR REUSE DECISION: this is a small, fixed, always-free palette,
 * independent of `ColorPickerModal`'s custom per-workspace swatch system
 * (`src/components/ColorPickerModal.tsx`, `workspaceService.canUseCustomPalette`).
 * That system exists to let a Pro workspace define its OWN brand colours for
 * pen strokes — arbitrary hex, alpha, a workspace-wide swatch list. A sticky
 * note's colour here is the opposite shape: eight fixed, named options,
 * available on every plan, closer to the Toolbar's own 8 quick pen-colour
 * dots (`Toolbar.tsx`'s `COLORS`) than to a customizable palette. Wiring
 * sticky colours into the workspace swatch system would gate a plain
 * free-tier polish feature behind Pro for no reason named anywhere in the
 * roadmap, and would create a second, competing colour concept where one
 * clean one already exists for its own (different) purpose. Kept independent
 * on purpose.
 */
export const STICKY_COLORS: Record<StickyColor, string> = {
  // The pre-this-feature look: TextNoteOverlay's original hardcoded
  // `backgroundColor: "#FFF9C4"`. An absent `color` field (every note that
  // predates this task) must render IDENTICALLY to before, not just "a
  // reasonable default" — so this exact hex stays first/default.
  yellow: "#FFF9C4",
  pink: "#F8BBD0",
  blue: "#BBDEFB",
  green: "#C8E6C9",
  orange: "#FFE0B2",
  purple: "#E1BEE7",
  gray: "#E0E0E0",
  red: "#FFCDD2",
};

export const DEFAULT_STICKY_COLOR: StickyColor = "yellow";

const STICKY_COLOR_KEYS = new Set<string>(Object.keys(STICKY_COLORS));

/**
 * Corrupt-stored-value guard: a colour read back from Firestore is untrusted
 * input reaching a style prop. Anything outside the fixed 8-name set — wrong
 * type, an old/rolled-back client's not-yet-known name, a hand-edited doc —
 * falls back to the default rather than reaching `STICKY_COLORS[value]`
 * (`undefined`, not a caught error, if this guard didn't run first).
 */
export function sanitizeStickyColor(value: unknown): StickyColor {
  return typeof value === "string" && STICKY_COLOR_KEYS.has(value)
    ? (value as StickyColor)
    : DEFAULT_STICKY_COLOR;
}

export interface StickySizeMetrics {
  width: number;
  fontSize: number;
  minHeight: number;
}

// Keyed by fontSize (px) — mirrors TextElement.fontSize's own plain-number
// convention instead of a named "sm/md/lg" enum. 14's numbers are the note's
// original hardcoded layout (TextNoteOverlay's `maxWidth: 200`/`fontSize:
// 14`, svgExport's NOTE_WIDTH/NOTE_FONT_SIZE) — same "absent field renders
// identically to before" requirement colour has.
export const STICKY_SIZE_METRICS: Record<number, StickySizeMetrics> = {
  12: { width: 150, fontSize: 12, minHeight: 56 },
  14: { width: 200, fontSize: 14, minHeight: 70 },
  18: { width: 260, fontSize: 18, minHeight: 90 },
};

export const STICKY_FONT_SIZES = Object.keys(STICKY_SIZE_METRICS).map(Number);

export const DEFAULT_STICKY_SIZE = 14;

/**
 * Same guard as colour, for the numeric size. Both the `typeof` check and
 * `Number.isFinite` are redundant against the `includes` membership check
 * below (`Array.includes` never coerces, so it alone already rejects a wrong
 * type, a corrupt `NaN`, or `Infinity`) — kept anyway, loudly, as
 * belt-and-braces and to name the `typeof NaN === "number"` trap for
 * whoever next touches this function.
 */
export function sanitizeStickySize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_STICKY_SIZE;
  return STICKY_FONT_SIZES.includes(value) ? value : DEFAULT_STICKY_SIZE;
}

/** The resolved metrics for a (possibly corrupt/absent) stored size. */
export function stickySizeMetrics(value: unknown): StickySizeMetrics {
  return STICKY_SIZE_METRICS[sanitizeStickySize(value)];
}
