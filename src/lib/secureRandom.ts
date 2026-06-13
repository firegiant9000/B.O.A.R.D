import * as Crypto from "expo-crypto";
import { captureMessage } from "./errorReporting";

/**
 * Cross-platform random-code generation (Month 2, Phase 1 — secrets hygiene).
 *
 * Random bytes come from a cryptographically-secure source on every platform:
 *   - Web / Node / Jest: the Web Crypto API (`crypto.getRandomValues`), used
 *     directly when present so tests and the browser need no native module.
 *   - React Native (Hermes): `expo-crypto.getRandomBytes`, since Hermes has no
 *     global Web Crypto.
 *
 * A `Math.random` fallback remains only as a last resort if both are somehow
 * unavailable (misconfigured runtime); it reports once so the regression is
 * visible rather than silent. Invite/join codes are low-stakes identifiers, so
 * degrading beats crashing.
 */

let reportedFallback = false;

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);

  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
    return bytes;
  }

  try {
    return Crypto.getRandomBytes(length);
  } catch (err) {
    if (!reportedFallback) {
      reportedFallback = true;
      captureMessage(
        "secureRandom: no secure RNG available, using Math.random fallback",
        { error: String(err) }
      );
    }
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytes;
  }
}

/**
 * Returns a `length`-char code drawn uniformly from `alphabet`. Uses rejection
 * sampling to avoid the modulo bias that `byte % alphabet.length` would introduce
 * when 256 is not a multiple of the alphabet size.
 */
export function randomCode(length: number, alphabet: string): string {
  const n = alphabet.length;
  if (n < 2 || n > 256) {
    throw new Error(`randomCode: alphabet size must be 2-256, got ${n}`);
  }
  // Largest multiple of n that fits in a byte; reject bytes >= this to stay uniform.
  const limit = Math.floor(256 / n) * n;
  let out = "";
  while (out.length < length) {
    const bytes = getRandomBytes(length - out.length);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < limit) {
        out += alphabet[bytes[i] % n];
      }
    }
  }
  return out;
}
