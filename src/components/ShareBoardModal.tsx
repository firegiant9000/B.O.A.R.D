import React, { useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Platform,
  Pressable,
  KeyboardAvoidingView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as boardService from "../services/boardService";
import * as friendService from "../services/friendService";

interface Friend {
  uid: string;
  displayName: string;
  email: string;
}

interface ShareBoardModalProps {
  visible: boolean;
  boardId: string;
  inviteCode: string;
  members: string[];
  currentUserId: string;
  onClose: () => void;
  onMemberAdded: (uid: string) => void;
}

export default function ShareBoardModal({
  visible,
  boardId,
  inviteCode,
  members,
  currentUserId,
  onClose,
  onMemberAdded,
}: ShareBoardModalProps) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(false);
  const [addingUid, setAddingUid] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [addingEmail, setAddingEmail] = useState(false);
  const [emailStatus, setEmailStatus] = useState<{ type: "error" | "success"; msg: string } | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [localMembers, setLocalMembers] = useState<string[]>(members);

  // Sync member list when prop changes
  useEffect(() => {
    setLocalMembers(members);
  }, [members]);

  // Load friends when modal opens
  useEffect(() => {
    if (!visible) return;
    setLoadingFriends(true);
    friendService
      .getFriends(currentUserId)
      .then((reqs) => {
        const mapped: Friend[] = reqs.map((req) =>
          req.fromId === currentUserId
            ? { uid: req.toId, displayName: req.toDisplayName, email: req.toEmail }
            : { uid: req.fromId, displayName: req.fromDisplayName, email: req.fromEmail }
        );
        setFriends(mapped);
      })
      .catch(() => {})
      .finally(() => setLoadingFriends(false));
  }, [visible, currentUserId]);

  const handleCopyCode = async () => {
    if (Platform.OS === "web" && navigator?.clipboard) {
      try {
        await navigator.clipboard.writeText(inviteCode);
        setCodeCopied(true);
        setTimeout(() => setCodeCopied(false), 2000);
      } catch {
        // clipboard not available (non-HTTPS); code is visible on screen
      }
    } else {
      // On native the code is displayed; the user can long-press to copy
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }
  };

  const handleAddFriend = async (friend: Friend) => {
    setAddingUid(friend.uid);
    try {
      await boardService.addMemberById(boardId, friend.uid);
      setLocalMembers((prev) => [...prev, friend.uid]);
      onMemberAdded(friend.uid);
    } catch {
      // Silent
    } finally {
      setAddingUid(null);
    }
  };

  const handleAddByEmail = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setAddingEmail(true);
    setEmailStatus(null);
    try {
      const { result, uid } = await boardService.addMemberByEmail(boardId, trimmed);
      if (result === "not_found") {
        setEmailStatus({ type: "error", msg: "No user found with that email." });
      } else if (result === "already_member") {
        setEmailStatus({ type: "error", msg: "This user is already a member." });
      } else {
        setEmail("");
        setEmailStatus({ type: "success", msg: "User added to the board!" });
        if (uid) {
          setLocalMembers((prev) => [...prev, uid]);
          onMemberAdded(uid);
        }
        setTimeout(() => setEmailStatus(null), 3000);
      }
    } catch {
      setEmailStatus({ type: "error", msg: "Something went wrong. Please try again." });
    } finally {
      setAddingEmail(false);
    }
  };

  const handleClose = () => {
    setEmail("");
    setEmailStatus(null);
    setCodeCopied(false);
    onClose();
  };

  const nonMemberFriends = friends.filter((f) => !localMembers.includes(f.uid));
  const memberFriends = friends.filter(
    (f) => localMembers.includes(f.uid) && f.uid !== currentUserId
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.backdrop} onPress={handleClose} />

        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.iconWrap}>
              <Ionicons name="people-outline" size={20} color="#2563eb" />
            </View>
            <Text style={styles.title}>Share Board</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={8}>
              <Ionicons name="close" size={22} color="#666" />
            </TouchableOpacity>
          </View>

          {/* Invite code */}
          <Text style={styles.label}>Invite Code</Text>
          <View style={styles.codeRow}>
            <Text style={styles.codeText}>{inviteCode}</Text>
            <TouchableOpacity style={styles.copyBtn} onPress={handleCopyCode}>
              <Ionicons
                name={codeCopied ? "checkmark" : "copy-outline"}
                size={16}
                color={codeCopied ? "#16a34a" : "#2563eb"}
              />
              <Text style={[styles.copyBtnText, codeCopied && styles.copiedText]}>
                {codeCopied ? "Copied!" : "Copy"}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            Anyone with this code can join the board.
          </Text>

          <ScrollView
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Add by email */}
            <Text style={styles.label}>Add by Email</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={[
                  styles.input,
                  emailStatus?.type === "error" ? styles.inputError : null,
                ]}
                placeholder="Enter email address"
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  setEmailStatus(null);
                }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="send"
                onSubmitEditing={handleAddByEmail}
                editable={!addingEmail}
              />
              <TouchableOpacity
                style={[
                  styles.addBtn,
                  (!email.trim() || addingEmail) && styles.addBtnDisabled,
                ]}
                onPress={handleAddByEmail}
                disabled={!email.trim() || addingEmail}
              >
                {addingEmail ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="person-add" size={16} color="#fff" />
                )}
              </TouchableOpacity>
            </View>
            {emailStatus && (
              <View style={styles.statusRow}>
                <Ionicons
                  name={
                    emailStatus.type === "success"
                      ? "checkmark-circle-outline"
                      : "alert-circle-outline"
                  }
                  size={14}
                  color={emailStatus.type === "success" ? "#16a34a" : "#ef4444"}
                />
                <Text
                  style={[
                    styles.statusText,
                    emailStatus.type === "success"
                      ? styles.successText
                      : styles.errorText,
                  ]}
                >
                  {emailStatus.msg}
                </Text>
              </View>
            )}

            {/* Friends */}
            {loadingFriends ? (
              <ActivityIndicator color="#2563eb" style={styles.spinner} />
            ) : friends.length === 0 ? (
              <Text style={styles.emptyText}>
                No friends yet. Add friends from your Profile to invite them quickly.
              </Text>
            ) : (
              <>
                <Text style={styles.label}>Friends</Text>

                {nonMemberFriends.length === 0 && memberFriends.length === 0 && (
                  <Text style={styles.emptyText}>
                    All your friends are already on this board.
                  </Text>
                )}

                {nonMemberFriends.map((friend) => (
                  <View key={friend.uid} style={styles.friendRow}>
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>
                        {friend.displayName.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.friendInfo}>
                      <Text style={styles.friendName}>{friend.displayName}</Text>
                      <Text style={styles.friendEmail}>{friend.email}</Text>
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.inviteBtn,
                        addingUid === friend.uid && styles.inviteBtnLoading,
                      ]}
                      onPress={() => handleAddFriend(friend)}
                      disabled={!!addingUid}
                    >
                      {addingUid === friend.uid ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.inviteBtnText}>Add</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                ))}

                {memberFriends.map((friend) => (
                  <View key={friend.uid} style={[styles.friendRow, styles.friendRowAdded]}>
                    <View style={[styles.avatar, styles.avatarAdded]}>
                      <Text style={styles.avatarText}>
                        {friend.displayName.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.friendInfo}>
                      <Text style={styles.friendName}>{friend.displayName}</Text>
                      <Text style={styles.friendEmail}>{friend.email}</Text>
                    </View>
                    <View style={styles.addedBadge}>
                      <Ionicons name="checkmark" size={14} color="#16a34a" />
                      <Text style={styles.addedBadgeText}>Added</Text>
                    </View>
                  </View>
                ))}
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: Platform.OS === "ios" ? 40 : 24,
    maxHeight: "80%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    color: "#111",
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#444",
    marginBottom: 6,
    marginTop: 16,
  },
  codeRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#eff6ff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#bfdbfe",
  },
  codeText: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 2,
    color: "#1d4ed8",
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
  },
  copyBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#2563eb",
  },
  copiedText: {
    color: "#16a34a",
  },
  hint: {
    fontSize: 12,
    color: "#9ca3af",
    marginTop: 6,
  },
  scroll: {
    marginTop: 4,
  },
  inputRow: {
    flexDirection: "row",
    gap: 8,
  },
  input: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
    backgroundColor: "#f9fafb",
    color: "#111",
  },
  inputError: {
    borderColor: "#ef4444",
    backgroundColor: "#fff5f5",
  },
  addBtn: {
    width: 46,
    height: 46,
    borderRadius: 10,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
  },
  addBtnDisabled: {
    opacity: 0.5,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
  },
  statusText: {
    fontSize: 12,
    flex: 1,
  },
  errorText: {
    color: "#ef4444",
  },
  successText: {
    color: "#16a34a",
  },
  spinner: {
    marginVertical: 20,
  },
  emptyText: {
    fontSize: 13,
    color: "#9ca3af",
    textAlign: "center",
    marginVertical: 16,
  },
  friendRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  friendRowAdded: {
    backgroundColor: "#f0fdf4",
    borderColor: "#bbf7d0",
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  avatarAdded: {
    backgroundColor: "#16a34a",
  },
  avatarText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  friendInfo: {
    flex: 1,
  },
  friendName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#111827",
  },
  friendEmail: {
    fontSize: 12,
    color: "#6b7280",
  },
  inviteBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: "#2563eb",
    minWidth: 48,
    alignItems: "center",
  },
  inviteBtnLoading: {
    backgroundColor: "#93c5fd",
  },
  inviteBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  addedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#dcfce7",
  },
  addedBadgeText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#16a34a",
  },
});
