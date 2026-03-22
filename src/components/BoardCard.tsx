import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Board } from "../types";

interface BoardCardProps {
  board: Board;
  onPress: () => void;
  onDelete?: () => void;
}

export default function BoardCard({ board, onPress, onDelete }: BoardCardProps) {
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
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
  deleteButton: {
    padding: 8,
  },
});
