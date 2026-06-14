import AsyncStorage from "@react-native-async-storage/async-storage";

// Phase 10 (dashboard). Pinned boards are a per-user, per-workspace client-side
// preference — no schema or rules change. We persist the pinned board ids in
// AsyncStorage keyed by (uid, workspaceId) so a user's pins are scoped to the
// workspace they belong to and don't leak across accounts on a shared device.

const key = (uid: string, workspaceId: string) => `@board/pinned:${uid}:${workspaceId}`;

export async function getPinnedBoardIds(uid: string, workspaceId: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(key(uid, workspaceId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function setPinnedBoardIds(
  uid: string,
  workspaceId: string,
  ids: string[]
): Promise<void> {
  try {
    await AsyncStorage.setItem(key(uid, workspaceId), JSON.stringify(ids));
  } catch {
    // Pinning is a cosmetic convenience; a failed persist is non-fatal.
  }
}
