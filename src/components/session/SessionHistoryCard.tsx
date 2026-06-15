import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "../../types";
import SummaryCard from "../SummaryCard";
import { recapDurationMinutes } from "../../utils/recapExport";

// Phase 5: a vertical recap card for the session-history tab. Shows the board
// snapshot thumbnail, title, ended date, real elapsed duration, attendee count,
// and the structured AI summary (legacy-string tolerant via SummaryCard). Tapping
// opens the full recap (the Phase 4 session screen).

interface Props {
  session: Session;
  onPress: () => void;
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function attendeeCount(session: Session): number {
  // Prefer the frozen snapshot (includes the creator); fall back to invited + creator.
  if (session.participants && session.participants.length > 0) {
    return session.participants.length;
  }
  return session.participantIds.length + 1;
}

export default function SessionHistoryCard({ session, onPress }: Props) {
  const date = session.endedAt ?? session.scheduledAt;
  const count = attendeeCount(session);

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.85}>
      {session.canvasSnapshot ? (
        <Image source={{ uri: session.canvasSnapshot }} style={styles.thumb} resizeMode="cover" />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]}>
          <Ionicons name="image-outline" size={28} color="#cbd5e1" />
        </View>
      )}

      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {session.title}
        </Text>

        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Ionicons name="easel-outline" size={13} color="#6b7280" />
            <Text style={styles.metaText} numberOfLines={1}>
              {session.boardTitle || "Untitled board"}
            </Text>
          </View>
        </View>

        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Ionicons name="calendar-outline" size={13} color="#6b7280" />
            <Text style={styles.metaText}>
              {date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            </Text>
          </View>
          <View style={styles.metaItem}>
            <Ionicons name="time-outline" size={13} color="#6b7280" />
            <Text style={styles.metaText}>{formatDuration(recapDurationMinutes(session))}</Text>
          </View>
          <View style={styles.metaItem}>
            <Ionicons name="people-outline" size={13} color="#6b7280" />
            <Text style={styles.metaText}>
              {count} {count === 1 ? "person" : "people"}
            </Text>
          </View>
        </View>

        {session.summary ? (
          <SummaryCard summary={session.summary} />
        ) : (
          <View style={styles.noSummary}>
            <Ionicons name="sparkles-outline" size={14} color="#9ca3af" />
            <Text style={styles.noSummaryText}>No summary</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderRadius: 16,
    overflow: "hidden",
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  thumb: {
    width: "100%",
    height: 140,
    backgroundColor: "#f3f4f6",
  },
  thumbPlaceholder: {
    justifyContent: "center",
    alignItems: "center",
  },
  body: {
    padding: 16,
    gap: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
  },
  metaRow: {
    flexDirection: "row",
    gap: 12,
    flexWrap: "wrap",
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  metaText: {
    fontSize: 13,
    color: "#6b7280",
  },
  noSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  noSummaryText: {
    fontSize: 13,
    color: "#9ca3af",
    fontStyle: "italic",
  },
});
