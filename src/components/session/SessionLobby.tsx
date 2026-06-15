import React from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Session, Board } from "../../types";

// Phase 4 lobby (pre-session). Shows who's joining, a board preview, the editable
// agenda (creator only), the invite code, and the Start affordance for the creator.

interface Props {
  session: Session;
  board: Board | null;
  participants: { uid: string; displayName: string; email: string }[];
  isCreator: boolean;
  agenda: string;
  onAgendaChange: (text: string) => void;
  onSaveAgenda: () => void;
  savingAgenda: boolean;
  agendaDirty: boolean;
  onStart: () => void;
  starting: boolean;
  onCopyCode: () => void;
  onGoToBoard: () => void;
}

export default function SessionLobby({
  session,
  board,
  participants,
  isCreator,
  agenda,
  onAgendaChange,
  onSaveAgenda,
  savingAgenda,
  agendaDirty,
  onStart,
  starting,
  onCopyCode,
  onGoToBoard,
}: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.statusBadge}>
        <Ionicons name="time-outline" size={14} color="#2563eb" />
        <Text style={styles.statusText}>Lobby · Not started</Text>
      </View>

      <Text style={styles.title}>{session.title}</Text>
      <Text style={styles.subtitle}>
        {session.scheduledAt.toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </Text>

      {/* Board preview */}
      {board && (
        <View style={styles.previewCard}>
          {session.canvasSnapshot ? (
            <Image source={{ uri: session.canvasSnapshot }} style={styles.preview} resizeMode="cover" />
          ) : (
            <View style={[styles.preview, styles.previewEmpty]}>
              <Ionicons name="easel-outline" size={28} color="#9ca3af" />
              <Text style={styles.previewEmptyText}>{board.title}</Text>
            </View>
          )}
        </View>
      )}

      {/* Agenda */}
      <Text style={styles.sectionLabel}>Agenda</Text>
      {isCreator ? (
        <>
          <TextInput
            style={styles.agendaInput}
            value={agenda}
            onChangeText={onAgendaChange}
            placeholder="What's the plan for this session?"
            placeholderTextColor="#9ca3af"
            multiline
          />
          {agendaDirty && (
            <TouchableOpacity style={styles.saveAgendaBtn} onPress={onSaveAgenda} disabled={savingAgenda}>
              {savingAgenda ? (
                <ActivityIndicator size="small" color="#2563eb" />
              ) : (
                <Text style={styles.saveAgendaText}>Save agenda</Text>
              )}
            </TouchableOpacity>
          )}
        </>
      ) : (
        <Text style={styles.agendaRead}>{agenda || "No agenda yet."}</Text>
      )}

      {/* Who's joining */}
      <Text style={styles.sectionLabel}>Who's joining ({participants.length})</Text>
      {participants.map((p) => (
        <View key={p.uid} style={styles.participantRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{p.displayName.charAt(0).toUpperCase()}</Text>
          </View>
          <View>
            <Text style={styles.pName}>{p.displayName}</Text>
            {!!p.email && <Text style={styles.pEmail}>{p.email}</Text>}
          </View>
        </View>
      ))}

      {/* Invite code */}
      {isCreator && session.joinCode && (
        <View style={styles.codeSection}>
          <Text style={styles.sectionLabel}>Invite Code</Text>
          <TouchableOpacity style={styles.codeRow} onPress={onCopyCode}>
            <Text style={styles.codeText}>{session.joinCode}</Text>
            <Ionicons name="copy-outline" size={18} color="#2563eb" />
          </TouchableOpacity>
        </View>
      )}

      {/* Actions */}
      {isCreator && (
        <TouchableOpacity style={styles.startBtn} onPress={onStart} disabled={starting}>
          {starting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="play" size={18} color="#fff" />
              <Text style={styles.startText}>Start Session</Text>
            </>
          )}
        </TouchableOpacity>
      )}
      <TouchableOpacity style={styles.secondaryBtn} onPress={onGoToBoard}>
        <Ionicons name="easel-outline" size={18} color="#2563eb" />
        <Text style={styles.secondaryText}>Open Board</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 4 },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    backgroundColor: "#eff6ff",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 12,
  },
  statusText: { color: "#2563eb", fontWeight: "600", fontSize: 13 },
  title: { fontSize: 24, fontWeight: "700", color: "#111" },
  subtitle: { fontSize: 14, color: "#6b7280", marginBottom: 16 },
  previewCard: { borderRadius: 12, overflow: "hidden", marginBottom: 8 },
  preview: { width: "100%", height: 160, backgroundColor: "#f3f4f6" },
  previewEmpty: { justifyContent: "center", alignItems: "center", gap: 6 },
  previewEmptyText: { color: "#9ca3af", fontSize: 13, fontWeight: "500" },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  agendaInput: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: "#111",
    backgroundColor: "#f9fafb",
    minHeight: 72,
    textAlignVertical: "top",
  },
  agendaRead: { fontSize: 15, color: "#374151", lineHeight: 22 },
  saveAgendaBtn: { alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 4, marginTop: 6 },
  saveAgendaText: { color: "#2563eb", fontWeight: "600", fontSize: 14 },
  participantRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: { color: "#fff", fontWeight: "700" },
  pName: { fontSize: 15, fontWeight: "600", color: "#111827" },
  pEmail: { fontSize: 12, color: "#9ca3af" },
  codeSection: { marginTop: 4 },
  codeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#eff6ff",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignSelf: "flex-start",
  },
  codeText: { fontSize: 20, fontWeight: "700", color: "#111", letterSpacing: 2 },
  startBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#16a34a",
    borderRadius: 12,
    padding: 15,
    marginTop: 24,
  },
  startText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#2563eb",
    backgroundColor: "#eff6ff",
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  secondaryText: { color: "#2563eb", fontSize: 16, fontWeight: "600" },
});
