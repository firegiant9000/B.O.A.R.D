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
