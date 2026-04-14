import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
  ScrollView,
  TextInput,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/hooks/useAuth";
import { FriendRequest } from "../../src/types";
import * as friendService from "../../src/services/friendService";
import * as aiService from "../../src/services/aiService";

export default function ProfileScreen() {
  const { userProfile, user, signOut } = useAuth();

  const [pendingRequests, setPendingRequests] = useState<FriendRequest[]>([]);
  const [friends, setFriends] = useState<FriendRequest[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Add friend by email
  const [addEmail, setAddEmail] = useState("");
  const [addingFriend, setAddingFriend] = useState(false);
  const [showAddInput, setShowAddInput] = useState(false);

  // AI settings
  const [aiKey, setAiKey] = useState(aiService.getOpenAIKey() ?? "");
  const [aiKeySaved, setAiKeySaved] = useState(!!aiService.getOpenAIKey());

  const fetchFriends = useCallback(async () => {
    if (!user) return;
    try {
      const [pending, accepted] = await Promise.all([
        friendService.getPendingRequests(user.uid),
        friendService.getFriends(user.uid),
      ]);
      setPendingRequests(pending);
      setFriends(accepted);
    } catch {
      // Silent fail — friends are non-critical
    } finally {
      setLoadingFriends(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => {
    fetchFriends();
  }, [fetchFriends]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchFriends();
  };

  const doSignOut = async () => {
    try {
      await signOut();
    } catch (error: any) {
      Alert.alert("Error", error.message ?? "Failed to sign out.");
    }
  };

  const handleSignOut = () => {
    if (Platform.OS === "web") {
      if (window.confirm("Are you sure you want to sign out?")) {
        doSignOut();
      }
    } else {
      Alert.alert("Sign Out", "Are you sure you want to sign out?", [
        { text: "Cancel", style: "cancel" },
        { text: "Sign Out", style: "destructive", onPress: doSignOut },
      ]);
    }
  };

  const handleAddFriend = async () => {
    const email = addEmail.trim().toLowerCase();
    if (!email || !user || !userProfile) return;
    setAddingFriend(true);
    try {
      const result = await friendService.sendFriendRequest(
        user.uid,
        userProfile.displayName,
        userProfile.email,
        email
      );
      setAddEmail("");
      setShowAddInput(false);
      const messages: Record<string, string> = {
        sent: "Friend request sent!",
        not_found: "No user found with that email.",
        already_friends: "You are already friends with this user.",
        pending: "A friend request is already pending with this user.",
        self: "You cannot add yourself as a friend.",
      };
      Alert.alert(
        result === "sent" ? "Success" : "Notice",
        messages[result] ?? "Something went wrong."
      );
    } catch {
      Alert.alert("Error", "Failed to send friend request.");
    } finally {
      setAddingFriend(false);
    }
  };

  const handleRespondToRequest = async (requestId: string, accept: boolean, name: string) => {
    try {
      await friendService.respondToFriendRequest(requestId, accept);
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
      if (accept) {
        fetchFriends(); // Refresh friends list to show the new friend
        Alert.alert("Friends!", `You and ${name} are now friends.`);
      }
    } catch {
      Alert.alert("Error", "Failed to respond to request.");
    }
  };

  function getFriendName(req: FriendRequest): string {
    return req.fromId === user?.uid ? req.toDisplayName : req.fromDisplayName;
  }

  function getFriendEmail(req: FriendRequest): string {
    return req.fromId === user?.uid ? req.toEmail : req.fromEmail;
  }

  const initials = (name: string) => name.charAt(0).toUpperCase();

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      {/* Avatar & identity */}
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>
          {initials(userProfile?.displayName ?? user?.email ?? "?")}
        </Text>
      </View>
      <Text style={styles.name}>{userProfile?.displayName ?? "User"}</Text>
      <Text style={styles.email}>{user?.email ?? ""}</Text>

      <View style={styles.infoCard}>
        <Text style={styles.infoLabel}>Member since</Text>
        <Text style={styles.infoValue}>
          {userProfile?.createdAt ? userProfile.createdAt.toLocaleDateString() : "—"}
        </Text>
      </View>

      {/* ── Friends section ── */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Friends</Text>
          <TouchableOpacity
            style={styles.addFriendBtn}
            onPress={() => setShowAddInput((v) => !v)}
          >
            <Ionicons name={showAddInput ? "close" : "person-add-outline"} size={18} color="#2563eb" />
            <Text style={styles.addFriendBtnText}>{showAddInput ? "Cancel" : "Add Friend"}</Text>
          </TouchableOpacity>
        </View>

        {showAddInput && (
          <View style={styles.addFriendRow}>
            <TextInput
              style={styles.emailInput}
              placeholder="Enter email address"
              value={addEmail}
              onChangeText={setAddEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="send"
              onSubmitEditing={handleAddFriend}
              editable={!addingFriend}
            />
            <TouchableOpacity
              style={[styles.sendBtn, addingFriend && styles.sendBtnDisabled]}
              onPress={handleAddFriend}
              disabled={addingFriend}
            >
              {addingFriend ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="send" size={16} color="#fff" />
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* Pending incoming requests */}
        {pendingRequests.length > 0 && (
          <View style={styles.subsection}>
            <Text style={styles.subsectionTitle}>Pending Requests</Text>
            {pendingRequests.map((req) => (
              <View key={req.id} style={styles.requestRow}>
                <View style={styles.requestAvatar}>
                  <Text style={styles.requestAvatarText}>
                    {initials(req.fromDisplayName)}
                  </Text>
                </View>
                <View style={styles.requestInfo}>
                  <Text style={styles.requestName}>{req.fromDisplayName}</Text>
                  <Text style={styles.requestEmail}>{req.fromEmail}</Text>
                </View>
                <View style={styles.requestActions}>
                  <TouchableOpacity
                    style={styles.acceptBtn}
                    onPress={() => handleRespondToRequest(req.id, true, req.fromDisplayName)}
                  >
                    <Ionicons name="checkmark" size={18} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.rejectBtn}
                    onPress={() => handleRespondToRequest(req.id, false, req.fromDisplayName)}
                  >
                    <Ionicons name="close" size={18} color="#ef4444" />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Friends list */}
        {loadingFriends ? (
          <ActivityIndicator color="#2563eb" style={styles.spinner} />
        ) : friends.length === 0 && pendingRequests.length === 0 ? (
          <View style={styles.emptyFriends}>
            <Ionicons name="people-outline" size={36} color="#d1d5db" />
            <Text style={styles.emptyFriendsText}>No friends yet</Text>
            <Text style={styles.emptyFriendsSubtext}>
              Add friends by email or tap their icon on a shared board
            </Text>
          </View>
        ) : (
          friends.map((req) => {
            const name = getFriendName(req);
            return (
              <View key={req.id} style={styles.friendRow}>
                <View style={styles.friendAvatar}>
                  <Text style={styles.friendAvatarText}>{initials(name)}</Text>
                </View>
                <View style={styles.friendInfo}>
                  <Text style={styles.friendName}>{name}</Text>
                  <Text style={styles.friendSince}>
                    {getFriendEmail(req)} · Since {req.createdAt.toLocaleDateString()}
                  </Text>
                </View>
                <Ionicons name="people" size={18} color="#16a34a" />
              </View>
            );
          })
        )}
      </View>

      {/* ── AI Settings section ── */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>AI Settings</Text>
          <View style={[styles.aiBadge, aiKeySaved ? styles.aiBadgeActive : styles.aiBadgeInactive]}>
            <Ionicons
              name={aiKeySaved ? "checkmark-circle" : "alert-circle-outline"}
              size={14}
              color={aiKeySaved ? "#16a34a" : "#9ca3af"}
            />
            <Text style={[styles.aiBadgeText, aiKeySaved ? styles.aiBadgeTextActive : styles.aiBadgeTextInactive]}>
              {aiKeySaved ? "Configured" : "Not set"}
            </Text>
          </View>
        </View>
        <Text style={styles.aiHint}>
          Enter your OpenAI API key to enable AI-generated session summaries.
        </Text>
        <View style={styles.addFriendRow}>
          <TextInput
            style={styles.emailInput}
            placeholder="sk-..."
            value={aiKey}
            onChangeText={(text) => {
              setAiKey(text);
              setAiKeySaved(false);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <TouchableOpacity
            style={[styles.sendBtn, !aiKey.trim() && styles.sendBtnDisabled]}
            onPress={() => {
              const trimmed = aiKey.trim();
              if (!trimmed) return;
              aiService.setOpenAIKey(trimmed);
              setAiKeySaved(true);
              Alert.alert("Saved", "OpenAI API key has been configured for this session.");
            }}
            disabled={!aiKey.trim()}
          >
            <Ionicons name="checkmark" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Sign out */}
      <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: "#fff",
  },
  container: {
    alignItems: "center",
    paddingTop: 48,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  avatarText: {
    color: "#fff",
    fontSize: 32,
    fontWeight: "bold",
  },
  name: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 4,
  },
  email: {
    fontSize: 16,
    color: "#666",
    marginBottom: 24,
  },
  infoCard: {
    width: "100%",
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  infoLabel: {
    fontSize: 14,
    color: "#888",
  },
  infoValue: {
    fontSize: 14,
    fontWeight: "600",
  },
  // ── Friends ──
  section: {
    width: "100%",
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
  },
  addFriendBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2563eb",
  },
  addFriendBtnText: {
    color: "#2563eb",
    fontSize: 13,
    fontWeight: "600",
  },
  addFriendRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
  },
  emailInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    backgroundColor: "#f9fafb",
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnDisabled: {
    opacity: 0.6,
  },
  subsection: {
    marginBottom: 12,
  },
  subsectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  requestRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fffbeb",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#fde68a",
  },
  requestAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#d97706",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  requestAvatarText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  requestInfo: {
    flex: 1,
  },
  requestName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#111827",
  },
  requestEmail: {
    fontSize: 12,
    color: "#6b7280",
  },
  requestActions: {
    flexDirection: "row",
    gap: 6,
  },
  acceptBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: "#16a34a",
    justifyContent: "center",
    alignItems: "center",
  },
  rejectBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: "#fee2e2",
    justifyContent: "center",
    alignItems: "center",
  },
  spinner: {
    marginVertical: 20,
  },
  emptyFriends: {
    alignItems: "center",
    paddingVertical: 24,
    gap: 6,
  },
  emptyFriendsText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#9ca3af",
  },
  emptyFriendsSubtext: {
    fontSize: 13,
    color: "#d1d5db",
    textAlign: "center",
  },
  friendRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f0fdf4",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#bbf7d0",
  },
  friendAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  friendAvatarText: {
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
  friendSince: {
    fontSize: 12,
    color: "#6b7280",
  },
  // ── AI Settings ──
  aiBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  aiBadgeActive: {
    backgroundColor: "#dcfce7",
  },
  aiBadgeInactive: {
    backgroundColor: "#f3f4f6",
  },
  aiBadgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
  aiBadgeTextActive: {
    color: "#16a34a",
  },
  aiBadgeTextInactive: {
    color: "#9ca3af",
  },
  aiHint: {
    fontSize: 13,
    color: "#6b7280",
    marginBottom: 12,
    lineHeight: 18,
  },
  // ── Sign out ──
  signOutButton: {
    width: "100%",
    borderWidth: 1,
    borderColor: "#ef4444",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  signOutText: {
    color: "#ef4444",
    fontSize: 16,
    fontWeight: "600",
  },
});
