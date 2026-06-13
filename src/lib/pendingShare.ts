/**
 * Module-level holder for an inbound OS share (Month 2, Phase 4 — share intake).
 *
 * The native receive bridge (`expo-share-intent`, consumed in `app/_layout.tsx`)
 * fires from outside the navigation tree and before any board is open, so it can't
 * hand the payload directly to a screen. It stashes the shared image(s) here and
 * routes to the `/share` board-picker, which drains them onto the chosen board via
 * the Phase 9 image pipeline (`prepareNativeImageUri` → `placeSharedItem`).
 *
 * Survives navigation (module scope); links/text are handled inline and never land
 * here — only media that needs a destination board does.
 */

/** A shared image as handed over by the native receiver: a local file uri plus
 *  its pixel dimensions (for aspect-preserving placement). */
export interface PendingImage {
  uri: string;
  width: number;
  height: number;
  name: string;
}

let pending: PendingImage[] = [];

export function setPendingShare(images: PendingImage[]): void {
  pending = images;
}

/** Returns the pending images and clears the holder (single-consumer semantics). */
export function takePendingShare(): PendingImage[] {
  const out = pending;
  pending = [];
  return out;
}

export function hasPendingShare(): boolean {
  return pending.length > 0;
}
