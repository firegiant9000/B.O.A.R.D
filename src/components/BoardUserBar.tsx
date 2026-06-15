import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Alert,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BoardPresence } from "../types";
import * as friendService from "../services/friendService";
import * as boardService from "../services/boardService";
import { userColor } from "../lib/userColor";

interface BoardUserBarProps {
  presence: BoardPresence[];
  boardTitle: string;
  currentUser: { uid: string; displayName: string; email: string };
  blockedIds: string[];
  onBlock: (userId: string) => void;
  ownerId?: string;
  adminId?: string;
  boardId?: string;
  onAdminChanged?: (newAdminId: string) => void;
  // Phase 7 — follow mode. The user currently being followed (if any) and the
  // toggle callback; when undefined the Follow action is hidden.
  followingId?: string | null;
  onFollow?: (userId: string) => void;
}

type FriendStatus = "idle" | "loading" | "sent" | "friends" | "incoming";

function formatLastSeen(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Active just now";
  if (diffMins < 60) return `Active ${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `Active ${diffHrs}h ago`;
  return "Active over a day ago";
}

export default function BoardUserBar({
  presence,
  boardTitle,
  currentUser,
  blockedIds,
  onBlock,
  ownerId,
  adminId,
  boardId,
  onAdminChanged,
  followingId,
  onFollow,
}: BoardUserBarProps) {
  const [selectedUser, setSelectedUser] = useState<BoardPresence | null>(null);
  const [friendStatus, setFriendStatus] = useState<FriendStatus>("idle");

  const visible = presence.filter(
    (p) => p.userId !== currentUser.uid && !blockedIds.includes(p.userId)
  );

  const handleSelectUser = async (u: BoardPresence) => {
    setSelectedUser(u);
    setFriendStatus("loading");
    try {
      const [friends, outgoing, incoming] = await Promise.all([
        friendService.areFriends(currentUser.uid, u.userId),
        friendService.hasPendingRequest(currentUser.uid, u.userId),
        friendService.hasPendingRequest(u.userId, currentUser.uid),
      ]);
      if (friends) setFriendStatus("friends");
      else if (outgoing) setFriendStatus("sent");
      else if (incoming) setFriendStatus("incoming");
      else setFriendStatus("idle");
    } catch {
      setFriendStatus("idle");
    }
  };

  const handleSendFriendRequest = async () => {
    if (!selectedUser) return;
    setFriendStatus("loading");
    try {
      const result = await friendService.sendFriendRequest(
        currentUser.uid,
        currentUser.displayName,
        currentUser.email,
        selectedUser.email
      );
      if (result === "sent") {
        setFriendStatus("sent");
        Alert.alert("Request Sent", `Friend request sent to ${selectedUser.displayName}.`);
      } else if (result === "already_friends") {
        setFriendStatus("friends");
      } else if (result === "pending") {
        setFriendStatus("sent");
      }
    } catch {
      setFriendStatus("idle");
      Alert.alert("Error", "Failed to send friend request.");
    }
  };

  const handleFollow = () => {
    if (!selectedUser || !onFollow) return;
    onFollow(selectedUser.userId);
    setSelectedUser(null);
  };

  const handleBlock = () => {
    if (!selectedUser) return;
    Alert.alert(
      "Block User",
      `Block ${selectedUser.displayName}? Their contributions on this board will be hidden from you.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Block",
          style: "destructive",
          onPress: async () => {
            try {
              await friendService.blockUser(currentUser.uid, selectedUser.userId);
              onBlock(selectedUser.userId);
              setSelectedUser(null);
            } catch {
              Alert.alert("Error", "Failed to block user.");
            }
          },
        },
      ]
    );
  };

  const handleMakeAdmin = () => {
    if (!selectedUser || !boardId) return;
    Alert.alert(
      "Make Admin",
      `Make ${selectedUser.displayName} the board admin? You will lose admin privileges.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: async () => {
            try {
              await boardService.assignBoardAdmin(boardId, selectedUser.userId);
              onAdminChanged?.(selectedUser.userId);
              setSelectedUser(null);
              Alert.alert("Done", `${selectedUser.displayName} is now the board admin.`);
            } catch {
              Alert.alert("Error", "Failed to change admin.");
            }
          },
        },
      ]
    );
  };

  if (visible.length === 0) return null;

  return (
    <>
      <View style={styles.bar}>
        {visible.map((u) => (
          <TouchableOpacity
            key={u.userId}
            style={[styles.avatar, { backgroundColor: userColor(u.userId) }]}
            onPress={() => handleSelectUser(u)}
          >
            <Text style={styles.avatarText}>{u.displayName.charAt(0).toUpperCase()}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Modal
        visible={!!selectedUser}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedUser(null)}
      >
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={() => setSelectedUser(null)}
        >
          <View style={styles.card} onStartShouldSetResponder={() => true}>
            <TouchableOpacity style={styles.closeBtn} onPress={() => setSelectedUser(null)}>
              <Ionicons name="close" size={20} color="#9ca3af" />
            </TouchableOpacity>

            <View
              style={[
                styles.cardAvatar,
                { backgroundColor: selectedUser ? userColor(selectedUser.userId) : "#7c3aed" },
              ]}
            >
              <Text style={styles.cardAvatarText}>
                {selectedUser?.displayName.charAt(0).toUpperCase()}
              </Text>
            </View>

            <Text style={styles.cardName}>{selectedUser?.displayName}</Text>
            {selectedUser?.lastSeen && (
              <Text style={styles.cardLastSeen}>{formatLastSeen(selectedUser.lastSeen)}</Text>
            )}
            <Text style={styles.cardInfo}>
              <Text style={styles.cardNameInline}>{selectedUser?.displayName}</Text>
              {" is working on "}
              <Text style={styles.cardBoardTitle}>{boardTitle}</Text>
            </Text>

            <View style={styles.actionsContainer}>
              {friendStatus === "loading" ? (
                <ActivityIndicator color="#2563eb" style={styles.actionSpinner} />
              ) : friendStatus === "friends" ? (
                <View style={styles.statusBadge}>
                  <Ionicons name="people" size={16} color="#16a34a" />
                  <Text style={[styles.statusBadgeText, { color: "#16a34a" }]}>Friends</Text>
                </View>
              ) : friendStatus === "sent" ? (
                <View style={styles.statusBadge}>
                  <Ionicons name="checkmark-circle-outline" size={16} color="#6b7280" />
                  <Text style={[styles.statusBadgeText, { color: "#6b7280" }]}>Request Sent</Text>
                </View>
              ) : friendStatus === "incoming" ? (
                <View style={styles.statusBadge}>
                  <Ionicons name="mail-outline" size={16} color="#d97706" />
                  <Text style={[styles.statusBadgeText, { color: "#d97706" }]}>
                    They sent you a request
                  </Text>
                </View>
              ) : (
                <TouchableOpacity style={styles.primaryBtn} onPress={handleSendFriendRequest}>
                  <Ionicons name="person-add-outline" size={16} color="#fff" />
                  <Text style={styles.primaryBtnText}>Add Friend</Text>
                </TouchableOpacity>
              )}

              {onFollow && selectedUser && (
                <TouchableOpacity style={styles.followBtn} onPress={handleFollow}>
                  <Ionicons
                    name={followingId === selectedUser.userId ? "eye-off-outline" : "eye-outline"}
                    size={16}
                    color="#7c3aed"
                  />
                  <Text style={styles.followBtnText}>
                    {followingId === selectedUser.userId ? "Stop Following" : "Follow"}
                  </Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity style={styles.blockBtn} onPress={handleBlock}>
                <Ionicons name="ban-outline" size={16} color="#ef4444" />
                <Text style={styles.blockBtnText}>Block User</Text>
              </TouchableOpacity>

              {ownerId &&
                currentUser.uid === ownerId &&
                selectedUser &&
                adminId &&
                selectedUser.userId !== adminId && (
                  <TouchableOpacity style={styles.makeAdminBtn} onPress={handleMakeAdmin}>
                    <Ionicons name="shield-outline" size={16} color="#2563eb" />
                    <Text style={styles.makeAdminBtnText}>Make Admin</Text>
                  </TouchableOpacity>
                )}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  avatarText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingTop: 32,
    paddingBottom: 24,
    paddingHorizontal: 24,
    width: 288,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 10,
  },
  closeBtn: {
    position: "absolute",
    top: 12,
    right: 12,
    padding: 4,
  },
  cardAvatar: {
    width: 68,
    height: 68,
    borderRadius: 34,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  cardAvatarText: {
    color: "#fff",
    fontSize: 30,
    fontWeight: "700",
  },
  cardName: {
    fontSize: 19,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 6,
  },
  cardLastSeen: {
    fontSize: 12,
    color: "#9ca3af",
    marginBottom: 8,
  },
  cardInfo: {
    fontSize: 13,
    color: "#6b7280",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 20,
  },
  cardNameInline: {
    fontWeight: "600",
    color: "#374151",
  },
  cardBoardTitle: {
    fontWeight: "600",
    color: "#2563eb",
  },
  actionsContainer: {
    width: "100%",
    gap: 10,
    alignItems: "center",
  },
  actionSpinner: {
    marginVertical: 12,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
  },
  statusBadgeText: {
    fontSize: 14,
    fontWeight: "600",
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#2563eb",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    width: "100%",
  },
  primaryBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
  followBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1.5,
    borderColor: "#ddd6fe",
    paddingVertical: 11,
    paddingHorizontal: 20,
    borderRadius: 12,
    width: "100%",
  },
  followBtnText: {
    color: "#7c3aed",
    fontWeight: "600",
    fontSize: 15,
  },
  blockBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1.5,
    borderColor: "#fca5a5",
    paddingVertical: 11,
    paddingHorizontal: 20,
    borderRadius: 12,
    width: "100%",
  },
  blockBtnText: {
    color: "#ef4444",
    fontWeight: "600",
    fontSize: 15,
  },
  makeAdminBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1.5,
    borderColor: "#bfdbfe",
    paddingVertical: 11,
    paddingHorizontal: 20,
    borderRadius: 12,
    width: "100%",
  },
  makeAdminBtnText: {
    color: "#2563eb",
    fontWeight: "600",
    fontSize: 15,
  },
});
