import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  RefreshControl,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Pressable,
} from "react-native";
import { useRouter } from "expo-router";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/hooks/useAuth";
import { Board } from "../../src/types";
import * as boardService from "../../src/services/boardService";
import * as sessionService from "../../src/services/sessionService";
import { JoinBoardResult } from "../../src/services/boardService";
import BoardCard from "../../src/components/BoardCard";
import JoinBoardModal from "../../src/components/JoinBoardModal";

export default function BoardsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const navigation = useNavigation();
  const [boards, setBoards] = useState<Board[]>([]);
  const [sessionCounts, setSessionCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [newBoardTitle, setNewBoardTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Board | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const fetchBoards = useCallback(async () => {
    if (!user) return;
    try {
      const [data, sessions] = await Promise.all([
        boardService.getMemberBoards(user.uid),
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

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={() => setJoinModalVisible(true)}
          style={{ marginRight: 16 }}
          hitSlop={8}
        >
          <Ionicons name="enter-outline" size={24} color="#2563eb" />
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  useEffect(() => {
    fetchBoards();
  }, [fetchBoards]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchBoards();
  };

  const handleJoined = ({ boardId, alreadyMember }: JoinBoardResult) => {
    setJoinModalVisible(false);
    if (alreadyMember) {
      Alert.alert("Already a member", "You're already on this board.", [
        { text: "Open Board", onPress: () => router.push(`/board/${boardId}`) },
        { text: "OK", style: "cancel" },
      ]);
    } else {
      fetchBoards();
      router.push(`/board/${boardId}`);
    }
  };

  const handleCreateBoardSubmit = async () => {
    if (!newBoardTitle.trim() || !user) return;
    try {
      await boardService.createBoard(newBoardTitle.trim(), user.uid);
      setNewBoardTitle("");
      setCreateModalVisible(false);
      fetchBoards();
    } catch (error: any) {
      Alert.alert("Error", error.message ?? "Failed to create board.");
    }
  };

  const handleDeleteBoard = (board: Board) => {
    setDeleteTarget(board);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || !user) return;
    setDeleteLoading(true);
    try {
      const isOwner = deleteTarget.ownerId === user.uid;
      if (isOwner) {
        await boardService.deleteBoard(deleteTarget.id);
      } else {
        await boardService.leaveBoard(deleteTarget.id);
      }
      setBoards((prev) => prev.filter((b) => b.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (error: any) {
      Alert.alert("Error", error.message ?? "Something went wrong.");
    } finally {
      setDeleteLoading(false);
    }
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
      <JoinBoardModal
        visible={joinModalVisible}
        onClose={() => setJoinModalVisible(false)}
        onJoined={handleJoined}
      />

      <FlatList
        data={boards}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <BoardCard
            board={item}
            onPress={() => router.push(`/board/${item.id}`)}
            onDelete={() => handleDeleteBoard(item)}
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
        onPress={() => setCreateModalVisible(true)}
        activeOpacity={0.8}
      >
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>

      {/* Delete / Leave Board Confirmation Modal */}
      {deleteTarget && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => !deleteLoading && setDeleteTarget(null)}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => !deleteLoading && setDeleteTarget(null)}
          />
          <View style={styles.deleteModalWrapper}>
            <View style={styles.deleteModal}>
              {/* Icon */}
              <View style={styles.deleteIconWrap}>
                <Ionicons name="trash-outline" size={24} color="#ef4444" />
              </View>

              {/* Title */}
              <Text style={styles.deleteTitle}>
                {deleteTarget.ownerId === user?.uid ? "Delete Board?" : "Leave Board?"}
              </Text>

              {/* Body */}
              <Text style={styles.deleteBody}>
                {deleteTarget.ownerId === user?.uid ? (
                  deleteTarget.members.length > 1
                    ? `"${deleteTarget.title}" will be permanently deleted. All ${deleteTarget.members.length} members — including ${deleteTarget.members.length - 1} collaborator${deleteTarget.members.length - 1 !== 1 ? "s" : ""} — will immediately lose access. This cannot be undone.`
                    : `"${deleteTarget.title}" will be permanently deleted. This cannot be undone.`
                ) : (
                  `You will be removed from "${deleteTarget.title}" and will no longer have access to its content.`
                )}
              </Text>

              {/* Actions */}
              <View style={styles.deleteActions}>
                <TouchableOpacity
                  style={styles.deleteCancelBtn}
                  onPress={() => setDeleteTarget(null)}
                  disabled={deleteLoading}
                  activeOpacity={0.7}
                >
                  <Text style={styles.deleteCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.deleteConfirmBtn, deleteLoading && styles.deleteConfirmBtnDisabled]}
                  onPress={handleConfirmDelete}
                  disabled={deleteLoading}
                  activeOpacity={0.8}
                >
                  {deleteLoading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.deleteConfirmText}>
                      {deleteTarget.ownerId === user?.uid ? "Delete" : "Leave"}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* Create Board Modal — works on iOS, Android, and web */}
      <Modal
        visible={createModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCreateModalVisible(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => setCreateModalVisible(false)}
          />
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <View style={styles.modalIconWrap}>
                <Ionicons name="easel-outline" size={20} color="#2563eb" />
              </View>
              <Text style={styles.modalTitle}>New Board</Text>
              <TouchableOpacity onPress={() => setCreateModalVisible(false)} hitSlop={8}>
                <Ionicons name="close" size={22} color="#666" />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalLabel}>Board Name</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="e.g. Sprint Planning"
              placeholderTextColor="#bbb"
              value={newBoardTitle}
              onChangeText={setNewBoardTitle}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleCreateBoardSubmit}
              maxLength={60}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => { setNewBoardTitle(""); setCreateModalVisible(false); }}
                activeOpacity={0.7}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalCreate, !newBoardTitle.trim() && styles.modalCreateDisabled]}
                onPress={handleCreateBoardSubmit}
                disabled={!newBoardTitle.trim()}
                activeOpacity={0.8}
              >
                <Text style={styles.modalCreateText}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  modalBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  modalSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: Platform.OS === "ios" ? 40 : 24,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 20,
  },
  modalIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  modalTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    color: "#111",
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#444",
    marginBottom: 6,
  },
  modalInput: {
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: "#111",
    backgroundColor: "#f9fafb",
  },
  modalActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 24,
  },
  modalCancel: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#666",
  },
  modalCreate: {
    flex: 2,
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  modalCreateDisabled: {
    backgroundColor: "#93c5fd",
  },
  modalCreateText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },
  // ── Delete / Leave confirmation modal ─────────────────────────────────────
  deleteModalWrapper: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  deleteModal: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  deleteIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#fff1f2",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  deleteTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111",
    marginBottom: 10,
    textAlign: "center",
  },
  deleteBody: {
    fontSize: 14,
    color: "#555",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  deleteActions: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  deleteCancelBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  deleteCancelText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#666",
  },
  deleteConfirmBtn: {
    flex: 1,
    backgroundColor: "#ef4444",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  deleteConfirmBtnDisabled: {
    backgroundColor: "#fca5a5",
  },
  deleteConfirmText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },
});
