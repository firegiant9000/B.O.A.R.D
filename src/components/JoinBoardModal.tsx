import { useEffect, useState } from "react";
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
import { joinBoardByCode, JoinBoardResult } from "../services/boardService";

interface JoinBoardModalProps {
  visible: boolean;
  onClose: () => void;
  onJoined: (result: JoinBoardResult) => void;
  /**
   * When provided, the modal enters "deep-link confirmation mode":
   * the code is pre-filled and read-only, and the copy changes to
   * confirm-intent language instead of code-entry language.
   */
  initialCode?: string;
}

export default function JoinBoardModal({
  visible,
  onClose,
  onJoined,
  initialCode,
}: JoinBoardModalProps) {
  const isDeepLink = !!initialCode;

  const [code, setCode] = useState(initialCode ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync when the parent opens the modal with a different initialCode
  useEffect(() => {
    if (initialCode) setCode(initialCode);
  }, [initialCode]);

  const handleChangeCode = (text: string) => {
    setError(null);
    setCode(text.toUpperCase());
  };

  const handleJoin = async () => {
    if (!code.trim()) {
      setError("Please enter an invite code.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await joinBoardByCode(code.trim());
      setCode("");
      onJoined(result);
    } catch (err: any) {
      setError(err.message ?? "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!isDeepLink) setCode("");
    setError(null);
    onClose();
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
        {/* Backdrop — tapping it closes only in manual mode */}
        <Pressable
          style={styles.backdrop}
          onPress={isDeepLink ? undefined : handleClose}
        />

        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.iconWrap}>
              <Ionicons
                name={isDeepLink ? "link-outline" : "enter-outline"}
                size={20}
                color="#2563eb"
              />
            </View>
            <Text style={styles.title}>
              {isDeepLink ? "You've been invited" : "Join a Board"}
            </Text>
            {!isDeepLink && (
              <TouchableOpacity onPress={handleClose} hitSlop={8}>
                <Ionicons name="close" size={22} color="#666" />
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.subtitle}>
            {isDeepLink
              ? "You opened a shared board link. Tap 'Join Board' to become a collaborator."
              : "Ask a collaborator for their board's invite code."}
          </Text>

          {/* Code field */}
          <Text style={styles.label}>Invite Code</Text>
          <TextInput
            style={[
              styles.input,
              isDeepLink && styles.inputReadOnly,
              error ? styles.inputError : null,
            ]}
            placeholder="BORD-XXXXXX"
            placeholderTextColor="#bbb"
            value={code}
            onChangeText={handleChangeCode}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus={!isDeepLink}
            editable={!isDeepLink}
            maxLength={11}
            returnKeyType="done"
            onSubmitEditing={!isDeepLink ? handleJoin : undefined}
          />

          {error && (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle-outline" size={14} color="#ef4444" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* Actions */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={handleClose}
              activeOpacity={0.7}
            >
              <Text style={styles.cancelText}>
                {isDeepLink ? "Go Back" : "Cancel"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.joinButton, loading && styles.joinButtonDisabled]}
              onPress={handleJoin}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.joinButtonText}>Join Board</Text>
              )}
            </TouchableOpacity>
          </View>
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
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
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
  subtitle: {
    fontSize: 13,
    color: "#888",
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#444",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 2,
    color: "#111",
    backgroundColor: "#f9fafb",
  },
  inputReadOnly: {
    backgroundColor: "#eff6ff",
    borderColor: "#bfdbfe",
    color: "#1d4ed8",
  },
  inputError: {
    borderColor: "#ef4444",
    backgroundColor: "#fff5f5",
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
  },
  errorText: {
    fontSize: 12,
    color: "#ef4444",
    flex: 1,
  },
  actions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 24,
  },
  cancelButton: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  cancelText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#666",
  },
  joinButton: {
    flex: 2,
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  joinButtonDisabled: {
    backgroundColor: "#93c5fd",
  },
  joinButtonText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },
});
