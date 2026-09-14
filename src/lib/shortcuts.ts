import { Platform } from "react-native";
import type { ShapeKind } from "../types";

// Phase 11: keyboard shortcuts. This module is the pure, platform-agnostic core —
// a key chord resolves to a single action, and the cheat-sheet data is derived
// from the same source of truth. The web DOM listener and the native
// react-native-key-command listener both normalize their event into a `KeyChord`
// and call `resolveShortcut`, so the binding table lives in exactly one place.

// Month 5: "laser" joins this set outside the reserved P E T R O L A S H N
// letters below — bare "l" is already the Line shape key, so the laser binds
// to Shift+L instead (see the dedicated check in `resolveShortcut`).
export type Tool = "pen" | "eraser" | "text" | "select" | "shape" | "hand" | "laser";

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
  // Month 6 — ROADMAP.md:243 assigns `N` to "sticky note". A sticky note is an
  // insert ACTION, not a tool mode: `Tool` above has no `sticky` member, and
  // the toolbar exposes a one-shot `onInsertNote` button rather than a
  // persistent mode (see Toolbar.tsx's own doc comment on that prop — "the
  // board's ONE insert entry point"). So the spec's binding can only be a
  // command, and the screen registers `elements.beginNote` behind this name.
  // Unlike every other command here, it CREATES content, so it is gated — see
  // `gateShortcutCommands` below.
  | "insertNote"
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

// Single-key tool switches (no modifier): P E T S H. These plus the shape and
// command keys below consume the reserved letter set "P E T R O L A S H N".
const TOOL_KEYS: Record<string, Tool> = {
  p: "pen",
  e: "eraser",
  t: "text",
  s: "select",
  h: "hand",
};

// Four of the five shape kinds — R O L A. Triangle deliberately has NO key:
// ROADMAP.md:243's shortcut table assigns it none, and gives `N` to the sticky
// note instead (`COMMAND_KEYS` below). `N` previously held "triaNgle" as the
// leftover letter of the reserved set, which was the plan's own invention, not
// the spec's; where the two conflict the spec wins. The honest cost: triangle
// loses a one-key route. It keeps two others — `ShapeOptionsBar.tsx`'s `KINDS`
// row lists all five kinds, and `shapeRecognition.ts` can still perfect a
// drawn triangle — so this removes a convenience the spec never granted, not
// the only way to reach a primitive.
const SHAPE_KEYS: Record<string, ShapeKind> = {
  r: "rect",
  o: "ellipse", // "oval"
  l: "line",
  a: "arrow",
};

// Single-key commands that aren't a mode switch. `N` is the spec's sticky-note
// binding; it fires the same insert action the toolbar's note button does.
const COMMAND_KEYS: Record<string, CommandName> = {
  n: "insertNote",
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
    // Month 5 (laser pointer): the plan's "hotkey L" can't bind to bare "l" —
    // that's already the Line shape key in the reserved P E T R O L A S H N
    // set above — so this is the one deliberate exception to "no tool
    // switches with Shift held" (the bare single-key block below explicitly
    // excludes Shift). This chord only selects the tool; whether a given
    // pointer/touch report becomes a continuous trail or a single ping is
    // decided by actual press state once the laser is active, not by
    // anything keyboard-related here — see `useBoardCollab.ts#publishPointer`
    // (its `pressed` parameter) and the laser branch in
    // `BoardCanvas.tsx#handleCanvasTap`.
    if (chord.shift && k === "l") {
      return { type: "tool", tool: "laser" };
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

  // --- Bare single-key tool / shape switches + insert commands (no Shift/Alt) ---
  if (!chord.shift && !chord.alt) {
    if (TOOL_KEYS[k]) return { type: "tool", tool: TOOL_KEYS[k] };
    if (SHAPE_KEYS[k]) return { type: "shape", shape: SHAPE_KEYS[k] };
    if (COMMAND_KEYS[k]) return { type: "command", name: COMMAND_KEYS[k] };
  }

  return null;
}

// --- Command permission gate ------------------------------------------------

export interface ShortcutCommandGates {
  /**
   * The same boolean the Toolbar gates its editing UI on (`canEdit` — the
   * screen's `embedCanEdit`, which folds board membership role, the presenter
   * content lock, and an embed session's scope into one expression).
   */
  canEdit: boolean;
  /**
   * False while an active presenter has locked the audience out of creating
   * content. Narrower than `canEdit`: an editor keeps selection, navigation
   * and their own undo history through a presentation, they just can't add
   * anything new.
   */
  canCreateContent: boolean;
}

/**
 * Strip the commands a given board session isn't allowed to run.
 *
 * WHY THIS EXISTS AS A FUNCTION, and not as per-entry ternaries in the
 * screen's command table: every shortcut here has a toolbar or canvas twin,
 * and the keyboard route is the easy one to forget when the visible one is
 * gated. The
 * note-insert case makes that concrete — `Toolbar.tsx` returns its read-only
 * row before the insert group is reached (`if (!canEdit)`), hiding the note
 * button for a read-only viewer, a commenter, a presenter-locked member and a
 * view-scope embed alike. An `N` keystroke that inserted a note anyway would
 * be a permission bypass with a real security shape, not a cosmetic slip. The
 * screen has no test harness (there is no `app/board/__tests__`), so keeping
 * the decision in a pure function here is what makes it assertable at all.
 *
 * `handlers` is a TOTAL `Record<CommandName, …>` on purpose: a future command
 * added to the union fails to compile until someone decides, explicitly,
 * whether it needs a gate.
 *
 * Honest scope: this is an affordance gate, exactly like hiding the button.
 * The security boundary is firestore.rules — its `notes` match is what
 * actually refuses the write. This stops a keystroke from offering an action
 * the UI denies; it is not what makes the action safe.
 */
export function gateShortcutCommands(
  handlers: Record<CommandName, () => void>,
  gates: ShortcutCommandGates
): Partial<Record<CommandName, () => void>> {
  const { paste, duplicate, insertNote, ...rest } = handlers;
  return {
    ...rest,
    // An omitted entry is already a silent no-op at the call site
    // (`table[name]?.()`), so a gated chord needs no separate disabled state.
    ...(gates.canCreateContent ? { paste, duplicate } : {}),
    ...(gates.canEdit ? { insertNote } : {}),
  };
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
        { keys: ["⇧", "L"], label: "Laser pointer" },
        // Listed under Tools because ROADMAP.md:243 groups it with the tool
        // switches, but labelled "Insert sticky note" rather than "Sticky
        // note": it is a one-shot insert, not a mode you stay in, and this
        // modal is the only place a user is told what the key does.
        { keys: ["N"], label: "Insert sticky note" },
      ],
    },
    {
      title: "Shapes",
      items: [
        { keys: ["R"], label: "Rectangle" },
        { keys: ["O"], label: "Ellipse" },
        { keys: ["L"], label: "Line" },
        { keys: ["A"], label: "Arrow" },
        // No Triangle row: `N` is the sticky note (above), and triangle has no
        // key under ROADMAP.md:243's table. Advertising one here would be a
        // user-visible false claim — see `SHAPE_KEYS`' comment for where
        // triangle is still reachable.
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
