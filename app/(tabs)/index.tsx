import { useCallback, useLayoutEffect, useState, useEffect, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
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

const showAlert = (title: string, message: string) => {
  if (Platform.OS === "web") {
    window.alert(`${title}\n${message}`);
  } else {
    Alert.alert(title, message);
  }
};
import { useRouter, useFocusEffect } from "expo-router";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/hooks/useAuth";
import { useWorkspace } from "../../src/hooks/useWorkspace";
import { Board, Session, ActivityEvent, WorkspaceRole } from "../../src/types";
import * as boardService from "../../src/services/boardService";
import * as sessionService from "../../src/services/sessionService";
import * as activityService from "../../src/services/activityService";
import * as friendService from "../../src/services/friendService";
import { subscribeToNotifications } from "../../src/services/notificationService";
import { getPinnedBoardIds, setPinnedBoardIds } from "../../src/lib/pinnedBoards";
import { JoinBoardResult } from "../../src/services/boardService";
import BoardCard from "../../src/components/BoardCard";
import ActivityFeed from "../../src/components/ActivityFeed";
import JoinBoardModal from "../../src/components/JoinBoardModal";
import WorkspaceSwitcher from "../../src/components/WorkspaceSwitcher";

// Phase 10 — the workspace dashboard. Replaces the bare boards list as the default
// tab landing: pinned boards + upcoming sessions above the fold, then recent boards,
// recent workspace activity (Phase 8), and the member roster. The create/join board
// flows are preserved from the previous boards screen.

interface MemberRow {
  uid: string;
  displayName: string;
  role: WorkspaceRole;
}

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

function formatSessionWhen(d: Date): string {
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function initial(name: string): string {
  return (name || "U").charAt(0).toUpperCase();
}

export default function DashboardScreen() {
  const { user } = useAuth();
  // Phase 3/10: everything on the dashboard is scoped to the active workspace from
  // the switcher context, which defaults to the user's personal workspace.
  const { activeWorkspace, activeWorkspaceId, loading: workspaceLoading } = useWorkspace();
  const router = useRouter();
  const navigation = useNavigation();
  const [boards, setBoards] = useState<Board[]>([]);
  const [sessionCounts, setSessionCounts] = useState<Map<string, number>>(new Map());
  const [upcomingSessions, setUpcomingSessions] = useState<Session[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [newBoardTitle, setNewBoardTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Board | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const fetchBoards = useCallback(async () => {
    if (!user || !activeWorkspaceId) return;
    try {
      const [data, sessions] = await Promise.all([
        boardService.getMemberBoards(user.uid, activeWorkspaceId),
        sessionService.getUpcomingSessions(user.uid, activeWorkspaceId),
      ]);
      setBoards(data);
      setUpcomingSessions(sessions);

      const counts = new Map<string, number>();
      for (const s of sessions) {
        counts.set(s.boardId, (counts.get(s.boardId) ?? 0) + 1);
      }
      setSessionCounts(counts);
    } catch (error: any) {
      showAlert("Error", error.message ?? "Failed to load boards.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, activeWorkspaceId]);

  // Resolve member uids → display names + roles for the roster section.
  useEffect(() => {
    let cancelled = false;
    if (!activeWorkspace) {
      setMembers([]);
      return;
    }
    const roleByUid = activeWorkspace.members;
    friendService
      .getUsersByIds(Object.keys(roleByUid))
      .then((users) => {
        if (cancelled) return;
        setMembers(
          users.map((u) => ({
            uid: u.uid,
            displayName: u.displayName,
            role: roleByUid[u.uid] ?? "member",
          }))
        );
      })
      .catch(() => !cancelled && setMembers([]));
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace]);

  // Realtime recent-activity feed for the active workspace (Phase 8 substrate).
  useEffect(() => {
    if (!activeWorkspaceId) {
      setActivity([]);
      setActivityLoading(false);
      return;
    }
    setActivityLoading(true);
    const unsub = activityService.subscribeToWorkspaceActivity(
      activeWorkspaceId,
      (events) => {
        setActivity(events);
        setActivityLoading(false);
      },
      15
    );
    return unsub;
  }, [activeWorkspaceId]);

  // Unread in-app notification count, for the header bell badge (Phase 10).
  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      return;
    }
    const unsub = subscribeToNotifications(user.uid, (items) => {
      setUnreadCount(items.filter((n) => !n.read).length);
    });
    return unsub;
  }, [user?.uid]);

  // Load pinned board ids for this (user, workspace).
  useEffect(() => {
    if (!user || !activeWorkspaceId) {
      setPinnedIds([]);
      return;
    }
    getPinnedBoardIds(user.uid, activeWorkspaceId).then(setPinnedIds);
  }, [user?.uid, activeWorkspaceId]);

  const togglePin = useCallback(
    (boardId: string) => {
      if (!user || !activeWorkspaceId) return;
      setPinnedIds((prev) => {
        const next = prev.includes(boardId)
          ? prev.filter((id) => id !== boardId)
          : [...prev, boardId];
        setPinnedBoardIds(user.uid, activeWorkspaceId, next);
        return next;
      });
    },
    [user?.uid, activeWorkspaceId]
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => <WorkspaceSwitcher />,
      headerRight: () => (
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={() => router.push("/notifications")}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <Ionicons name="notifications-outline" size={24} color="#2563eb" />
            {unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadCount > 9 ? "9+" : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setJoinModalVisible(true)}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <Ionicons name="enter-outline" size={24} color="#2563eb" />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, unreadCount, router]);

  useFocusEffect(
    useCallback(() => {
      fetchBoards();
    }, [fetchBoards])
  );

  const handleRefresh = () => {
    setRefreshing(true);
    fetchBoards();
  };

  const handleJoined = ({ boardId, alreadyMember }: JoinBoardResult) => {
    setJoinModalVisible(false);
    if (alreadyMember) {
      if (Platform.OS === "web") {
        window.alert("Already a member\nYou're already on this board.");
        router.push(`/board/${boardId}`);
      } else {
        Alert.alert("Already a member", "You're already on this board.", [
          { text: "Open Board", onPress: () => router.push(`/board/${boardId}`) },
          { text: "OK", style: "cancel" },
        ]);
      }
    } else {
      fetchBoards();
      router.push(`/board/${boardId}`);
    }
  };

  const handleCreateBoardSubmit = async () => {
    if (!newBoardTitle.trim() || !user || !activeWorkspaceId) return;
    try {
      const title = newBoardTitle.trim();
      const boardId = await boardService.createBoard(title, user.uid, activeWorkspaceId);
      // Phase 8: log the create to the workspace activity feed (fire-and-forget).
      activityService.logBoardCreated({
        workspaceId: activeWorkspaceId,
        boardId,
        actorId: user.uid,
        actorName: user.displayName ?? user.email ?? "Someone",
        title,
      });
      setNewBoardTitle("");
      setCreateModalVisible(false);
      fetchBoards();
    } catch (error: any) {
      showAlert("Error", error.message ?? "Failed to create board.");
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
      showAlert("Error", error.message ?? "Something went wrong.");
    } finally {
      setDeleteLoading(false);
    }
  };

  const pinnedBoards = useMemo(
    () => boards.filter((b) => pinnedIds.includes(b.id)),
    [boards, pinnedIds]
  );
  const recentBoards = useMemo(
    () =>
      boards
        .filter((b) => !pinnedIds.includes(b.id))
        .slice()
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    [boards, pinnedIds]
  );

  if (loading || workspaceLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  const isEmptyWorkspace = boards.length === 0 && upcomingSessions.length === 0;

  return (
    <View style={styles.container}>
      <JoinBoardModal
        visible={joinModalVisible}
        onClose={() => setJoinModalVisible(false)}
        onJoined={handleJoined}
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        {isEmptyWorkspace ? (
          <View style={styles.emptyState}>
            <Ionicons name="easel-outline" size={64} color="#ccc" />
            <Text style={styles.emptyTitle}>No boards yet</Text>
            <Text style={styles.emptySubtitle}>Tap the + button to create your first board</Text>
          </View>
        ) : (
          <>
            {/* Pinned boards (above the fold) */}
            {pinnedBoards.length > 0 && (
              <Section title="Pinned" icon="star">
                {pinnedBoards.map((b) => (
                  <BoardCard
                    key={b.id}
                    board={b}
                    onPress={() => router.push(`/board/${b.id}`)}
                    onDelete={() => handleDeleteBoard(b)}
                    sessionCount={sessionCounts.get(b.id)}
                    pinned
                    onTogglePin={() => togglePin(b.id)}
                  />
                ))}
              </Section>
            )}

            {/* Upcoming sessions (above the fold) */}
            <Section title="Upcoming sessions" icon="calendar-outline">
              {upcomingSessions.length === 0 ? (
                <Text style={styles.sectionEmpty}>No upcoming sessions.</Text>
              ) : (
                upcomingSessions.slice(0, 5).map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    style={styles.sessionRow}
                    onPress={() => router.push(`/session/${s.id}`)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.sessionIcon}>
                      <Ionicons name="videocam-outline" size={18} color="#4338ca" />
                    </View>
                    <View style={styles.sessionInfo}>
                      <Text style={styles.sessionTitle} numberOfLines={1}>
                        {s.title || s.boardTitle}
                      </Text>
                      <Text style={styles.sessionMeta} numberOfLines={1}>
                        {s.boardTitle} · {formatSessionWhen(s.scheduledAt)}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
                  </TouchableOpacity>
                ))
              )}
            </Section>

            {/* Recent boards */}
            {recentBoards.length > 0 && (
              <Section title="Recent boards" icon="grid-outline">
                {recentBoards.map((b) => (
                  <BoardCard
                    key={b.id}
                    board={b}
                    onPress={() => router.push(`/board/${b.id}`)}
                    onDelete={() => handleDeleteBoard(b)}
                    sessionCount={sessionCounts.get(b.id)}
                    pinned={false}
                    onTogglePin={() => togglePin(b.id)}
                  />
                ))}
              </Section>
            )}

            {/* Recent activity (Phase 8) */}
            <Section title="Recent activity" icon="time-outline">
              <ActivityFeed
                events={activity}
                loading={activityLoading}
                emptyText="No activity in this workspace yet."
              />
            </Section>

            {/* Workspace members */}
            {members.length > 0 && (
              <Section title="Members" icon="people-outline">
                {members.map((m) => (
                  <View key={m.uid} style={styles.memberRow}>
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberAvatarText}>{initial(m.displayName)}</Text>
                    </View>
                    <Text style={styles.memberName} numberOfLines={1}>
                      {m.displayName}
                      {m.uid === user?.uid ? " (you)" : ""}
                    </Text>
                    <Text style={styles.memberRole}>{ROLE_LABEL[m.role]}</Text>
                  </View>
                ))}
              </Section>
            )}
          </>
        )}
      </ScrollView>

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
              <View style={styles.deleteIconWrap}>
                <Ionicons name="trash-outline" size={24} color="#ef4444" />
              </View>
              <Text style={styles.deleteTitle}>
                {deleteTarget.ownerId === user?.uid ? "Delete Board?" : "Leave Board?"}
              </Text>
              <Text style={styles.deleteBody}>
                {deleteTarget.ownerId === user?.uid ? (
                  deleteTarget.members.length > 1
                    ? `"${deleteTarget.title}" will be permanently deleted. All ${deleteTarget.members.length} members — including ${deleteTarget.members.length - 1} collaborator${deleteTarget.members.length - 1 !== 1 ? "s" : ""} — will immediately lose access. This cannot be undone.`
                    : `"${deleteTarget.title}" will be permanently deleted. This cannot be undone.`
                ) : (
                  `You will be removed from "${deleteTarget.title}" and will no longer have access to its content.`
                )}
              </Text>
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

      {/* Create Board Modal */}
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
          <Pressable style={styles.modalBackdrop} onPress={() => setCreateModalVisible(false)} />
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
                onPress={() => {
                  setNewBoardTitle("");
                  setCreateModalVisible(false);
                }}
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

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Ionicons name={icon} size={16} color="#6b7280" />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {children}
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
  scrollContent: {
    paddingTop: 12,
    paddingBottom: 96,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    marginRight: 12,
  },
  headerBtn: {
    paddingHorizontal: 6,
  },
  badge: {
    position: "absolute",
    top: -4,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: "#ef4444",
    justifyContent: "center",
    alignItems: "center",
  },
  badgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
  section: {
    marginBottom: 22,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sectionEmpty: {
    fontSize: 13,
    color: "#9ca3af",
    paddingHorizontal: 16,
  },
  // ── Upcoming sessions ──
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 14,
  },
  sessionIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#eef2ff",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  sessionInfo: { flex: 1 },
  sessionTitle: { fontSize: 15, fontWeight: "600", color: "#111827" },
  sessionMeta: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  // ── Members ──
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 8,
  },
  memberAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#6b7280",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  memberAvatarText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  memberName: { flex: 1, fontSize: 14, color: "#111827", fontWeight: "500" },
  memberRole: {
    fontSize: 12,
    fontWeight: "600",
    color: "#4338ca",
    backgroundColor: "#eef2ff",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: "hidden",
  },
  // ── Empty state ──
  emptyState: {
    alignItems: "center",
    paddingTop: 64,
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
  // ── Delete / Leave confirmation modal ──
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
