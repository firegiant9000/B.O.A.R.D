// react-native-key-command ships no TypeScript types (plain JS). This ambient
// declaration covers only the surface Phase 11 uses. See README for the full API.
declare module "react-native-key-command" {
  export interface KeyCommandResponse {
    input: string;
    modifierFlags?: number;
  }
  export interface KeyCommandDefinition {
    input: string | number;
    modifierFlags?: number;
  }

  /** Predefined modifier-flag + special-key enum (values vary on Android). */
  export const constants: {
    keyInputDownArrow: number;
    keyInputEscape: number;
    keyInputLeftArrow: number;
    keyInputRightArrow: number;
    keyInputUpArrow: number;
    keyModifierCapsLock: number;
    keyModifierCommand: number;
    keyModifierControl: number;
    keyModifierControlCommand: number;
    keyModifierControlOption: number;
    keyModifierControlOptionCommand: number;
    keyModifierNumericPad: number;
    keyModifierOption: number;
    keyModifierOptionCommand: number;
    keyModifierShift: number;
    keyModifierShiftCommand: number;
  };

  export interface KeyCommandEmitter {
    addListener(
      event: "onKeyCommand",
      listener: (response: KeyCommandResponse, event?: unknown) => void
    ): { remove: () => void };
  }
  export const eventEmitter: KeyCommandEmitter;

  export function registerKeyCommands(commands: KeyCommandDefinition[]): void;
  export function unregisterKeyCommands(commands: KeyCommandDefinition[]): void;
  export function addListener(
    command: KeyCommandDefinition,
    callback: (response: KeyCommandResponse, event?: unknown) => void
  ): () => void;
}
