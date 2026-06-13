import { Platform } from "react-native";
import type { ShapeKind } from "../types";

// Phase 11: keyboard shortcuts. This module is the pure, platform-agnostic core —
// a key chord resolves to a single action, and the cheat-sheet data is derived
// from the same source of truth. The web DOM listener and the native
// react-native-key-command listener both normalize their event into a `KeyChord`
// and call `resolveShortcut`, so the binding table lives in exactly one place.

export type Tool = "pen" | "eraser" | "text" | "select" | "shape" | "hand";

export type CommandName =
  | "undo"
  | "redo"
  | "selectAll"
  | "copy"
  | "paste"
  | "duplicate"
  | "delete"
  | "deselect"
  | "bringToFront"
  | "sendToBack"
  | "zoomIn"
  | "zoomOut"
  | "zoom100"
  | "zoomFit"
  | "help";

export type ShortcutAction =
  | { type: "tool"; tool: Tool }
  | { type: "shape"; shape: ShapeKind }
  | { type: "command"; name: CommandName };

/** A normalized key event, decoupled from DOM / native event shapes. */
export interface KeyChord {
  /** The produced character/key. Single chars are matched case-insensitively. */
  key: string;
  /** Cmd (⌘) on Apple platforms. */
  meta: boolean;
  /** Ctrl. */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export interface ShortcutContext {
  /** True while the user is typing in a text element/input — suppresses all
   *  shortcuts so the field gets normal keystrokes (incl. its own copy/paste). */
  editingText: boolean;
}

// Single-key tool switches (no modifier). P E T S H + the five shape kinds
// R O L A N, exactly the set the plan reserves ("P E T R O L A S H N").
const TOOL_KEYS: Record<string, Tool> = {
  p: "pen",
  e: "eraser",
  t: "text",
  s: "select",
  h: "hand",
};

const SHAPE_KEYS: Record<string, ShapeKind> = {
  r: "rect",
  o: "ellipse", // "oval"
  l: "line",
  a: "arrow",
  n: "triangle", // "triaNgle" — the leftover letter from the reserved set
};

/**
 * Resolve a key chord to a single action, or null if nothing is bound. Modifier
 * combos (Cmd/Ctrl) take precedence over bare single-key tool switches, so e.g.
 * Cmd+A is select-all, not the arrow tool. Returns null while editing text.
 */
export function resolveShortcut(
  chord: KeyChord,
  ctx: ShortcutContext
): ShortcutAction | null {
  if (ctx.editingText) return null;

  const mod = chord.meta || chord.ctrl;
  const k = chord.key.length === 1 ? chord.key.toLowerCase() : chord.key;

  // --- Bare keys that work with or without Shift (Delete / Escape / help) ---
  if (!mod) {
    if (chord.key === "Delete" || chord.key === "Backspace") {
      return { type: "command", name: "delete" };
    }
    if (chord.key === "Escape") {
      return { type: "command", name: "deselect" };
    }
    // "?" is Shift+/ on most layouts; match the produced character directly.
    if (chord.key === "?") {
      return { type: "command", name: "help" };
    }
    if (chord.shift && k === "1") {
      return { type: "command", name: "zoomFit" };
    }
    if (chord.shift && k === "0") {
      return { type: "command", name: "zoom100" };
    }
  }

  // --- Modifier (Cmd/Ctrl) combos ---
  if (mod) {
    switch (k) {
      case "z":
        return { type: "command", name: chord.shift ? "redo" : "undo" };
      case "y":
        return { type: "command", name: "redo" };
      case "a":
        return { type: "command", name: "selectAll" };
      case "c":
        return { type: "command", name: "copy" };
      case "v":
        return { type: "command", name: "paste" };
      case "d":
        return { type: "command", name: "duplicate" };
      case "]":
        return { type: "command", name: "bringToFront" };
      case "[":
        return { type: "command", name: "sendToBack" };
      case "0":
        return { type: "command", name: "zoom100" };
      case "=":
      case "+":
        return { type: "command", name: "zoomIn" };
      case "-":
        return { type: "command", name: "zoomOut" };
      default:
        return null;
    }
  }

  // --- Bare single-key tool / shape switches (no Shift/Alt) ---
  if (!chord.shift && !chord.alt) {
    if (TOOL_KEYS[k]) return { type: "tool", tool: TOOL_KEYS[k] };
    if (SHAPE_KEYS[k]) return { type: "shape", shape: SHAPE_KEYS[k] };
  }

  return null;
}

// --- Cheat-sheet data (the `?` modal) ---------------------------------------

export interface CheatItem {
  /** Display tokens for the chord, e.g. ["⌘", "Z"] or ["P"]. */
  keys: string[];
  label: string;
}
export interface CheatSection {
  title: string;
  items: CheatItem[];
}

/** The primary-modifier glyph for display: ⌘ on Apple, Ctrl elsewhere. */
export function modLabel(isApple = Platform.OS === "ios" || Platform.OS === "macos"): string {
  return isApple ? "⌘" : "Ctrl";
}

/** Build the cheat-sheet sections with the platform-appropriate modifier glyph. */
export function buildCheatSheet(mod: string = modLabel()): CheatSection[] {
  return [
    {
      title: "Tools",
      items: [
        { keys: ["P"], label: "Pen" },
        { keys: ["E"], label: "Eraser" },
        { keys: ["T"], label: "Text" },
        { keys: ["S"], label: "Select" },
        { keys: ["H"], label: "Hand (pan)" },
      ],
    },
    {
      title: "Shapes",
      items: [
        { keys: ["R"], label: "Rectangle" },
        { keys: ["O"], label: "Ellipse" },
        { keys: ["L"], label: "Line" },
        { keys: ["A"], label: "Arrow" },
        { keys: ["N"], label: "Triangle" },
      ],
    },
    {
      title: "Edit",
      items: [
        { keys: [mod, "Z"], label: "Undo" },
        { keys: [mod, "⇧", "Z"], label: "Redo" },
        { keys: [mod, "A"], label: "Select all" },
        { keys: [mod, "C"], label: "Copy" },
        { keys: [mod, "V"], label: "Paste" },
        { keys: [mod, "D"], label: "Duplicate" },
        { keys: [mod, "]"], label: "Bring to front" },
        { keys: [mod, "["], label: "Send to back" },
        { keys: ["Delete"], label: "Delete selection" },
        { keys: ["Esc"], label: "Deselect" },
      ],
    },
    {
      title: "View",
      items: [
        { keys: ["⇧", "1"], label: "Zoom to fit" },
        { keys: [mod, "0"], label: "Zoom to 100%" },
        { keys: [mod, "+"], label: "Zoom in" },
        { keys: [mod, "−"], label: "Zoom out" },
        { keys: ["Space", "drag"], label: "Pan" },
        { keys: ["?"], label: "Show this cheat sheet" },
      ],
    },
  ];
}
