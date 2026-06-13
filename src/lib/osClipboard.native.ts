import * as Clipboard from "expo-clipboard";
import type { OsClipboardImage } from "./osClipboard";

// Native OS-clipboard interop via expo-clipboard. Used by the board's paste path
// so a hardware Cmd/Ctrl+V can land an image copied from another app (e.g. a
// screenshot from Photos) as a first-class image element, mirroring the web
// `paste`-event handler. Best-effort: device-verify only.
export async function getClipboardImage(): Promise<OsClipboardImage | null> {
  try {
    if (!(await Clipboard.hasImageAsync())) return null;
    const img = await Clipboard.getImageAsync({ format: "png" });
    if (!img?.data) return null;
    return {
      uri: img.data, // data URI
      width: img.size?.width ?? 0,
      height: img.size?.height ?? 0,
    };
  } catch {
    return null;
  }
}
