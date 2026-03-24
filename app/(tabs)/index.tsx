import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/hooks/useAuth";
import { Board } from "../../src/types";
import * as boardService from "../../src/services/boardService";
import * as sessionService from "../../src/services/sessionService";
import BoardCard from "../../src/components/BoardCard";

export default function BoardsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [boards, setBoards] = useState<Board[]>([]);
  const [sessionCounts, setSessionCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchBoards = useCallback(async () => {
    if (!user) return;
    try {
      const [data, sessions] = await Promise.all([
        boardService.getUserBoards(user.uid),
        sessionService.getUpcomingSessions(user.uid),
      ]);
      setBoards(data);

      const counts = new Map<string, number>();
      for (const s of sessions) {
        counts.set(s.boardId, (counts.get(s.boardId) ?? 0) + 1);
      }
      setSessionCounts(counts);
    } catch (error: any) {
      Alert.alert("Error", error.message ?? "Failed to load boards.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => {
    fetchBoards();
  }, [fetchBoards]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchBoards();
  };

  const handleCreateBoard = () => {
    Alert.prompt(
      "New Board",
      "Enter a name for your board:",
      async (title) => {
        if (!title?.trim() || !user) return;
        try {
          await boardService.createBoard(title.trim(), user.uid);
          fetchBoards();
        } catch (error: any) {
          Alert.alert("Error", error.message ?? "Failed to create board.");
        }
      }
    );
  };

  // Fallback for Android (Alert.prompt is iOS-only)
  const handleCreateBoardCrossPlatform = () => {
    // On iOS, Alert.prompt works. On Android, we use a simple approach.
    if (typeof Alert.prompt === "function") {
      handleCreateBoard();
    } else {
      // For Android, create with a default name (will improve with a modal later)
      Alert.alert("New Board", "Create a new board?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Create",
          onPress: async () => {
            if (!user) return;
            try {
              await boardService.createBoard(
                `Board ${boards.length + 1}`,
                user.uid
              );
              fetchBoards();
            } catch (error: any) {
              Alert.alert("Error", error.message ?? "Failed to create board.");
            }
          },
        },
      ]);
    }
  };

  const handleDeleteBoard = (boardId: string, title: string) => {
    Alert.alert("Delete Board", `Delete "${title}"? This cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await boardService.deleteBoard(boardId);
            setBoards((prev) => prev.filter((b) => b.id !== boardId));
          } catch (error: any) {
            Alert.alert("Error", error.message ?? "Failed to delete board.");
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={boards}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <BoardCard
            board={item}
            onPress={() => router.push(`/board/${item.id}`)}
            onDelete={() => handleDeleteBoard(item.id, item.title)}
            sessionCount={sessionCounts.get(item.id)}
          />
        )}
        contentContainerStyle={boards.length === 0 ? styles.centered : styles.list}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="easel-outline" size={64} color="#ccc" />
            <Text style={styles.emptyTitle}>No boards yet</Text>
            <Text style={styles.emptySubtitle}>
              Tap the + button to create your first board
            </Text>
          </View>
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      />

      <TouchableOpacity
        style={styles.fab}
        onPress={handleCreateBoardCrossPlatform}
        activeOpacity={0.8}
      >
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>
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
  },
  list: {
    paddingTop: 16,
    paddingBottom: 80,
  },
  emptyState: {
    alignItems: "center",
    paddingTop: 48,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: "#888",
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#aaa",
    marginTop: 4,
  },
  fab: {
    position: "absolute",
    right: 24,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
});
