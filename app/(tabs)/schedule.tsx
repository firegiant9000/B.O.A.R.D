import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/hooks/useAuth";
import { Session } from "../../src/types";
import * as sessionService from "../../src/services/sessionService";
import * as notificationService from "../../src/services/notificationService";
import * as aiService from "../../src/services/aiService";

type FilterTab = "upcoming" | "active" | "past";

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffHrs = diffMs / (1000 * 60 * 60);

  if (Math.abs(diffHrs) < 1) {
    const diffMins = Math.round(diffMs / (1000 * 60));
    if (diffMins > 0) return `In ${diffMins}m`;
    if (diffMins < 0) return `${Math.abs(diffMins)}m ago`;
    return "Now";
  }
  if (Math.abs(diffHrs) < 24) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function classifySession(session: Session): FilterTab {
  if (session.status === "active") return "active";
  if (session.status === "ended") return "past";
  // "scheduled" — use scheduledAt + duration to determine if it's past
  const endTime = new Date(session.scheduledAt.getTime() + session.durationMinutes * 60 * 1000);
  if (endTime < new Date()) return "past";
  return "upcoming";
}

const STATUS_CONFIG: Record<FilterTab, { label: string; color: string; bg: string; icon: keyof typeof Ionicons.glyphMap }> = {
  active:   { label: "Live",     color: "#16a34a", bg: "#dcfce7", icon: "radio-button-on" },
  upcoming: { label: "Upcoming", color: "#2563eb", bg: "#eff6ff", icon: "time-outline" },
  past:     { label: "Ended",    color: "#6b7280", bg: "#f3f4f6", icon: "checkmark-circle-outline" },
};

export default function ScheduleScreen() {
  const { user, userProfile } = useAuth();
  const router = useRouter();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>("active");
  const [generatingId, setGeneratingId] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!user) return;
    try {
      const data = await sessionService.getSessionsForUser(user.uid);
      setSessions(data);
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchSessions();
  };

  const handleMarkEnded = (sessionId: string) => {
    Alert.alert("End Session", "Mark this session as ended?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "End Session",
        style: "destructive",
        onPress: async () => {
          try {
            await sessionService.updateSessionStatus(sessionId, "ended");
            setSessions((prev) =>
              prev.map((s) => (s.id === sessionId ? { ...s, status: "ended" } : s))
            );
          } catch {
            Alert.alert("Error", "Failed to update session.");
          }
        },
      },
    ]);
  };

  const handleResendNotification = async (session: Session) => {
    if (session.participantIds.length === 0) {
      Alert.alert("No Participants", "This session has no participants to notify.");
      return;
    }
    try {
      const tokens = await sessionService.getParticipantPushTokens(session.participantIds);
      await notificationService.sendSessionPushNotifications(
        tokens,
        session.title,
        session.boardTitle,
        userProfile?.displayName ?? "Admin"
      );
      Alert.alert("Sent", `Notification resent to ${session.participantIds.length} participant(s).`);
    } catch {
      Alert.alert("Error", "Failed to resend notification.");
    }
  };

  const handleGenerateSummary = async (session: Session) => {
    if (!aiService.getOpenAIKey()) {
      Alert.alert(
        "API Key Required",
        "To generate AI summaries, add your OpenAI API key in the Profile tab under Settings.",
      );
      return;
    }

    setGeneratingId(session.id);
    try {
      const summary = await aiService.generateSessionSummary(session.boardId, {
        sessionTitle: session.title,
        boardTitle: session.boardTitle,
        durationMinutes: session.durationMinutes,
        participantCount: session.participantIds.length + 1,
      });
      await sessionService.updateSessionSummary(session.id, summary);
      setSessions((prev) =>
        prev.map((s) => (s.id === session.id ? { ...s, summary } : s))
      );
      Alert.alert("Summary Generated", summary);
    } catch (error: any) {
      Alert.alert("Summary Failed", error.message ?? "Failed to generate summary.");
    } finally {
      setGeneratingId(null);
    }
  };

  const filtered = sessions.filter((s) => classifySession(s) === activeTab);

  const counts: Record<FilterTab, number> = {
    active: sessions.filter((s) => classifySession(s) === "active").length,
    upcoming: sessions.filter((s) => classifySession(s) === "upcoming").length,
    past: sessions.filter((s) => classifySession(s) === "past").length,
  };

  const isCreator = (session: Session) => session.createdById === user?.uid;

  const renderSession = ({ item }: { item: Session }) => {
    const tab = classifySession(item);
    const cfg = STATUS_CONFIG[tab];

    return (
      <View style={styles.card}>
        {/* Status row */}
        <View style={styles.cardTop}>
          <View style={[styles.statusBadge, { backgroundColor: cfg.bg }]}>
            <Ionicons name={cfg.icon} size={12} color={cfg.color} />
            <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
          <Text style={styles.cardTime}>{formatDate(item.scheduledAt)}</Text>
        </View>

        {/* Title */}
        <Text style={styles.cardTitle}>{item.title}</Text>

        {/* Board & meta */}
        <View style={styles.cardMeta}>
          <View style={styles.cardMetaItem}>
            <Ionicons name="easel-outline" size={13} color="#6b7280" />
            <Text style={styles.cardMetaText} numberOfLines={1}>{item.boardTitle}</Text>
          </View>
          <View style={styles.cardMetaItem}>
            <Ionicons name="time-outline" size={13} color="#6b7280" />
            <Text style={styles.cardMetaText}>{formatDuration(item.durationMinutes)}</Text>
          </View>
          <View style={styles.cardMetaItem}>
            <Ionicons name="people-outline" size={13} color="#6b7280" />
            <Text style={styles.cardMetaText}>{item.participantIds.length} invited</Text>
          </View>
        </View>

        {/* Creator line */}
        <Text style={styles.cardCreator}>
          {isCreator(item) ? "You started this session" : `Started by ${item.createdByName}`}
        </Text>

        {/* AI Summary (for ended sessions) */}
        {tab === "past" && item.summary && (
          <View style={styles.summaryBox}>
            <View style={styles.summaryHeader}>
              <Ionicons name="sparkles" size={14} color="#7c3aed" />
              <Text style={styles.summaryLabel}>AI Summary</Text>
            </View>
            <Text style={styles.summaryText}>{item.summary}</Text>
          </View>
        )}

        {/* Admin actions */}
        {isCreator(item) && (
          <View style={styles.cardActions}>
            {tab !== "past" && (
              <>
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => handleResendNotification(item)}
                >
                  <Ionicons name="notifications-outline" size={14} color="#2563eb" />
                  <Text style={styles.actionBtnText}>Resend Notification</Text>
                </TouchableOpacity>
                {tab === "active" && (
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.actionBtnDanger]}
                    onPress={() => handleMarkEnded(item.id)}
                  >
                    <Ionicons name="stop-circle-outline" size={14} color="#ef4444" />
                    <Text style={[styles.actionBtnText, { color: "#ef4444" }]}>End Session</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
            {tab === "past" && !item.summary && (
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionBtnAI]}
                onPress={() => handleGenerateSummary(item)}
                disabled={generatingId === item.id}
              >
                {generatingId === item.id ? (
                  <ActivityIndicator size="small" color="#7c3aed" />
                ) : (
                  <>
                    <Ionicons name="sparkles" size={14} color="#7c3aed" />
                    <Text style={[styles.actionBtnText, { color: "#7c3aed" }]}>
                      Generate AI Summary
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}
            {tab === "past" && item.summary && (
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionBtnAI]}
                onPress={() => handleGenerateSummary(item)}
                disabled={generatingId === item.id}
              >
                {generatingId === item.id ? (
                  <ActivityIndicator size="small" color="#7c3aed" />
                ) : (
                  <>
                    <Ionicons name="refresh-outline" size={14} color="#7c3aed" />
                    <Text style={[styles.actionBtnText, { color: "#7c3aed" }]}>
                      Regenerate
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Join board button */}
        <TouchableOpacity
          style={styles.joinBtn}
          onPress={() => router.push(`/board/${item.boardId}`)}
        >
          <Ionicons name="arrow-forward" size={15} color="#2563eb" />
          <Text style={styles.joinBtnText}>Open Board</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Filter tabs */}
      <View style={styles.tabs}>
        {(["active", "upcoming", "past"] as FilterTab[]).map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </Text>
            {counts[tab] > 0 && (
              <View style={[styles.tabBadge, activeTab === tab && styles.tabBadgeActive]}>
                <Text style={[styles.tabBadgeText, activeTab === tab && styles.tabBadgeTextActive]}>
                  {counts[tab]}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#2563eb" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderSession}
          contentContainerStyle={
            filtered.length === 0 ? styles.centered : styles.list
          }
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons
                name={activeTab === "active" ? "radio-button-off-outline" : "calendar-outline"}
                size={52}
                color="#d1d5db"
              />
              <Text style={styles.emptyTitle}>
                {activeTab === "active"
                  ? "No active sessions"
                  : activeTab === "upcoming"
                  ? "No upcoming sessions"
                  : "No past sessions"}
              </Text>
              <Text style={styles.emptySubtitle}>
                {activeTab === "active"
                  ? "Admins can start a session from any board"
                  : "Sessions you create or are invited to will appear here"}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f9fafb",
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  // ── Tabs ──
  tabs: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 4,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: "#2563eb",
  },
  tabText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#9ca3af",
  },
  tabTextActive: {
    color: "#2563eb",
  },
  tabBadge: {
    backgroundColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 20,
    alignItems: "center",
  },
  tabBadgeActive: {
    backgroundColor: "#dbeafe",
  },
  tabBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#6b7280",
  },
  tabBadgeTextActive: {
    color: "#2563eb",
  },
  // ── List ──
  list: {
    padding: 16,
    gap: 12,
  },
  // ── Card ──
  card: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
    marginBottom: 12,
  },
  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "700",
  },
  cardTime: {
    fontSize: 12,
    color: "#9ca3af",
    fontWeight: "500",
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 10,
  },
  cardMeta: {
    flexDirection: "row",
    gap: 12,
    flexWrap: "wrap",
    marginBottom: 6,
  },
  cardMetaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  cardMetaText: {
    fontSize: 13,
    color: "#6b7280",
  },
  cardCreator: {
    fontSize: 12,
    color: "#9ca3af",
    marginBottom: 12,
    fontStyle: "italic",
  },
  cardActions: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderColor: "#bfdbfe",
    backgroundColor: "#eff6ff",
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  actionBtnDanger: {
    borderColor: "#fecaca",
    backgroundColor: "#fff1f2",
  },
  actionBtnAI: {
    borderColor: "#ddd6fe",
    backgroundColor: "#f5f3ff",
  },
  actionBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#2563eb",
  },
  joinBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: "#f3f4f6",
    paddingTop: 12,
  },
  joinBtnText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#2563eb",
  },
  // ── Summary ──
  summaryBox: {
    backgroundColor: "#f5f3ff",
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#ddd6fe",
  },
  summaryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 6,
  },
  summaryLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#7c3aed",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  summaryText: {
    fontSize: 14,
    color: "#374151",
    lineHeight: 20,
  },
  // ── Empty state ──
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
