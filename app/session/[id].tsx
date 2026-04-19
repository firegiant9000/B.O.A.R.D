import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  Clipboard,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/hooks/useAuth";
import { Session, Board } from "../../src/types";
import * as sessionService from "../../src/services/sessionService";
import * as boardService from "../../src/services/boardService";
import { getUsersByIds } from "../../src/services/friendService";

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();

  const [session, setSession] = useState<Session | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [participants, setParticipants] = useState<{ uid: string; displayName: string; email: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    loadSession();
  }, [id]);

  const loadSession = async () => {
    try {
      const s = await sessionService.getSession(id!);
      setSession(s);
      if (s) {
        const [b, participantProfiles] = await Promise.all([
          boardService.getBoard(s.boardId),
          getUsersByIds(s.participantIds),
        ]);
        setBoard(b);
        setParticipants(participantProfiles);
      }
    } catch {
      Alert.alert("Error", "Failed to load session");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      "Delete Session",
      `Delete "${session?.title}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await sessionService.deleteSession(id!);
              router.back();
            } catch {
              Alert.alert("Error", "Failed to delete session");
            }
          },
        },
      ]
    );
  };

  const isPast = session ? session.scheduledAt < new Date() : false;

  const formatDuration = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Session not found</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.link}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#333" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          Session Details
        </Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView style={styles.content}>
        {/* Status badge */}
        {isPast && (
          <View style={styles.completedBadge}>
            <Ionicons name="checkmark-circle" size={16} color="#059669" />
            <Text style={styles.completedText}>Completed</Text>
          </View>
        )}

        {/* Title */}
        <Text style={styles.title}>{session.title}</Text>

        {/* Info rows */}
        <View style={styles.infoSection}>
          <View style={styles.infoRow}>
            <Ionicons name="calendar-outline" size={20} color="#6b7280" />
            <Text style={styles.infoText}>
              {session.scheduledAt.toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="time-outline" size={20} color="#6b7280" />
            <Text style={styles.infoText}>
              {session.scheduledAt.toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}{" "}
              — {formatDuration(session.durationMinutes)}
            </Text>
          </View>
          {board && (
            <View style={styles.infoRow}>
              <Ionicons name="easel-outline" size={20} color="#6b7280" />
              <Text style={styles.infoText}>{board.title}</Text>
            </View>
          )}
          <View style={styles.infoRow}>
            <Ionicons name="people-outline" size={20} color="#6b7280" />
            <Text style={styles.infoText}>
              {session.participantIds.length} participant
              {session.participantIds.length !== 1 ? "s" : ""}
            </Text>
          </View>
        </View>

        {/* Join Code — shown to creator so they can share it */}
        {session.createdById === user?.uid && session.joinCode && (
          <View style={styles.joinCodeSection}>
            <Text style={styles.sectionLabel}>Invite Code</Text>
            <View style={styles.joinCodeRow}>
              <Text style={styles.joinCodeText}>{session.joinCode}</Text>
              <TouchableOpacity
                style={styles.copyBtn}
                onPress={() => {
                  Clipboard.setString(session.joinCode!);
                  Alert.alert("Copied", "Invite code copied to clipboard.");
                }}
              >
                <Ionicons name="copy-outline" size={18} color="#2563eb" />
                <Text style={styles.copyBtnText}>Copy</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.joinCodeHint}>
              Share this code so others can join the session.
            </Text>
          </View>
        )}

        {/* Description */}
        {session.description ? (
          <View style={styles.descriptionSection}>
            <Text style={styles.sectionLabel}>Description</Text>
            <Text style={styles.descriptionText}>{session.description}</Text>
          </View>
        ) : null}

        {/* Participants */}
        {participants.length > 0 && (
          <View style={styles.participantsSection}>
            <Text style={styles.sectionLabel}>
              Participants ({participants.length})
            </Text>
            {participants.map((p) => (
              <View key={p.uid} style={styles.participantRow}>
                <View style={styles.participantAvatar}>
                  <Text style={styles.participantAvatarText}>
                    {p.displayName.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View>
                  <Text style={styles.participantName}>{p.displayName}</Text>
                  <Text style={styles.participantEmail}>{p.email}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Actions */}
        <View style={styles.actions}>
          {board && (
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => router.push(`/board/${session.boardId}`)}
            >
              <Ionicons name="easel-outline" size={20} color="#2563eb" />
              <Text style={styles.actionBtnText}>Go to Board</Text>
            </TouchableOpacity>
          )}
          {session.createdById === user?.uid && (
            <>
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() =>
                  router.push(`/session/create?sessionId=${session.id}`)
                }
              >
                <Ionicons name="create-outline" size={20} color="#2563eb" />
                <Text style={styles.actionBtnText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.deleteBtn]}
                onPress={handleDelete}
              >
                <Ionicons name="trash-outline" size={20} color="#ef4444" />
                <Text style={styles.deleteBtnText}>Delete</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>
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
    backgroundColor: "#fff",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  backBtn: {
    padding: 4,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    textAlign: "center",
  },
  content: {
    flex: 1,
    padding: 20,
  },
  completedBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ecfdf5",
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 6,
    marginBottom: 16,
  },
  completedText: {
    color: "#059669",
    fontWeight: "600",
    fontSize: 13,
  },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: "#111",
    marginBottom: 20,
  },
  infoSection: {
    gap: 14,
    marginBottom: 24,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  infoText: {
    fontSize: 16,
    color: "#374151",
  },
  descriptionSection: {
    marginBottom: 24,
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#6b7280",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  descriptionText: {
    fontSize: 16,
    color: "#374151",
    lineHeight: 24,
  },
  participantsSection: {
    marginBottom: 24,
  },
  participantRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
    gap: 12,
  },
  participantAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
  },
  participantAvatarText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  participantName: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111827",
  },
  participantEmail: {
    fontSize: 12,
    color: "#9ca3af",
  },
  actions: {
    gap: 12,
    marginTop: 8,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2563eb",
    backgroundColor: "#eff6ff",
  },
  actionBtnText: {
    color: "#2563eb",
    fontSize: 16,
    fontWeight: "600",
  },
  deleteBtn: {
    borderColor: "#fecaca",
    backgroundColor: "#fef2f2",
  },
  deleteBtnText: {
    color: "#ef4444",
    fontSize: 16,
    fontWeight: "600",
  },
  errorText: {
    fontSize: 16,
    color: "#6b7280",
    marginBottom: 12,
  },
  link: {
    fontSize: 16,
    color: "#2563eb",
    fontWeight: "600",
  },
  joinCodeSection: {
    marginBottom: 24,
  },
  joinCodeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  joinCodeText: {
    fontSize: 22,
    fontWeight: "700",
    color: "#111",
    letterSpacing: 2,
    fontVariant: ["tabular-nums"],
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2563eb",
    backgroundColor: "#eff6ff",
  },
  copyBtnText: {
    color: "#2563eb",
    fontSize: 14,
    fontWeight: "600",
  },
  joinCodeHint: {
    fontSize: 12,
    color: "#9ca3af",
    marginTop: 6,
  },
});
