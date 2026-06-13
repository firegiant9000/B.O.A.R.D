import { useEffect } from "react";
import { Platform } from "react-native";
import { resolveShortcut, ShortcutAction, KeyChord } from "../lib/shortcuts";
import { registerHardwareKeys } from "../lib/hardwareKeys";

interface UseShortcutsOptions {
  /** Master switch — false while loading / no board. */
  enabled: boolean;
  /** Read at event time so the closure never goes stale. */
  isEditingText: () => boolean;
  /** Dispatch a resolved action. */
  onAction: (action: ShortcutAction) => void;
  /** Web only: track Shift/Alt for shape-constrain + non-uniform resize. */
  onModifiers?: (m: { shift: boolean; alt: boolean }) => void;
  /** Web only: Space toggles temporary pan (Hand) while held. */
  onSpace?: (held: boolean) => void;
}

/**
 * Phase 11: central keyboard-shortcut wiring. Web uses DOM keydown/keyup (and
 * lets the browser's native `paste` event own Cmd/Ctrl+V so an OS-clipboard
 * image is still caught); native uses react-native-key-command. Both normalize
 * to a `KeyChord` and resolve through the same `resolveShortcut` table.
 */
export function useShortcuts(opts: UseShortcutsOptions) {
  const { enabled, isEditingText, onAction, onModifiers, onSpace } = opts;

  // --- Web: DOM keydown/keyup ---
  useEffect(() => {
    if (!enabled || Platform.OS !== "web" || typeof document === "undefined") return;

    const onKeyDown = (e: KeyboardEvent) => {
      onModifiers?.({ shift: e.shiftKey, alt: e.altKey });
      // Space → temporary pan, unless typing or using it inside a control.
      if (e.key === " " && !isEditingText()) {
        onSpace?.(true);
      }
      const chord: KeyChord = {
        key: e.key,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
      };
      const action = resolveShortcut(chord, { editingText: isEditingText() });
      if (!action) return;
      // Cmd/Ctrl+V is delivered through the dedicated DOM `paste` listener (the
      // only place clipboard image data is readable) — don't consume it here.
      if (action.type === "command" && action.name === "paste") return;
      e.preventDefault();
      onAction(action);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      onModifiers?.({ shift: e.shiftKey, alt: e.altKey });
      if (e.key === " ") onSpace?.(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [enabled, isEditingText, onAction, onModifiers, onSpace]);

  // --- Native: hardware keyboard (Bluetooth) via react-native-key-command ---
  useEffect(() => {
    if (!enabled || Platform.OS === "web") return;
    return registerHardwareKeys((chord) => {
      const action = resolveShortcut(chord, { editingText: isEditingText() });
      if (action) onAction(action);
    });
  }, [enabled, isEditingText, onAction]);
}
