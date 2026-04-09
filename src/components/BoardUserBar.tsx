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

interface BoardUserBarProps {
  presence: BoardPresence[];
  boardTitle: string;
  currentUser: { uid: string; displayName: string; email: string };
  blockedIds: string[];
  onBlock: (userId: string) => void;
}

type FriendStatus = "idle" | "loading" | "sent" | "friends" | "incoming";

// Distinct colors for guest avatars so they stand out
const AVATAR_COLORS = ["#7c3aed", "#db2777", "#059669", "#d97706", "#dc2626"];

function avatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function BoardUserBar({
  presence,
  boardTitle,
  currentUser,
  blockedIds,
  onBlock,
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

  if (visible.length === 0) return null;

  return (
    <>
      <View style={styles.bar}>
        {visible.map((u) => (
          <TouchableOpacity
            key={u.userId}
            style={[styles.avatar, { backgroundColor: avatarColor(u.userId) }]}
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
                { backgroundColor: selectedUser ? avatarColor(selectedUser.userId) : "#7c3aed" },
              ]}
            >
              <Text style={styles.cardAvatarText}>
                {selectedUser?.displayName.charAt(0).toUpperCase()}
              </Text>
            </View>

            <Text style={styles.cardName}>{selectedUser?.displayName}</Text>
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

              <TouchableOpacity style={styles.blockBtn} onPress={handleBlock}>
                <Ionicons name="ban-outline" size={16} color="#ef4444" />
                <Text style={styles.blockBtnText}>Block User</Text>
              </TouchableOpacity>
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
});
