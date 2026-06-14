import { TouchableOpacity, View, Text, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Board } from "../types";

interface BoardCardProps {
  board: Board;
  onPress: () => void;
  onDelete?: () => void;
  sessionCount?: number;
  // Phase 10 (dashboard). When `onTogglePin` is provided a star toggle renders;
  // `pinned` controls its filled/outline state.
  pinned?: boolean;
  onTogglePin?: () => void;
}

export default function BoardCard({
  board,
  onPress,
  onDelete,
  sessionCount,
  pinned,
  onTogglePin,
}: BoardCardProps) {
  return (
    <View style={styles.wrapper}>
      <TouchableOpacity
        style={[styles.card, onDelete ? styles.cardWithDelete : null]}
        onPress={onPress}
        activeOpacity={0.7}
      >
        <View style={styles.iconContainer}>
          <Ionicons name="easel-outline" size={28} color="#2563eb" />
        </View>
        <View style={styles.content}>
          <Text style={styles.title} numberOfLines={1}>
            {board.title}
          </Text>
          <Text style={styles.meta}>
            {board.updatedAt.toLocaleDateString()}
            {board.collaboratorIds.length > 0 &&
              ` · ${board.collaboratorIds.length} collaborator${board.collaboratorIds.length > 1 ? "s" : ""}`}
          </Text>
          {sessionCount != null && sessionCount > 0 && (
            <View style={styles.sessionBadge}>
              <Ionicons name="calendar-outline" size={12} color="#4338ca" />
              <Text style={styles.sessionBadgeText}>
                {sessionCount} session{sessionCount > 1 ? "s" : ""}
              </Text>
            </View>
          )}
        </View>
        {onTogglePin && (
          <TouchableOpacity onPress={onTogglePin} hitSlop={8} style={styles.pinButton}>
            <Ionicons
              name={pinned ? "star" : "star-outline"}
              size={20}
              color={pinned ? "#f59e0b" : "#cbd5e1"}
            />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
      {onDelete && (
        <TouchableOpacity style={styles.deleteButton} onPress={onDelete}>
          <Ionicons name="trash-outline" size={20} color="#ef4444" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const DELETE_BTN_WIDTH = 44;

const styles = StyleSheet.create({
  wrapper: {
    marginHorizontal: 16,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
  },
  card: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 16,
  },
  cardWithDelete: {
    marginRight: 8,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  content: {
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 2,
  },
  meta: {
    fontSize: 13,
    color: "#888",
  },
  pinButton: {
    width: 32,
    height: 32,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 4,
  },
  deleteButton: {
    width: DELETE_BTN_WIDTH,
    height: DELETE_BTN_WIDTH,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 10,
    backgroundColor: "#fff1f2",
    // Subtle shadow so it reads as a separate tap target
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 2 },
      android: { elevation: 1 },
      default: {},
    }),
  },
  sessionBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  sessionBadgeText: {
    fontSize: 12,
    color: "#4338ca",
    fontWeight: "500",
  },
});
