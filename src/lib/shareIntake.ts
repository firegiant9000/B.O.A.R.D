/**
 * Share-sheet intake (Month 2, Phase 4 — roadmap item 6).
 *
 * Decides what B.O.A.R.D should do with content shared INTO it from another app
 * (iOS Share Extension / Android SEND intent) or with a link opened via the
 * deep-link contract. The routing logic here is platform-agnostic and unit-tested;
 * the OS-specific receive bridge is wired in `_layout.tsx` / native config.
 *
 * NATIVE BOUNDARY: `expo-sharing` / `expo-intent-launcher` are OUTBOUND APIs.
 * Receiving a shared *file* requires a native target — an iOS Share Extension and
 * the Android SEND `intentFilters` declared in app.json. Those only run in an EAS
 * build (not Expo Go / web), so the file paths below are exercised on-device only.
 * Shared *links* arrive through the ordinary deep-link path and are fully handled.
 *
 * PHASE 9 BOUNDARY: placing a shared image/PDF as a first-class canvas element
 * needs the `image` element type + `imageService` upload pipeline from Phase 9,
 * which does not exist yet. Until then `handleSharedItem` returns a `place-*`
 * outcome that the caller surfaces as "coming soon"; the wiring is ready so Phase 9
 * only has to fill in the upload + element-create step (see `placeSharedItem`).
 */

import { parseDeepLink } from "./deepLinks";

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
 * Placement seam for shared media. Phase 9 fills this in: upload `uri` via
 * `imageService`, then create an `image` element on `boardId`. Today it signals
 * that the pipeline isn't ready so the UI can show an honest message instead of
 * silently dropping the share.
 */
export async function placeSharedItem(
  _boardId: string,
  _item: Extract<SharedItem, { kind: "image" | "file" }>
): Promise<{ placed: boolean; reason?: string }> {
  return {
    placed: false,
    reason: "Image & file placement ships with Phase 9 (image elements).",
  };
}
