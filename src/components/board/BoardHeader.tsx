import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import MemberList from "../MemberList";
import BoardUserBar from "../BoardUserBar";
import { BoardPresence } from "../../types";

/**
 * The board screen's header bar (Month 5/6 Task 1 — extracted verbatim from
 * `app/board/[id].tsx`).
 *
 * Board title + back, the member/presence bars, the background, history, diagram
 * and share affordances, and the admin-only session controls. The screen hides
 * this entirely in embed mode, so the component itself has no embed branch.
 */

interface BoardHeaderProps {
  boardId: string;
  boardTitle: string;
  onBack: () => void;

  // Members + presence
  memberUids: string[];
  currentUserId: string | undefined;
  presence: BoardPresence[];
  currentUser: { uid: string; displayName: string; email: string };
  blockedIds: string[];
  onBlock: (userId: string) => void;
  ownerId?: string;
  adminId?: string;
  onAdminChanged: (newAdminId: string) => void;
  followingId: string | null;
  onFollow: (userId: string) => void;

  // Affordances
  onOpenBackgroundPicker: () => void;
  onOpenHistory: () => void;
  /** `isDiagramConfigured()` — gates the text → diagram button. */
  diagramEnabled: boolean;
  onOpenDiagram: () => void;
  onShare: () => void;

  // Admin-only session controls
  isAdmin: boolean;
  /** True when this admin has an active session on the board. */
  hasActiveSession: boolean;
  endingSession: boolean;
  onEndSession: () => void;
  onStartSession: () => void;

  // Task 14 — admin/host-only presenter controls. Gated on the same `isAdmin`
  // as the session controls above: this board has no separate "host" role.
  isPresenting: boolean;
  /** Meaningless while `isPresenting` is false. */
  isPresenterPaused: boolean;
  onStartPresenting: () => void;
  onStopPresenting: () => void;
  onPausePresenting: () => void;
  onResumePresenting: () => void;
}

export default function BoardHeader({
  boardId,
  boardTitle,
  onBack,
  memberUids,
  currentUserId,
  presence,
  currentUser,
  blockedIds,
  onBlock,
  ownerId,
  adminId,
  onAdminChanged,
  followingId,
  onFollow,
  onOpenBackgroundPicker,
  onOpenHistory,
  diagramEnabled,
  onOpenDiagram,
  onShare,
  isAdmin,
  hasActiveSession,
  endingSession,
  onEndSession,
  onStartSession,
  isPresenting,
  isPresenterPaused,
  onStartPresenting,
  onStopPresenting,
  onPausePresenting,
  onResumePresenting,
}: BoardHeaderProps) {
  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={onBack}
        style={styles.backBtn}
      >
        <Ionicons name="arrow-back" size={24} color="#333" />
      </TouchableOpacity>

      <Text style={styles.title} numberOfLines={1}>
        {boardTitle}
      </Text>

      <View style={styles.headerRight}>
        <MemberList
          boardId={boardId}
          memberUids={memberUids}
          currentUserId={currentUserId}
        />
        <BoardUserBar
          presence={presence}
          boardTitle={boardTitle}
          currentUser={currentUser}
          blockedIds={blockedIds}
          onBlock={onBlock}
          ownerId={ownerId}
          adminId={adminId}
          boardId={boardId}
          onAdminChanged={onAdminChanged}
          followingId={followingId}
          onFollow={onFollow}
        />
        <TouchableOpacity
          onPress={onOpenBackgroundPicker}
          style={styles.iconBtn}
          hitSlop={8}
        >
          <Ionicons name="grid-outline" size={20} color="#2563eb" />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onOpenHistory}
          style={styles.iconBtn}
          hitSlop={8}
        >
          <Ionicons name="time-outline" size={20} color="#2563eb" />
        </TouchableOpacity>
        {/* Phase 12 — text → diagram. Opens the prompt sheet; gated OFF until the
            diagram flag + AI gateway are both on. */}
        {diagramEnabled && (
          <TouchableOpacity
            onPress={onOpenDiagram}
            style={styles.iconBtn}
            hitSlop={8}
          >
            <Ionicons name="git-network-outline" size={20} color="#2563eb" />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={onShare}
          style={styles.iconBtn}
          hitSlop={8}
        >
          <Ionicons name="share-outline" size={22} color="#2563eb" />
        </TouchableOpacity>
        {isAdmin && (
          <>
            {hasActiveSession ? (
              <TouchableOpacity
                style={styles.endSessionBtn}
                onPress={onEndSession}
                disabled={endingSession}
              >
                {endingSession ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="stop-circle-outline" size={16} color="#fff" />
                )}
                <Text style={styles.startSessionText}>End Session</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.startSessionBtn}
                onPress={onStartSession}
              >
                <Ionicons name="play-circle-outline" size={16} color="#fff" />
                <Text style={styles.startSessionText}>Session</Text>
              </TouchableOpacity>
            )}
            {/* Task 14 — presenter toggle, same isAdmin gate as Session above. */}
            {isPresenting ? (
              <>
                <TouchableOpacity
                  style={styles.iconBtn}
                  onPress={isPresenterPaused ? onResumePresenting : onPausePresenting}
                  hitSlop={8}
                >
                  <Ionicons
                    name={isPresenterPaused ? "play-circle-outline" : "pause-circle-outline"}
                    size={20}
                    color="#2563eb"
                  />
                </TouchableOpacity>
                <TouchableOpacity style={styles.stopPresentingBtn} onPress={onStopPresenting}>
                  <Ionicons name="easel-outline" size={16} color="#fff" />
                  <Text style={styles.startSessionText}>Stop</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity style={styles.presentBtn} onPress={onStartPresenting}>
                <Ionicons name="easel-outline" size={16} color="#fff" />
                <Text style={styles.startSessionText}>Present</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() =>
                Alert.alert(
                  "Board Admin",
                  "You are the admin of this board. You can delete any user's notes and clear the entire board.",
                  [{ text: "OK" }]
                )
              }
            >
              <Ionicons name="shield-checkmark" size={20} color="#2563eb" />
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  backBtn: {
    padding: 4,
    marginRight: 4,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    marginHorizontal: 8,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 32,
    justifyContent: "flex-end",
  },
  iconBtn: {
    padding: 4,
  },
  startSessionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#2563eb",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  endSessionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ef4444",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  presentBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#7c3aed",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  stopPresentingBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#6b7280",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  startSessionText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
});
