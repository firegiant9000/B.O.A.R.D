import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Session } from "../types";

interface SessionCardProps {
  session: Session;
  boardTitle?: string;
  onPress: () => void;
  onDelete?: () => void;
}

function formatSessionTime(date: Date, durationMinutes: number): string {
  const timeStr = date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const hours = Math.floor(durationMinutes / 60);
  const mins = durationMinutes % 60;
  const durationStr =
    hours > 0
      ? mins > 0
        ? `${hours}h ${mins}m`
        : `${hours}h`
      : `${mins}m`;
  return `${timeStr} — ${durationStr}`;
}

export default function SessionCard({
  session,
  boardTitle,
  onPress,
  onDelete,
}: SessionCardProps) {
  const isPast = session.scheduledAt < new Date();

  return (
    <TouchableOpacity
      style={[styles.card, isPast && styles.cardPast]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.iconContainer, isPast && styles.iconContainerPast]}>
        <Ionicons
          name="calendar-outline"
          size={24}
          color={isPast ? "#9ca3af" : "#2563eb"}
        />
      </View>
      <View style={styles.content}>
        <Text
          style={[styles.title, isPast && styles.textPast]}
          numberOfLines={1}
        >
          {session.title}
        </Text>
        <Text style={[styles.time, isPast && styles.textPast]}>
          {formatSessionTime(session.scheduledAt, session.durationMinutes)}
        </Text>
        <View style={styles.metaRow}>
          {boardTitle ? (
            <View style={styles.boardChip}>
              <Text style={styles.boardChipText} numberOfLines={1}>
                {boardTitle}
              </Text>
            </View>
          ) : null}
          {session.participantIds.length > 0 && (
            <Text style={styles.participants}>
              {session.participantIds.length} participant
              {session.participantIds.length > 1 ? "s" : ""}
            </Text>
          )}
        </View>
      </View>
      {onDelete && (
        <TouchableOpacity style={styles.deleteButton} onPress={onDelete}>
          <Ionicons name="trash-outline" size={20} color="#ef4444" />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  cardPast: {
    opacity: 0.6,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  iconContainerPast: {
    backgroundColor: "#f3f4f6",
  },
  content: {
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 2,
  },
  time: {
    fontSize: 13,
    color: "#6b7280",
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  boardChip: {
    backgroundColor: "#e0e7ff",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  boardChipText: {
    fontSize: 11,
    color: "#4338ca",
    fontWeight: "500",
    maxWidth: 120,
  },
  participants: {
    fontSize: 12,
    color: "#9ca3af",
  },
  textPast: {
    color: "#9ca3af",
  },
  deleteButton: {
    padding: 8,
  },
});
