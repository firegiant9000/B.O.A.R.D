import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../src/hooks/useAuth";
import { AppNotification } from "../src/types";
import {
  subscribeToNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../src/services/notificationService";

// Phase 10 — the in-app notifications inbox. Subscribes to the signed-in user's
// `users/{uid}/notifications` collection and lists @-mention notifications
// newest-first. Tapping a row marks it read and deep-links to the board the mention
// lives on (the same destination as a tapped push, see addMentionTapListener).

function relativeTime(date: Date): string {
  const ms = date.getTime();
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return date.toLocaleDateString();
}

function initial(name: string): string {
  return (name || "U").charAt(0).toUpperCase();
}

export default function NotificationsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setItems([]);
      setLoading(false);
      return;
    }
    const unsub = subscribeToNotifications(user.uid, (next) => {
      setItems(next);
      setLoading(false);
    });
    return unsub;
  }, [user?.uid]);

  const handleOpen = useCallback(
    (n: AppNotification) => {
      if (user && !n.read) markNotificationRead(user.uid, n.id).catch(() => {});
      if (n.boardId) router.push(`/board/${n.boardId}`);
    },
    [user, router]
  );

  const handleMarkAll = useCallback(() => {
    if (user) markAllNotificationsRead(user.uid).catch(() => {});
  }, [user]);

  const hasUnread = items.some((n) => !n.read);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Notifications",
          headerShown: true,
          headerRight: () =>
            hasUnread ? (
              <TouchableOpacity onPress={handleMarkAll} hitSlop={8} style={{ marginRight: 12 }}>
                <Text style={styles.markAll}>Mark all read</Text>
              </TouchableOpacity>
            ) : null,
        }}
      />

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#2563eb" />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(n) => n.id}
          contentContainerStyle={items.length === 0 ? styles.centered : styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="notifications-off-outline" size={56} color="#cbd5e1" />
              <Text style={styles.emptyTitle}>No notifications</Text>
              <Text style={styles.emptySubtitle}>
                You'll see @-mentions from comments here.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.row, !item.read && styles.rowUnread]}
              onPress={() => handleOpen(item)}
              activeOpacity={0.7}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initial(item.actorName)}</Text>
              </View>
              <View style={styles.body}>
                <Text style={styles.line}>
                  <Text style={styles.actor}>{item.actorName}</Text>
                  <Text style={styles.verb}> mentioned you on </Text>
                  <Text style={styles.boardTitle}>{item.boardTitle}</Text>
                </Text>
                {!!item.snippet && (
                  <Text style={styles.snippet} numberOfLines={2}>
                    {item.snippet}
                  </Text>
                )}
                <Text style={styles.time}>{relativeTime(item.createdAt)}</Text>
              </View>
              {!item.read && <View style={styles.unreadDot} />}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  centered: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  list: { paddingVertical: 8 },
  markAll: { color: "#2563eb", fontSize: 14, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f1f5f9",
  },
  rowUnread: { backgroundColor: "#eff6ff" },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  avatarText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  body: { flex: 1 },
  line: { fontSize: 14, color: "#374151", lineHeight: 19 },
  actor: { fontWeight: "700", color: "#111827" },
  verb: { color: "#374151" },
  boardTitle: { fontWeight: "600", color: "#111827" },
  snippet: { fontSize: 13, color: "#6b7280", marginTop: 3 },
  time: { fontSize: 11, color: "#9ca3af", marginTop: 4 },
  unreadDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: "#2563eb",
    marginLeft: 8,
    marginTop: 6,
  },
  empty: { alignItems: "center", gap: 6, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: "#9ca3af", marginTop: 12 },
  emptySubtitle: { fontSize: 13, color: "#cbd5e1", textAlign: "center" },
});
