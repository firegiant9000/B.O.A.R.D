/**
 * R-tree spatial index (Phase 8) for O(log n) marquee hit-testing across all
 * canvas element types. Built from each element's board-space bbox; rebuilt when
 * the visible element set changes and queried during a marquee drag. rbush's
 * default record shape (minX/minY/maxX/maxY) is reused directly, with `id`/`kind`
 * carried alongside so a hit maps back to the owning element/collection.
 */

import RBush from "rbush";
import { Bounds } from "./viewport";

export type ElementKind = "path" | "shape" | "text" | "image";

export interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  kind: ElementKind;
}

export class ElementIndex extends RBush<IndexEntry> {}

export function entryFromBounds(id: string, kind: ElementKind, b: Bounds): IndexEntry {
  return { id, kind, minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
}

/** Bulk-load an index in one pass (cheaper than repeated insert()). */
export function buildElementIndex(entries: IndexEntry[]): ElementIndex {
  const tree = new ElementIndex();
  tree.load(entries);
  return tree;
}

/** All entries whose bbox intersects the query box (touching edges count). */
export function queryBounds(tree: ElementIndex, box: Bounds): IndexEntry[] {
  return tree.search({
    minX: box.minX,
    minY: box.minY,
    maxX: box.maxX,
    maxY: box.maxY,
  });
}
