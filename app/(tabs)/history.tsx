import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/hooks/useAuth";
import { useWorkspace } from "../../src/hooks/useWorkspace";
import WorkspaceSwitcher from "../../src/components/WorkspaceSwitcher";
import SessionHistoryCard from "../../src/components/session/SessionHistoryCard";
import { Session } from "../../src/types";
import * as sessionService from "../../src/services/sessionService";

// Phase 5: "Past sessions" history tab. Lists the user's ended sessions, scoped to
// the active workspace, as vertical recap cards (snapshot, attendees, duration,
// summary). Paginated against getEndedSessions so the query cost stays bounded.

export default function HistoryScreen() {
  const { user } = useAuth();
  const { activeWorkspaceId } = useWorkspace();
  const router = useRouter();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFirstPage = useCallback(async () => {
    if (!user) return;
    try {
      const page = await sessionService.getEndedSessions(user.uid, {
        workspaceId: activeWorkspaceId ?? undefined,
      });
      setSessions(page.sessions);
      setHasMore(page.hasMore);
      setCursor(page.nextCursor);
      setError(null);
    } catch {
      setError("Failed to load session history. Pull down to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, activeWorkspaceId]);

  // Refetch on focus + whenever the active workspace changes.
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadFirstPage();
    }, [loadFirstPage])
  );

  const handleRefresh = () => {
    setRefreshing(true);
    loadFirstPage();
  };

  const handleLoadMore = async () => {
    if (!user || loadingMore || !hasMore || !cursor) return;
    setLoadingMore(true);
    try {
      const page = await sessionService.getEndedSessions(user.uid, {
        workspaceId: activeWorkspaceId ?? undefined,
        before: cursor,
      });
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...page.sessions.filter((s) => !seen.has(s.id))];
      });
      setHasMore(page.hasMore);
      setCursor(page.nextCursor);
    } catch {
      // A failed page-load shouldn't wipe what's already shown; surface the banner.
      setError("Failed to load more sessions.");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.screenHeader}>
        <WorkspaceSwitcher />
      </View>

      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={15} color="#b91c1c" />
          <Text style={styles.errorBannerText}>{error}</Text>
          <TouchableOpacity onPress={() => setError(null)}>
            <Ionicons name="close" size={15} color="#b91c1c" />
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#2563eb" />
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <SessionHistoryCard
              session={item}
              onPress={() => router.push(`/session/${item.id}`)}
            />
          )}
          contentContainerStyle={sessions.length === 0 ? styles.centered : styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator size="small" color="#2563eb" style={styles.footer} />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="albums-outline" size={52} color="#d1d5db" />
              <Text style={styles.emptyTitle}>No past sessions</Text>
              <Text style={styles.emptySubtitle}>
                Sessions you run will appear here once they end — with their summary,
                attendees, and a board snapshot.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f9fafb" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  list: { padding: 16 },
  footer: { marginVertical: 16 },
  screenHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 8,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fef2f2",
    borderBottomWidth: 1,
    borderBottomColor: "#fecaca",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorBannerText: { flex: 1, fontSize: 13, color: "#b91c1c" },
  emptyState: {
    alignItems: "center",
    paddingTop: 60,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#9ca3af",
    marginTop: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#d1d5db",
    textAlign: "center",
    lineHeight: 20,
  },
});
