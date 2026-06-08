import { useCallback, useMemo, useState } from "react";

/**
 * Selection state slice (ROADMAP Appendix A.3). Kept out of the canvas component
 * so toolbar / comments / AI can read it independently. M1 is single-element
 * tap-select; the Set + anchor shape is already what M2 marquee/lasso need.
 */

export type SelectionAnchor = "elements" | "region" | "lasso";

export interface SelectionController {
  selectedIds: Set<string>;
  /** Convenience for the single-element M1 case; null when 0 or >1 selected. */
  selectedId: string | null;
  anchor: SelectionAnchor;
  isSelected: (id: string) => boolean;
  /** Replace the selection with a single element. */
  select: (id: string, anchor?: SelectionAnchor) => void;
  /** Add/remove one id without disturbing the rest (M2 shift-click). */
  toggle: (id: string, anchor?: SelectionAnchor) => void;
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

  const toggle = useCallback((id: string, anchor: SelectionAnchor = "elements") => {
    setState((prev) => {
      const ids = new Set(prev.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ids, anchor };
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
    anchor: state.anchor,
    isSelected,
    select,
    toggle,
    clear,
  };
}
