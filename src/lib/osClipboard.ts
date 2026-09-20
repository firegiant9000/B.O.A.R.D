// OS-clipboard interop seam (Phase 11). Web implementation: a no-op, because the
// board screen reads the system clipboard through the DOM `paste` event (the only
// place `clipboardData` is exposed) and falls back to the in-app clipboard there.
// The `.native` sibling uses expo-clipboard so a hardware Cmd/Ctrl+V on iPad/
// Android can pull an image copied from another app.

export interface OsClipboardImage {
  /** A uri (data URI) the image pipeline can decode + downscale. */
  uri: string;
  width: number;
  height: number;
}

export async function getClipboardImage(): Promise<OsClipboardImage | null> {
  return null;
}

/** Month 6 — writes plain text to the OS clipboard (the flashcard CSV export's
 *  "get it out of the app" path, since there is no committed dependency here
 *  for writing a file to disk — see flashcardService.ts's own header on why
 *  `.apkg` is cut in favor of CSV). Web implementation uses the standard
 *  Clipboard API directly (no expo-clipboard on web); returns false rather
 *  than throwing when it's unavailable (an insecure context, an older
 *  browser, or a test/SSR environment with no `navigator`), so a caller can
 *  show its own fallback message instead of crashing. */
export async function setClipboardText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
