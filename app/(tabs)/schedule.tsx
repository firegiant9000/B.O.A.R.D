import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  SectionList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/hooks/useAuth";
import { Session, Board } from "../../src/types";
import * as sessionService from "../../src/services/sessionService";
import * as boardService from "../../src/services/boardService";
import SessionCard from "../../src/components/SessionCard";

interface SectionData {
  title: string;
  data: Session[];
}

function getDateLabel(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (target.getTime() === today.getTime()) return "Today";
  if (target.getTime() === tomorrow.getTime()) return "Tomorrow";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function groupSessionsByDate(sessions: Session[]): SectionData[] {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const label = getDateLabel(session.scheduledAt);
    const existing = groups.get(label);
    if (existing) {
      existing.push(session);
    } else {
      groups.set(label, [session]);
    }
  }
  return Array.from(groups.entries()).map(([title, data]) => ({ title, data }));
}

export default function ScheduleScreen() {
  const { user } = useAuth();
  const router = useRouter();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [boardMap, setBoardMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showUpcomingOnly, setShowUpcomingOnly] = useState(true);

  const fetchSessions = useCallback(async () => {
    if (!user) return;
    try {
      const [allSessions, boards] = await Promise.all([
        sessionService.getUserSessions(user.uid),
        boardService.getUserBoards(user.uid),
      ]);
      setSessions(allSessions);

      const map = new Map<string, string>();
      for (const b of boards) {
        map.set(b.id, b.title);
      }
      setBoardMap(map);
    } catch (error: any) {
      Alert.alert("Error", error.message ?? "Failed to load sessions.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  // Refetch on screen focus
  useFocusEffect(
    useCallback(() => {
      fetchSessions();
    }, [fetchSessions])
  );

  const handleRefresh = () => {
    setRefreshing(true);
    fetchSessions();
  };

  const handleDelete = (sessionId: string, title: string) => {
    Alert.alert("Delete Session", `Delete "${title}"? This cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await sessionService.deleteSession(sessionId);
            setSessions((prev) => prev.filter((s) => s.id !== sessionId));
          } catch {
            Alert.alert("Error", "Failed to delete session.");
          }
        },
      },
    ]);
  };

  const filteredSessions = showUpcomingOnly
    ? sessions.filter((s) => s.scheduledAt >= new Date())
    : sessions;

  const sections = groupSessionsByDate(filteredSessions);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Toggle */}
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.toggleBtn, showUpcomingOnly && styles.toggleBtnActive]}
          onPress={() => setShowUpcomingOnly(true)}
        >
          <Text
            style={[
              styles.toggleText,
              showUpcomingOnly && styles.toggleTextActive,
            ]}
          >
            Upcoming
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.toggleBtn,
            !showUpcomingOnly && styles.toggleBtnActive,
          ]}
          onPress={() => setShowUpcomingOnly(false)}
        >
          <Text
            style={[
              styles.toggleText,
              !showUpcomingOnly && styles.toggleTextActive,
            ]}
          >
            All
          </Text>
        </TouchableOpacity>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            boardTitle={boardMap.get(item.boardId)}
            onPress={() => router.push(`/session/${item.id}`)}
            onDelete={() => handleDelete(item.id, item.title)}
          />
        )}
        contentContainerStyle={
          sections.length === 0 ? styles.centered : styles.list
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="calendar-outline" size={64} color="#ccc" />
            <Text style={styles.emptyTitle}>No sessions scheduled</Text>
            <Text style={styles.emptySubtitle}>
              Tap the + button to schedule your first session
            </Text>
          </View>
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      />

      <TouchableOpacity
        style={styles.fab}
        onPress={() => router.push("/session/create")}
        activeOpacity={0.8}
      >
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  toggleRow: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    backgroundColor: "#f3f4f6",
    borderRadius: 10,
    padding: 3,
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  toggleBtnActive: {
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  toggleText: {
    fontSize: 14,
    fontWeight: "500",
    color: "#6b7280",
  },
  toggleTextActive: {
    color: "#111",
    fontWeight: "600",
  },
  list: {
    paddingTop: 8,
    paddingBottom: 80,
  },
  sectionHeader: {
    fontSize: 14,
    fontWeight: "700",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    backgroundColor: "#fff",
  },
  emptyState: {
    alignItems: "center",
    paddingTop: 48,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: "#888",
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#aaa",
    marginTop: 4,
  },
  fab: {
    position: "absolute",
    right: 24,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
});
