import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BoardPresence, FriendRequest } from "../types";
import * as friendService from "../services/friendService";
import * as sessionService from "../services/sessionService";
import * as notificationService from "../services/notificationService";
import { showAlert } from "../utils/alerts";

interface StartSessionModalProps {
  visible: boolean;
  boardId: string;
  // Phase 4: the board's workspace, stamped onto the session so it inherits tenancy.
  workspaceId: string;
  boardTitle: string;
  adminId: string;
  adminName: string;
  presenceUsers: BoardPresence[];
  onClose: () => void;
  onSessionCreated: (sessionId: string) => void;
}

interface SelectableUser {
  userId: string;
  displayName: string;
  email: string;
}

export default function StartSessionModal({
  visible,
  boardId,
  workspaceId,
  boardTitle,
  adminId,
  adminName,
  presenceUsers,
  onClose,
  onSessionCreated,
}: StartSessionModalProps) {
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState("60");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [candidates, setCandidates] = useState<SelectableUser[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Build participant candidates from presence users + friends whenever modal opens
  useEffect(() => {
    if (!visible) return;
    setTitle("");
    setDuration("60");
    setSelectedIds(new Set());
    loadCandidates();
  }, [visible]);

  const loadCandidates = async () => {
    setLoadingCandidates(true);
    try {
      const friendRequests = await friendService.getFriends(adminId);

      const userMap = new Map<string, SelectableUser>();

      // Add presence users (exclude admin)
      presenceUsers
        .filter((p) => p.userId !== adminId)
        .forEach((p) =>
          userMap.set(p.userId, {
            userId: p.userId,
            displayName: p.displayName,
            email: p.email,
          })
        );

      // Add friends not already covered by presence
      friendRequests.forEach((req) => {
        const isAdminSender = req.fromId === adminId;
        const friendId = isAdminSender ? req.toId : req.fromId;
        const friendName = isAdminSender ? req.toDisplayName : req.fromDisplayName;
        const friendEmail = isAdminSender ? req.toEmail : req.fromEmail;
        if (friendId !== adminId && friendId && !userMap.has(friendId)) {
          userMap.set(friendId, {
            userId: friendId,
            displayName: friendName || "Unknown",
            email: friendEmail || "",
          });
        }
      });

      setCandidates(Array.from(userMap.values()));
    } catch {
      setCandidates([]);
    } finally {
      setLoadingCandidates(false);
    }
  };

  const toggleParticipant = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!title.trim()) {
      showAlert("Missing Title", "Please enter a session title.");
      return;
    }

    const durationNum = parseInt(duration, 10);
    if (isNaN(durationNum) || durationNum <= 0) {
      showAlert("Invalid Duration", "Please enter a valid duration in minutes.");
      return;
    }

    setSubmitting(true);
    try {
      const participantIds = Array.from(selectedIds);

      const sessionId = await sessionService.createSession({
        boardId,
        workspaceId,
        boardTitle,
        title: title.trim(),
        description: "",
        scheduledAt: new Date(),
        durationMinutes: durationNum,
        createdById: adminId,
        createdByName: adminName,
        participantIds,
        status: "active",
      });

      // Send push notifications to participants who have tokens
      if (participantIds.length > 0) {
        const tokens = await sessionService.getParticipantPushTokens(participantIds);
        await notificationService.sendSessionPushNotifications(
          tokens,
          title.trim(),
          boardTitle,
          adminName,
          { sessionId, boardId }
        );
      }

      onSessionCreated(sessionId);
      onClose();
      showAlert(
        "Session Started",
        participantIds.length > 0
          ? `Session created and ${participantIds.length} participant(s) have been notified.`
          : "Session created. No participants were notified."
      );
    } catch {
      showAlert("Error", "Failed to create session. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Start Session</Text>
          <TouchableOpacity
            style={[styles.createBtn, submitting && styles.createBtnDisabled]}
            onPress={handleCreate}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.createText}>Create</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Board context label */}
          <View style={styles.boardBadge}>
            <Ionicons name="easel-outline" size={14} color="#2563eb" />
            <Text style={styles.boardBadgeText} numberOfLines={1}>
              {boardTitle}
            </Text>
          </View>

          {/* Session title */}
          <Text style={styles.fieldLabel}>Session Title</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Weekly Design Review"
            value={title}
            onChangeText={setTitle}
            maxLength={80}
            returnKeyType="next"
          />

          {/* Duration */}
          <Text style={styles.fieldLabel}>Estimated Duration</Text>
          <View style={styles.durationRow}>
            <TextInput
              style={[styles.input, styles.durationInput]}
              placeholder="60"
              value={duration}
              onChangeText={setDuration}
              keyboardType="number-pad"
              maxLength={4}
            />
            <Text style={styles.durationUnit}>minutes</Text>
          </View>

          {/* Quick-pick duration chips */}
          <View style={styles.durationChips}>
            {[15, 30, 60, 90, 120].map((d) => (
              <TouchableOpacity
                key={d}
                style={[
                  styles.chip,
                  duration === String(d) && styles.chipActive,
                ]}
                onPress={() => setDuration(String(d))}
              >
                <Text
                  style={[
                    styles.chipText,
                    duration === String(d) && styles.chipTextActive,
                  ]}
                >
                  {d < 60 ? `${d}m` : `${d / 60}h`}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Participants */}
          <View style={styles.participantsHeader}>
            <Text style={styles.fieldLabel}>Invite Participants</Text>
            {selectedIds.size > 0 && (
              <Text style={styles.selectedCount}>{selectedIds.size} selected</Text>
            )}
          </View>
          <Text style={styles.participantsHint}>
            Select from users on this board and your friends. They'll receive a push notification.
          </Text>

          {loadingCandidates ? (
            <ActivityIndicator color="#2563eb" style={styles.candidatesSpinner} />
          ) : candidates.length === 0 ? (
            <View style={styles.noCandidates}>
              <Ionicons name="people-outline" size={32} color="#d1d5db" />
              <Text style={styles.noCandidatesText}>
                No friends or board users to invite yet
              </Text>
            </View>
          ) : (
            <View style={styles.candidatesList}>
              {candidates.map((u) => {
                const selected = selectedIds.has(u.userId);
                const onBoard = presenceUsers.some((p) => p.userId === u.userId);
                return (
                  <TouchableOpacity
                    key={u.userId}
                    style={[styles.candidateRow, selected && styles.candidateRowSelected]}
                    onPress={() => toggleParticipant(u.userId)}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.candidateAvatar, selected && styles.candidateAvatarSelected]}>
                      <Text style={styles.candidateAvatarText}>
                        {u.displayName.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.candidateInfo}>
                      <Text style={styles.candidateName}>{u.displayName}</Text>
                      <View style={styles.candidateMeta}>
                        {onBoard && (
                          <View style={styles.onBoardBadge}>
                            <Text style={styles.onBoardBadgeText}>On board</Text>
                          </View>
                        )}
                        <Text style={styles.candidateEmail} numberOfLines={1}>
                          {u.email}
                        </Text>
                      </View>
                    </View>
                    <View
                      style={[
                        styles.checkbox,
                        selected && styles.checkboxSelected,
                      ]}
                    >
                      {selected && (
                        <Ionicons name="checkmark" size={14} color="#fff" />
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Notification note */}
          <View style={styles.noticeBox}>
            <Ionicons name="notifications-outline" size={16} color="#6b7280" />
            <Text style={styles.noticeText}>
              Selected participants will receive a push notification on their device when you tap
              Create.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#fff",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "ios" ? 16 : 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  cancelBtn: {
    paddingVertical: 4,
    paddingHorizontal: 2,
    minWidth: 60,
  },
  cancelText: {
    color: "#6b7280",
    fontSize: 16,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
  },
  createBtn: {
    backgroundColor: "#2563eb",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 10,
    minWidth: 72,
    alignItems: "center",
  },
  createBtnDisabled: {
    opacity: 0.6,
  },
  createText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  boardBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#eff6ff",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignSelf: "flex-start",
    marginBottom: 20,
  },
  boardBadgeText: {
    color: "#2563eb",
    fontSize: 13,
    fontWeight: "600",
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: "#f9fafb",
    marginBottom: 16,
  },
  durationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  durationInput: {
    flex: 1,
    marginBottom: 0,
  },
  durationUnit: {
    fontSize: 15,
    color: "#6b7280",
    fontWeight: "500",
  },
  durationChips: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 24,
  },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "#d1d5db",
    backgroundColor: "#f9fafb",
  },
  chipActive: {
    borderColor: "#2563eb",
    backgroundColor: "#eff6ff",
  },
  chipText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6b7280",
  },
  chipTextActive: {
    color: "#2563eb",
  },
  participantsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  selectedCount: {
    fontSize: 13,
    color: "#2563eb",
    fontWeight: "600",
  },
  participantsHint: {
    fontSize: 13,
    color: "#9ca3af",
    marginBottom: 14,
    lineHeight: 18,
  },
  candidatesSpinner: {
    marginVertical: 24,
  },
  noCandidates: {
    alignItems: "center",
    paddingVertical: 24,
    gap: 8,
  },
  noCandidatesText: {
    fontSize: 14,
    color: "#9ca3af",
    textAlign: "center",
  },
  candidatesList: {
    gap: 8,
    marginBottom: 20,
  },
  candidateRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    backgroundColor: "#fff",
  },
  candidateRowSelected: {
    borderColor: "#2563eb",
    backgroundColor: "#eff6ff",
  },
  candidateAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#9ca3af",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  candidateAvatarSelected: {
    backgroundColor: "#2563eb",
  },
  candidateAvatarText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  candidateInfo: {
    flex: 1,
  },
  candidateName: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111827",
    marginBottom: 2,
  },
  candidateMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  onBoardBadge: {
    backgroundColor: "#d1fae5",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  onBoardBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#059669",
  },
  candidateEmail: {
    fontSize: 12,
    color: "#9ca3af",
    flex: 1,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#d1d5db",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  checkboxSelected: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  noticeBox: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    alignItems: "flex-start",
  },
  noticeText: {
    flex: 1,
    fontSize: 13,
    color: "#6b7280",
    lineHeight: 18,
  },
});
