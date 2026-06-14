import { useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { addMemberByEmail } from "../services/workspaceService";

interface InviteMemberModalProps {
  visible: boolean;
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  /** Called after a member is successfully added (parent re-fetches). */
  onInvited: () => void;
}

export default function InviteMemberModal({
  visible,
  workspaceId,
  workspaceName,
  onClose,
  onInvited,
}: InviteMemberModalProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reset = () => {
    setEmail("");
    setError(null);
    setSuccess(null);
    setLoading(false);
  };

  const handleClose = () => {
    if (loading) return;
    reset();
    onClose();
  };

  const handleInvite = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Please enter an email address.");
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const { result } = await addMemberByEmail(workspaceId, trimmed);
      if (result === "not_found") {
        setError("No B.O.A.R.D account found with that email.");
      } else if (result === "already_member") {
        setError("That person is already a member of this workspace.");
      } else {
        setSuccess(`Added ${trimmed} to the workspace.`);
        setEmail("");
        onInvited();
      }
    } catch (err: any) {
      setError(err.message ?? "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

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
          <View style={styles.header}>
            <View style={styles.iconWrap}>
              <Ionicons name="person-add-outline" size={20} color="#2563eb" />
            </View>
            <Text style={styles.title}>Invite to Workspace</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={8}>
              <Ionicons name="close" size={22} color="#666" />
            </TouchableOpacity>
          </View>

          <Text style={styles.subtitle} numberOfLines={2}>
            Add a member to "{workspaceName}" by their account email.
          </Text>

          <Text style={styles.label}>Email Address</Text>
          <TextInput
            style={[styles.input, error ? styles.inputError : null]}
            placeholder="classmate@school.edu"
            placeholderTextColor="#bbb"
            value={email}
            onChangeText={(t) => {
              setError(null);
              setSuccess(null);
              setEmail(t);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={handleInvite}
          />

          {error && (
            <View style={styles.msgRow}>
              <Ionicons name="alert-circle-outline" size={14} color="#ef4444" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
          {success && (
            <View style={styles.msgRow}>
              <Ionicons
                name="checkmark-circle-outline"
                size={14}
                color="#16a34a"
              />
              <Text style={styles.successText}>{success}</Text>
            </View>
          )}

          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={handleClose}
              disabled={loading}
              activeOpacity={0.7}
            >
              <Text style={styles.cancelText}>Done</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.inviteButton,
                (!email.trim() || loading) && styles.inviteButtonDisabled,
              ]}
              onPress={handleInvite}
              disabled={!email.trim() || loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.inviteText}>Invite</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
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
  },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  title: { flex: 1, fontSize: 18, fontWeight: "700", color: "#111" },
  subtitle: { fontSize: 13, color: "#888", marginBottom: 20 },
  label: { fontSize: 13, fontWeight: "600", color: "#444", marginBottom: 6 },
  input: {
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: "#111",
    backgroundColor: "#f9fafb",
  },
  inputError: { borderColor: "#ef4444", backgroundColor: "#fff5f5" },
  msgRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
  },
  errorText: { fontSize: 12, color: "#ef4444", flex: 1 },
  successText: { fontSize: 12, color: "#16a34a", flex: 1 },
  actions: { flexDirection: "row", gap: 12, marginTop: 24 },
  cancelButton: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  cancelText: { fontSize: 15, fontWeight: "600", color: "#666" },
  inviteButton: {
    flex: 2,
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  inviteButtonDisabled: { backgroundColor: "#93c5fd" },
  inviteText: { fontSize: 15, fontWeight: "700", color: "#fff" },
});
