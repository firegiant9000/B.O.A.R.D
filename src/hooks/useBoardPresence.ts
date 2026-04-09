import { useCallback, useEffect, useRef, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../config/firebase";
import { updatePresence, subscribeToPresence } from "../services/presenceService";

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 1000;   // ping every 60 s

export interface MemberWithPresence {
  uid: string;
  displayName: string;
  initials: string;
  isOnline: boolean;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/**
 * Provides real-time member presence for a board.
 *
 * - Fetches display names from `users/{uid}` once per memberUids change.
 * - Subscribes to `boards/{boardId}/presence` for live lastActive updates.
 * - Sends a heartbeat every 60 s to mark the current user as active.
 * - A member is "online" if their lastActive is within the last 5 minutes.
 */
export function useBoardPresence(
  boardId: string,
  memberUids: string[],
  currentUserId: string | undefined
): { members: MemberWithPresence[]; loading: boolean } {
  const [members, setMembers] = useState<MemberWithPresence[]>([]);
  const [loading, setLoading] = useState(true);

  // Refs hold latest data so callbacks never go stale between renders
  const presenceMapRef = useRef<Record<string, Date>>({});
  const profilesRef = useRef<Record<string, { displayName: string; initials: string }>>({});

  // Stable rebuild — only reads refs so no deps needed
  const rebuildMembers = useCallback(() => {
    const now = Date.now();
    const built = Object.entries(profilesRef.current).map(([uid, profile]) => {
      const lastActive = presenceMapRef.current[uid];
      const isOnline = !!lastActive && now - lastActive.getTime() < ONLINE_THRESHOLD_MS;
      return { uid, ...profile, isOnline };
    });
    // Online members first, then alphabetical within each group
    built.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
    setMembers(built);
  }, []);

  // ── 1. Fetch display-name profiles (once per memberUids change) ────────────
  const memberKey = memberUids.join(",");
  useEffect(() => {
    if (memberUids.length === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);

    const fetchProfiles = async () => {
      const profiles: Record<string, { displayName: string; initials: string }> = {};
      await Promise.all(
        memberUids.map(async (uid) => {
          const snap = await getDoc(doc(db, "users", uid));
          if (snap.exists()) {
            const data = snap.data();
            const name: string = data.displayName ?? data.email ?? "User";
            profiles[uid] = { displayName: name, initials: getInitials(name) };
          } else {
            profiles[uid] = { displayName: "Unknown", initials: "?" };
          }
        })
      );
      profilesRef.current = profiles;
      rebuildMembers();
      setLoading(false);
    };

    fetchProfiles();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberKey, rebuildMembers]);

  // ── 2. Real-time presence listener ────────────────────────────────────────
  useEffect(() => {
    if (!boardId) return;
    const unsubscribe = subscribeToPresence(boardId, (map) => {
      presenceMapRef.current = map;
      rebuildMembers();
    });
    return unsubscribe;
  }, [boardId, rebuildMembers]);

  // ── 3. Heartbeat — keep current user marked as active ─────────────────────
  useEffect(() => {
    if (!boardId || !currentUserId) return;
    // Ping immediately on mount, then every HEARTBEAT_INTERVAL_MS
    updatePresence(boardId, currentUserId);
    const interval = setInterval(() => {
      updatePresence(boardId, currentUserId);
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [boardId, currentUserId]);

  return { members, loading };
}
