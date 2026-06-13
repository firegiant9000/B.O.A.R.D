import { useCallback, useMemo, useState } from "react";

/**
 * Selection state slice (ROADMAP Appendix A.3). Kept out of the canvas component
 * so toolbar / comments / AI can read it independently.
 *
 * Phase 8 makes it the single source of truth for *all* element types — strokes,
 * shapes, and text — so group operations (move/delete/recolor/duplicate/z-order)
 * treat a mixed selection uniformly. Multi-select arrives via marquee
 * (`setMany`/`addMany`, anchor "region"), shift-click (`toggle`), and select-all
 * (`setMany`, anchor "elements"). The single-element `selectedId` convenience is
 * retained for the M1 callers that still special-case one selection.
 */

export type SelectionAnchor = "elements" | "region" | "lasso";

export interface SelectionController {
  selectedIds: Set<string>;
  /** Convenience for the single-element case; null when 0 or >1 selected. */
  selectedId: string | null;
  /** How many elements are selected. */
  count: number;
  anchor: SelectionAnchor;
  isSelected: (id: string) => boolean;
  /** Replace the selection with a single element. */
  select: (id: string, anchor?: SelectionAnchor) => void;
  /** Replace the selection with an explicit id set (marquee / select-all). */
  setMany: (ids: Iterable<string>, anchor?: SelectionAnchor) => void;
  /** Union the given ids into the selection (shift-marquee / additive). */
  addMany: (ids: Iterable<string>, anchor?: SelectionAnchor) => void;
  /** Add/remove one id without disturbing the rest (shift-click). */
  toggle: (id: string, anchor?: SelectionAnchor) => void;
  /** Drop a single id from the selection (e.g. after it is deleted). */
  remove: (id: string) => void;
  clear: () => void;
}

interface SelectionState {
  ids: Set<string>;
  anchor: SelectionAnchor;
}

export function useSelection(): SelectionController {
  const [state, setState] = useState<SelectionState>({
    ids: new Set(),
    anchor: "elements",
  });

  const select = useCallback((id: string, anchor: SelectionAnchor = "elements") => {
    setState({ ids: new Set([id]), anchor });
  }, []);

  const setMany = useCallback((ids: Iterable<string>, anchor: SelectionAnchor = "region") => {
    setState({ ids: new Set(ids), anchor });
  }, []);

  const addMany = useCallback((ids: Iterable<string>, anchor: SelectionAnchor = "region") => {
    setState((prev) => {
      const next = new Set(prev.ids);
      for (const id of ids) next.add(id);
      return { ids: next, anchor };
    });
  }, []);

  const toggle = useCallback((id: string, anchor: SelectionAnchor = "elements") => {
    setState((prev) => {
      const ids = new Set(prev.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ids, anchor };
    });
  }, []);

  const remove = useCallback((id: string) => {
    setState((prev) => {
      if (!prev.ids.has(id)) return prev;
      const ids = new Set(prev.ids);
      ids.delete(id);
      return { ids, anchor: prev.anchor };
    });
  }, []);

  const clear = useCallback(() => {
    setState((prev) => (prev.ids.size === 0 ? prev : { ids: new Set(), anchor: prev.anchor }));
  }, []);

  const isSelected = useCallback((id: string) => state.ids.has(id), [state.ids]);

  const selectedId = useMemo(
    () => (state.ids.size === 1 ? [...state.ids][0] : null),
    [state.ids]
  );

  return {
    selectedIds: state.ids,
    selectedId,
    count: state.ids.size,
    anchor: state.anchor,
    isSelected,
    select,
    setMany,
    addMany,
    toggle,
    remove,
    clear,
  };
}
