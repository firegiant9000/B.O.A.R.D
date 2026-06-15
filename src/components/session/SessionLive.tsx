import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "../../types";

// Phase 4 in-session (active). Elapsed timer anchored to startedAt (falls back to
// scheduledAt for legacy active sessions with no startedAt), live participant list,
// and the creator's End Session control.
//
// Reactions / raise-hand are intentionally NOT here: they ride the Phase 6 cursor
// ephemeral side channel (cursorService), which isn't built yet. Wiring them in now
// would mean a throwaway transport; they land with Phase 6 (see month-4-phases.md
// Phase 4 scope note). The timer + participant list is the shippable in-session core.

interface Props {
  session: Session;
  participants: { uid: string; displayName: string; email: string }[];
  isCreator: boolean;
  onEnd: () => void;
  ending: boolean;
  onGoToBoard: () => void;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export default function SessionLive({
  session,
  participants,
  isCreator,
  onEnd,
  ending,
  onGoToBoard,
}: Props) {
  const anchor = (session.startedAt ?? session.scheduledAt).getTime();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.statusBadge}>
        <Ionicons name="radio-button-on" size={14} color="#16a34a" />
        <Text style={styles.statusText}>Live</Text>
      </View>

      <Text style={styles.title}>{session.title}</Text>

      {/* Elapsed timer */}
      <View style={styles.timerBox}>
        <Text style={styles.timerLabel}>Elapsed</Text>
        <Text style={styles.timer}>{formatElapsed(now - anchor)}</Text>
      </View>

      {session.agenda ? (
        <>
          <Text style={styles.sectionLabel}>Agenda</Text>
          <Text style={styles.agenda}>{session.agenda}</Text>
        </>
      ) : null}

      <Text style={styles.sectionLabel}>In this session ({participants.length})</Text>
      {participants.map((p) => (
        <View key={p.uid} style={styles.participantRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{p.displayName.charAt(0).toUpperCase()}</Text>
          </View>
          <Text style={styles.pName}>{p.displayName}</Text>
        </View>
      ))}

      <TouchableOpacity style={styles.boardBtn} onPress={onGoToBoard}>
        <Ionicons name="easel-outline" size={18} color="#2563eb" />
        <Text style={styles.boardText}>Open Board</Text>
      </TouchableOpacity>

      {isCreator && (
        <TouchableOpacity style={styles.endBtn} onPress={onEnd} disabled={ending}>
          {ending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="stop" size={18} color="#fff" />
              <Text style={styles.endText}>End Session</Text>
            </>
          )}
        </TouchableOpacity>
      )}
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
    backgroundColor: "#dcfce7",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 12,
  },
  statusText: { color: "#16a34a", fontWeight: "700", fontSize: 13 },
  title: { fontSize: 24, fontWeight: "700", color: "#111", marginBottom: 16 },
  timerBox: {
    backgroundColor: "#111827",
    borderRadius: 14,
    paddingVertical: 22,
    alignItems: "center",
    marginBottom: 8,
  },
  timerLabel: {
    color: "#9ca3af",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
  },
  timer: { color: "#fff", fontSize: 44, fontWeight: "700", fontVariant: ["tabular-nums"] },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  agenda: { fontSize: 15, color: "#374151", lineHeight: 22 },
  participantRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#16a34a",
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  pName: { fontSize: 15, fontWeight: "600", color: "#111827" },
  boardBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#2563eb",
    backgroundColor: "#eff6ff",
    borderRadius: 12,
    padding: 14,
    marginTop: 24,
  },
  boardText: { color: "#2563eb", fontSize: 16, fontWeight: "600" },
  endBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#ef4444",
    borderRadius: 12,
    padding: 15,
    marginTop: 12,
  },
  endText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
