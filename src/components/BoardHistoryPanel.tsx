import React, { useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ActivityEvent } from "../types";
import { subscribeToBoardActivity } from "../services/activityService";
import ActivityFeed from "./ActivityFeed";

/**
 * Phase 8. Per-board activity history sidebar. A bottom-sheet (mirroring
 * CommentThreadPanel / ShareBoardModal styling) that subscribes to the board's
 * slice of the workspace activity log and renders it newest-first via ActivityFeed.
 * Subscription is scoped to the sheet's visibility so a closed board stops watching.
 *
 * Legacy/unscoped boards (no workspaceId) have nothing to query — the sheet shows
 * the empty state rather than erroring, matching the activityService no-op contract.
 */

interface BoardHistoryPanelProps {
  visible: boolean;
  workspaceId: string;
  boardId: string;
  onClose: () => void;
}

export default function BoardHistoryPanel({
  visible,
  workspaceId,
  boardId,
  onClose,
}: BoardHistoryPanelProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!visible || !workspaceId || !boardId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsub = subscribeToBoardActivity(workspaceId, boardId, (next) => {
      setEvents(next);
      setLoading(false);
    });
    return unsub;
  }, [visible, workspaceId, boardId]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.iconWrap}>
              <Ionicons name="time-outline" size={20} color="#2563eb" />
            </View>
            <Text style={styles.title}>Board history</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color="#666" />
            </TouchableOpacity>
          </View>

          <ActivityFeed
            events={events}
            loading={loading}
            emptyText="No activity on this board yet."
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: Platform.OS === "ios" ? 40 : 24,
    maxHeight: "80%",
  },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 16 },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  title: { flex: 1, fontSize: 18, fontWeight: "700", color: "#111" },
  closeBtn: { padding: 2 },
});
