/**
 * Share-sheet intake (Month 2, Phase 4 — roadmap item 6).
 *
 * Decides what B.O.A.R.D should do with content shared INTO it from another app
 * (iOS Share Extension / Android SEND intent) or with a link opened via the
 * deep-link contract. The routing logic here is platform-agnostic and unit-tested;
 * the OS-specific receive bridge is wired in `_layout.tsx` / native config.
 *
 * INBOUND LINKS (fully wired): a shared/opened link routes through the deep-link
 * contract and is handled by expo-router — the custom `boardapp://` scheme plus,
 * once the associated domain is provisioned, the `https://<domain>/b/<code>`
 * Universal/App Link (native association declared in app.json). `handleSharedItem`
 * maps link/text payloads to the matching navigation outcome.
 *
 * INBOUND IMAGES: the OS receiver is `expo-share-intent` (Android `SEND` reader +
 * a generated iOS Share Extension, configured by its plugin in app.json and
 * consumed in `app/_layout.tsx`). It hands the shared file(s) to the `/share`
 * board-picker, which downscales each via `imagePicker.prepareNativeImageUri` and
 * calls `placeSharedItem` to upload + create the `image` element through the Phase 9
 * pipeline — the same path the in-app picker and web paste use. The receiver only
 * runs in an EAS build (not Expo Go / web), so it is verified on-device.
 */

import { parseDeepLink } from "./deepLinks";
import { placementBox, PreparedImage } from "./images";
import { Point } from "./viewport";
import { uploadImage } from "../services/imageService";

export type SharedItem =
  | { kind: "link"; url: string }
  | { kind: "text"; text: string }
  | { kind: "image"; uri: string; mimeType?: string }
  | { kind: "file"; uri: string; mimeType?: string; name?: string };

export type ShareOutcome =
  | { action: "open-board"; boardId: string; sessionId?: string }
  | { action: "join-invite"; inviteCode: string }
  | { action: "place-image"; uri: string }
  | { action: "place-file"; uri: string; name?: string }
  | { action: "unsupported"; reason: string };

const URL_IN_TEXT = /\bhttps?:\/\/\S+|\bboardapp:\/\/\S+/i;

/**
 * Map a raw OS share payload to a typed `SharedItem`. `mimeType` follows the
 * Android SEND convention (`image/*`, `application/pdf`, `text/plain`); iOS UTIs
 * are normalized to the same buckets by the native bridge before calling in.
 */
export function classifyShare(payload: {
  mimeType?: string;
  uri?: string;
  text?: string;
  name?: string;
}): SharedItem | null {
  const { mimeType, uri, text, name } = payload;

  if (mimeType?.startsWith("image/") && uri) {
    return { kind: "image", uri, mimeType };
  }
  if (uri && mimeType && !mimeType.startsWith("text/")) {
    return { kind: "file", uri, mimeType, name };
  }
  if (text && URL_IN_TEXT.test(text)) {
    const match = text.match(URL_IN_TEXT);
    return { kind: "link", url: match ? match[0] : text };
  }
  if (text) {
    return { kind: "text", text };
  }
  if (uri) {
    return { kind: "file", uri, mimeType, name };
  }
  return null;
}

/**
 * Decide the in-app action for a shared item. Pure — no navigation or I/O — so the
 * caller owns side effects and this stays unit-testable.
 */
export function handleSharedItem(item: SharedItem): ShareOutcome {
  switch (item.kind) {
    case "link":
    case "text": {
      const raw = item.kind === "link" ? item.url : item.text;
      const parsed = parseDeepLink(raw);
      if (parsed.type === "board") {
        return { action: "open-board", boardId: parsed.boardId, sessionId: parsed.sessionId };
      }
      if (parsed.type === "invite") {
        return { action: "join-invite", inviteCode: parsed.inviteCode };
      }
      return {
        action: "unsupported",
        reason: "Shared text isn't a B.O.A.R.D link. Pasting plain text as a note arrives in a later phase.",
      };
    }
    case "image":
      return { action: "place-image", uri: item.uri };
    case "file":
      return { action: "place-file", uri: item.uri, name: item.name };
  }
}

/**
 * Place a shared image onto a board. Uploads the (already downscaled) image via
 * the Phase 9 `imageService` pipeline and creates an `image` element aspect-fitted
 * and centered on `center` (board-space) — identical to the in-app picker / web
 * paste path. The caller is responsible for turning the OS share payload into a
 * `PreparedImage` first (native-module work; see this module's header), keeping
 * this function free of native imports and unit-testable.
 *
 * Returns the new image id on success; `placed: false` with a reason on failure,
 * so the caller can surface an honest message instead of dropping the share.
 */
export async function placeSharedItem(
  boardId: string,
  userId: string,
  prepared: PreparedImage,
  center: Point
): Promise<{ placed: boolean; imageId?: string; reason?: string }> {
  try {
    const box = placementBox(prepared.naturalWidth, prepared.naturalHeight, center);
    const imageId = await uploadImage(boardId, userId, prepared, {
      ...box,
      alt: prepared.alt,
    });
    return { placed: true, imageId };
  } catch (e) {
    return { placed: false, reason: String(e) };
  }
}
