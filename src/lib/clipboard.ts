/**
 * In-app clipboard store (Phase 10, roadmap item 9).
 *
 * A module-level singleton so a copied selection survives navigating from one
 * board to another in the same app session — that is what "copy/paste across
 * boards in the same workspace" means here (each board screen remounts, so
 * component state can't carry the payload). The store holds kind-tagged element
 * payloads with their identity stripped (id / createdAt / boardId / userId /
 * bbox); paste re-stamps the destination board + the pasting user and the
 * services recompute bbox.
 *
 * Geometry math (`offsetClipItem`, the cascading `nextPasteOffset`) lives here,
 * side-effect-free, so it unit-tests without React/Firestore. The system
 * clipboard (external image paste on web) is handled in the board screen via the
 * DOM `paste` event; OS-clipboard interop on native is deferred to Phase 11 with
 * the rest of the hardware-keyboard work.
 */

import { DrawPath, ShapeElement, TextElement, ImageElement } from "../types";
import { DUPLICATE_OFFSET, translatePoints } from "./transform";

type Stripped = "id" | "createdAt" | "boardId" | "userId" | "bbox";

export type ClipItem =
  | { kind: "path"; data: Omit<DrawPath, "id" | "createdAt" | "boardId" | "userId"> }
  | { kind: "shape"; data: Omit<ShapeElement, Stripped> }
  | { kind: "text"; data: Omit<TextElement, "id" | "createdAt" | "boardId" | "userId"> }
  | { kind: "image"; data: Omit<ImageElement, Stripped> };

interface ClipboardState {
  items: ClipItem[];
  // How many times the current payload has been pasted — drives the cascading
  // down-right offset so repeated Cmd/Ctrl+V doesn't stack copies on top of
  // each other. Reset to 0 on every fresh copy.
  pasteCount: number;
}

let state: ClipboardState = { items: [], pasteCount: 0 };

/** Replace the clipboard with a new payload (a fresh copy resets the cascade). */
export function setClipboard(items: ClipItem[]): void {
  state = { items, pasteCount: 0 };
}

export function getClipboard(): ClipItem[] {
  return state.items;
}

export function hasClipboard(): boolean {
  return state.items.length > 0;
}

export function clearClipboard(): void {
  state = { items: [], pasteCount: 0 };
}

/**
 * Advance the paste cascade and return the board-space offset for this paste:
 * the first paste lands `step` down-right, the next `2*step`, and so on, so a
 * run of pastes fans out instead of overlapping.
 */
export function nextPasteOffset(step: number = DUPLICATE_OFFSET): number {
  state.pasteCount += 1;
  return state.pasteCount * step;
}

/** Translate a clip item's geometry by `d` board units down-right (pure). */
export function offsetClipItem(item: ClipItem, d: number): ClipItem {
  switch (item.kind) {
    case "path":
      return { kind: "path", data: { ...item.data, points: translatePoints(item.data.points, d, d) } };
    case "shape":
      return { kind: "shape", data: { ...item.data, x: item.data.x + d, y: item.data.y + d } };
    case "image":
      return { kind: "image", data: { ...item.data, x: item.data.x + d, y: item.data.y + d } };
    case "text":
      return {
        kind: "text",
        data: { ...item.data, position: { x: item.data.position.x + d, y: item.data.position.y + d } },
      };
  }
}
