import React, { createContext, useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Workspace } from "../types";
import {
  getUserWorkspaces,
  ensurePersonalWorkspace,
} from "../services/workspaceService";
import { useAuth } from "../hooks/useAuth";

// Phase 3 (multi-tenancy). Tracks the user's workspaces and which one is active.
// The boards/sessions surfaces scope to `activeWorkspaceId`; until the user picks
// otherwise it defaults to the personal workspace (oldest, per getUserWorkspaces).
interface WorkspaceContextType {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  activeWorkspaceId: string | null;
  loading: boolean;
  setActiveWorkspace: (id: string) => void;
  /** Re-fetch the workspace list (after create/invite/role changes). */
  refreshWorkspaces: () => Promise<void>;
}

export const WorkspaceContext = createContext<WorkspaceContextType | undefined>(
  undefined
);

// Active-workspace selection is persisted per-uid so a returning user lands back
// in the workspace they were last using rather than always the personal one.
const activeKey = (uid: string) => `@board/activeWorkspace:${uid}`;

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) {
      setWorkspaces([]);
      setActiveWorkspaceId(null);
      setLoading(false);
      return;
    }
    try {
      let list = await getUserWorkspaces(user.uid);
      // New user whose signup auto-create lagged/failed: repair lazily so the
      // app is never workspace-less (mirrors the Phase 2 bridge contract).
      if (list.length === 0) {
        await ensurePersonalWorkspace(user.uid);
        list = await getUserWorkspaces(user.uid);
      }
      setWorkspaces(list);

      const stored = await AsyncStorage.getItem(activeKey(user.uid));
      // A stored id can go stale (removed from that workspace) — fall back to the
      // personal workspace (first, oldest) when it's no longer in the list.
      const valid = stored && list.some((w) => w.id === stored);
      setActiveWorkspaceId(valid ? stored : list[0]?.id ?? null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const setActiveWorkspace = useCallback(
    (id: string) => {
      setActiveWorkspaceId(id);
      if (user) AsyncStorage.setItem(activeKey(user.uid), id).catch(() => {});
    },
    [user]
  );

  const refreshWorkspaces = useCallback(async () => {
    if (!user) return;
    const list = await getUserWorkspaces(user.uid);
    setWorkspaces(list);
    // Keep the active selection valid after a refresh (e.g. removed elsewhere).
    setActiveWorkspaceId((prev) =>
      prev && list.some((w) => w.id === prev) ? prev : list[0]?.id ?? null
    );
  }, [user]);

  const activeWorkspace =
    workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        activeWorkspace,
        activeWorkspaceId,
        loading,
        setActiveWorkspace,
        refreshWorkspaces,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}
