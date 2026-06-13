import type { KeyChord } from "./shortcuts";

/**
 * Subscribe to hardware-keyboard chords. This is the default (web) implementation:
 * a no-op, because the board screen already attaches DOM keydown/keyup listeners
 * directly on web (which also lets the native `paste` DOM event coexist). The
 * `.native` sibling wires react-native-key-command for Bluetooth keyboards on
 * iOS/Android. Returns an unsubscribe function.
 */
export function registerHardwareKeys(_onChord: (chord: KeyChord) => void): () => void {
  return () => {};
}
