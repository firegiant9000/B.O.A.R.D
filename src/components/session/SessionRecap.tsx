import React from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "../../types";
import SummaryCard from "../SummaryCard";
import { recapDurationMinutes } from "../../utils/recapExport";

// Phase 4 post-session recap (ended). The structured summary (Phase 3), board
// snapshot, frozen participant list, real elapsed duration, and the export / share
// affordances. Share falls back to the invite code/board link until the Phase 8
// embed link exists.

interface Props {
  session: Session;
  participants: { uid: string; displayName: string; email: string }[];
  isCreator: boolean;
  summaryConfigured: boolean;
  onGenerateSummary: () => void;
  generating: boolean;
  onExport: () => void;
  exporting: boolean;
  onShare: () => void;
  onGoToBoard: () => void;
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export default function SessionRecap({
  session,
  participants,
  isCreator,
  summaryConfigured,
  onGenerateSummary,
  generating,
  onExport,
  exporting,
  onShare,
  onGoToBoard,
}: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.statusBadge}>
        <Ionicons name="checkmark-circle" size={14} color="#059669" />
        <Text style={styles.statusText}>Ended</Text>
      </View>

      <Text style={styles.title}>{session.title}</Text>
      <Text style={styles.subtitle}>
        {(session.endedAt ?? session.scheduledAt).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        })}{" "}
        · {formatDuration(recapDurationMinutes(session))} · {participants.length} participant
        {participants.length !== 1 ? "s" : ""}
      </Text>

      {/* Snapshot */}
      {session.canvasSnapshot && (
        <Image source={{ uri: session.canvasSnapshot }} style={styles.snapshot} resizeMode="cover" />
      )}

      {/* Summary */}
      {session.summary ? (
        <View style={styles.summaryWrap}>
          <SummaryCard summary={session.summary} />
        </View>
      ) : (
        <View style={styles.noSummary}>
          <Ionicons name="sparkles-outline" size={20} color="#9ca3af" />
          <Text style={styles.noSummaryText}>No summary yet.</Text>
        </View>
      )}

      {isCreator && (
        <TouchableOpacity
          style={styles.aiBtn}
          onPress={onGenerateSummary}
          disabled={generating || !summaryConfigured}
        >
          {generating ? (
            <ActivityIndicator size="small" color="#7c3aed" />
          ) : (
            <>
              <Ionicons name={session.summary ? "refresh-outline" : "sparkles"} size={16} color="#7c3aed" />
              <Text style={styles.aiBtnText}>
                {session.summary ? "Regenerate Summary" : "Generate AI Summary"}
              </Text>
            </>
          )}
        </TouchableOpacity>
      )}
      {isCreator && !summaryConfigured && (
        <Text style={styles.aiHint}>Add an OpenAI key in Profile to generate summaries.</Text>
      )}

      {/* Participants */}
      {participants.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>Participants</Text>
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
        </>
      )}

      {/* Export / share */}
      <View style={styles.exportRow}>
        <TouchableOpacity style={styles.exportBtn} onPress={onExport} disabled={exporting}>
          {exporting ? (
            <ActivityIndicator size="small" color="#2563eb" />
          ) : (
            <>
              <Ionicons name="document-text-outline" size={16} color="#2563eb" />
              <Text style={styles.exportText}>Export PDF</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={styles.exportBtn} onPress={onShare}>
          <Ionicons name="share-outline" size={16} color="#2563eb" />
          <Text style={styles.exportText}>Share recap</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.boardBtn} onPress={onGoToBoard}>
        <Ionicons name="easel-outline" size={18} color="#2563eb" />
        <Text style={styles.boardText}>Open Board</Text>
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
    backgroundColor: "#ecfdf5",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 12,
  },
  statusText: { color: "#059669", fontWeight: "700", fontSize: 13 },
  title: { fontSize: 24, fontWeight: "700", color: "#111" },
  subtitle: { fontSize: 14, color: "#6b7280", marginBottom: 16 },
  snapshot: {
    width: "100%",
    height: 180,
    borderRadius: 12,
    backgroundColor: "#f3f4f6",
    marginBottom: 16,
  },
  summaryWrap: { marginBottom: 4 },
  noSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    padding: 14,
    marginBottom: 4,
  },
  noSummaryText: { color: "#9ca3af", fontSize: 14 },
  aiBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#ddd6fe",
    backgroundColor: "#f5f3ff",
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  aiBtnText: { color: "#7c3aed", fontSize: 14, fontWeight: "600" },
  aiHint: { fontSize: 12, color: "#9ca3af", marginTop: 6, textAlign: "center" },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  participantRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#059669",
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: { color: "#fff", fontWeight: "700" },
  pName: { fontSize: 15, fontWeight: "600", color: "#111827" },
  pEmail: { fontSize: 12, color: "#9ca3af" },
  exportRow: { flexDirection: "row", gap: 12, marginTop: 24 },
  exportBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#bfdbfe",
    backgroundColor: "#eff6ff",
    borderRadius: 12,
    padding: 13,
  },
  exportText: { color: "#2563eb", fontSize: 14, fontWeight: "600" },
  boardBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  boardText: { color: "#2563eb", fontSize: 16, fontWeight: "600" },
});
