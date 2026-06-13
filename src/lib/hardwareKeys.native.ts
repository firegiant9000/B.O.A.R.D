import {
  constants,
  eventEmitter,
  registerKeyCommands,
  unregisterKeyCommands,
  type KeyCommandDefinition,
  type KeyCommandResponse,
} from "react-native-key-command";
import type { KeyChord } from "./shortcuts";

// Native (iOS/Android) hardware-keyboard support via react-native-key-command.
// We register the full Phase 11 binding set up front, then translate each
// emitted key-command response into the same `KeyChord` shape the web path
// produces, so `resolveShortcut` stays the single source of truth.
//
// NOTE: this path requires the library's native hooks (AppDelegate keyCommands /
// MainActivity onKeyDown) to be present — injected by the Expo config plugin
// `plugins/withHardwareKeyCommands.js` during prebuild. It cannot be exercised in
// Jest/web and must be verified on a device with a Bluetooth keyboard.

const CMD = constants.keyModifierCommand;
const SHIFT = constants.keyModifierShift;
const SHIFT_CMD = constants.keyModifierShiftCommand;

// The commands we register. Letters are bare tool/shape switches; the Cmd/Shift
// combos mirror the web bindings. Special keys (Escape, Delete) use the lib's
// predefined inputs where available.
const COMMANDS: KeyCommandDefinition[] = [
  // Tools + shapes (no modifier)
  ..."petshrolan".split("").map((input) => ({ input })),
  // Modifier combos
  { input: "z", modifierFlags: CMD },
  { input: "z", modifierFlags: SHIFT_CMD },
  { input: "y", modifierFlags: CMD },
  { input: "a", modifierFlags: CMD },
  { input: "c", modifierFlags: CMD },
  { input: "v", modifierFlags: CMD },
  { input: "d", modifierFlags: CMD },
  { input: "]", modifierFlags: CMD },
  { input: "[", modifierFlags: CMD },
  { input: "0", modifierFlags: CMD },
  { input: "=", modifierFlags: CMD },
  { input: "-", modifierFlags: CMD },
  { input: "1", modifierFlags: SHIFT },
  { input: "0", modifierFlags: SHIFT },
  { input: "?", modifierFlags: SHIFT },
  // Special keys
  { input: `${constants.keyInputEscape}` },
];

function toChord(res: KeyCommandResponse): KeyChord {
  const flags = res.modifierFlags ?? 0;
  // The combined constants are bitwise unions (e.g. ShiftCommand === Shift|Command),
  // so bit tests recover each modifier independently.
  const meta = (flags & constants.keyModifierCommand) !== 0;
  const ctrl = (flags & constants.keyModifierControl) !== 0;
  const shift = (flags & constants.keyModifierShift) !== 0;
  const alt = (flags & constants.keyModifierOption) !== 0;
  let key = res.input;
  if (key === `${constants.keyInputEscape}`) key = "Escape";
  return { key, meta, ctrl, shift, alt };
}

export function registerHardwareKeys(onChord: (chord: KeyChord) => void): () => void {
  registerKeyCommands(COMMANDS);
  const sub = eventEmitter.addListener("onKeyCommand", (res) => {
    onChord(toChord(res));
  });
  return () => {
    sub.remove();
    unregisterKeyCommands(COMMANDS);
  };
}
