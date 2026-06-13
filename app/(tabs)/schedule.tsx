import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  RefreshControl,
  Modal,
  TextInput,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/hooks/useAuth";
import { Session } from "../../src/types";
import * as sessionService from "../../src/services/sessionService";
import * as notificationService from "../../src/services/notificationService";
import * as aiService from "../../src/services/aiService";
import { showAlert, confirmAlert } from "../../src/utils/alerts";

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
  const diffMins = Math.round(diffMs / (1000 * 60));
  const diffHrs = diffMs / (1000 * 60 * 60);

  if (Math.abs(diffHrs) < 1) {
    if (diffMins > 0) return `In ${diffMins}m`;
    if (diffMins < 0) return `${Math.abs(diffMins)}m ago`;
    return "Now";
  }

  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (Math.abs(diffHrs) < 48) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (date.toDateString() === now.toDateString()) return `Today ${timeStr}`;
    if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow ${timeStr}`;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${timeStr}`;
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
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);

  const fetchSessions = useCallback(async () => {
    if (!user) return;
    try {
      const data = await sessionService.getSessionsForUser(user.uid);
      setSessions(data);
      setFetchError(null);
    } catch {
      setFetchError("Failed to load sessions. Pull down to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      fetchSessions();
    }, [fetchSessions])
  );

  const handleRefresh = () => {
    setRefreshing(true);
    fetchSessions();
  };

  const handleStartSession = (session: Session) => {
    confirmAlert({
      title: "Start Session",
      message: `Mark "${session.title}" as active now?`,
      confirmText: "Start",
      onConfirm: async () => {
        try {
          await sessionService.updateSessionStatus(session.id, "active");
          setSessions((prev) =>
            prev.map((s) => (s.id === session.id ? { ...s, status: "active" } : s))
          );
          if (session.participantIds.length > 0) {
            const tokens = await sessionService.getParticipantPushTokens(session.participantIds);
            await notificationService.sendSessionPushNotifications(
              tokens,
              session.title,
              session.boardTitle,
              userProfile?.displayName ?? "Admin",
              { sessionId: session.id, boardId: session.boardId }
            );
          }
        } catch {
          showAlert("Error", "Failed to start session.");
        }
      },
    });
  };

  const handleMarkEnded = (sessionId: string) => {
    confirmAlert({
      title: "End Session",
      message: "Mark this session as ended?",
      confirmText: "End Session",
      destructive: true,
      onConfirm: async () => {
        try {
          await sessionService.updateSessionStatus(sessionId, "ended");
          setSessions((prev) =>
            prev.map((s) => (s.id === sessionId ? { ...s, status: "ended" } : s))
          );
        } catch {
          showAlert("Error", "Failed to update session.");
        }
      },
    });
  };

  const handleResendNotification = async (session: Session) => {
    if (session.participantIds.length === 0) {
      showAlert("No Participants", "This session has no participants to notify.");
      return;
    }
    try {
      const tokens = await sessionService.getParticipantPushTokens(session.participantIds);
      await notificationService.sendSessionPushNotifications(
        tokens,
        session.title,
        session.boardTitle,
        userProfile?.displayName ?? "Admin",
        { sessionId: session.id, boardId: session.boardId }
      );
      showAlert("Sent", `Notification resent to ${session.participantIds.length} participant(s).`);
    } catch {
      showAlert("Error", "Failed to resend notification.");
    }
  };

  const handleGenerateSummary = async (session: Session) => {
    if (!aiService.getOpenAIKey()) {
      showAlert(
        "API Key Required",
        "To generate AI summaries, add your OpenAI API key in the Profile tab under Settings.",
      );
      return;
    }

    setGeneratingId(session.id);
    console.log(
      "[generate-summary] session=",
      session.id,
      "hasSnapshot=",
      !!session.canvasSnapshot,
      session.canvasSnapshot
        ? `(${Math.round(session.canvasSnapshot.length / 1024)}KB)`
        : ""
    );
    try {
      const summary = await aiService.generateSessionSummary(
        session.boardId,
        {
          sessionTitle: session.title,
          boardTitle: session.boardTitle,
          durationMinutes: session.durationMinutes,
          participantCount: session.participantIds.length + 1,
        },
        session.canvasSnapshot
      );
      await sessionService.updateSessionSummary(session.id, summary);
      setSessions((prev) =>
        prev.map((s) => (s.id === session.id ? { ...s, summary } : s))
      );
    } catch (error: any) {
      showAlert("Summary Failed", error.message ?? "Failed to generate summary.");
    } finally {
      setGeneratingId(null);
    }
  };

  const handleJoinByCode = async () => {
    if (!user || !joinCode.trim()) return;
    setJoining(true);
    try {
      const result = await sessionService.joinSessionByCode(joinCode.trim(), user.uid);
      if (!result) {
        showAlert("Not Found", "No session found with that code. Check the code and try again.");
        return;
      }
      setJoinModalVisible(false);
      setJoinCode("");
      if (result.alreadyJoined) {
        router.push(`/session/${result.sessionId}`);
      } else {
        await fetchSessions();
        router.push(`/session/${result.sessionId}`);
      }
    } catch {
      showAlert("Error", "Failed to join session. Please try again.");
    } finally {
      setJoining(false);
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
                {tab === "upcoming" && (
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.actionBtnStart]}
                    onPress={() => handleStartSession(item)}
                  >
                    <Ionicons name="play-circle-outline" size={14} color="#16a34a" />
                    <Text style={[styles.actionBtnText, { color: "#16a34a" }]}>Start Session</Text>
                  </TouchableOpacity>
                )}
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
      {/* Screen header */}
      <View style={styles.screenHeader}>
        <Text style={styles.screenTitle}>Schedule</Text>
        <TouchableOpacity
          style={styles.joinCodeBtn}
          onPress={() => setJoinModalVisible(true)}
        >
          <Ionicons name="enter-outline" size={16} color="#2563eb" />
          <Text style={styles.joinCodeBtnText}>Join by Code</Text>
        </TouchableOpacity>
      </View>

      {/* Join by Code modal */}
      <Modal
        visible={joinModalVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setJoinModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Join a Session</Text>
            <Text style={styles.modalSubtitle}>
              Enter the invite code shared by the session creator.
            </Text>
            <TextInput
              style={styles.codeInput}
              value={joinCode}
              onChangeText={(t) => setJoinCode(t.toUpperCase())}
              placeholder="SESS-XXXXXX"
              placeholderTextColor="#9ca3af"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={11}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => { setJoinModalVisible(false); setJoinCode(""); }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalJoinBtn, (!joinCode.trim() || joining) && styles.modalJoinBtnDisabled]}
                onPress={handleJoinByCode}
                disabled={!joinCode.trim() || joining}
              >
                {joining ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalJoinText}>Join</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

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

      {fetchError && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={15} color="#b91c1c" />
          <Text style={styles.errorBannerText}>{fetchError}</Text>
          <TouchableOpacity onPress={() => setFetchError(null)}>
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
  actionBtnStart: {
    borderColor: "#bbf7d0",
    backgroundColor: "#f0fdf4",
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
  // ── Error banner ──
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
  errorBannerText: {
    flex: 1,
    fontSize: 13,
    color: "#b91c1c",
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
  // ── Screen header ──
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
  screenTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#111827",
  },
  joinCodeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2563eb",
    backgroundColor: "#eff6ff",
  },
  joinCodeBtnText: {
    color: "#2563eb",
    fontSize: 14,
    fontWeight: "600",
  },
  // ── Join modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 24,
    width: "100%",
    gap: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  modalSubtitle: {
    fontSize: 14,
    color: "#6b7280",
    lineHeight: 20,
  },
  codeInput: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    padding: 14,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 3,
    color: "#111",
    textAlign: "center",
    backgroundColor: "#f9fafb",
  },
  modalActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 4,
  },
  modalCancelBtn: {
    flex: 1,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    alignItems: "center",
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#6b7280",
  },
  modalJoinBtn: {
    flex: 1,
    padding: 14,
    borderRadius: 10,
    backgroundColor: "#2563eb",
    alignItems: "center",
  },
  modalJoinBtnDisabled: {
    opacity: 0.5,
  },
  modalJoinText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#fff",
  },
});
