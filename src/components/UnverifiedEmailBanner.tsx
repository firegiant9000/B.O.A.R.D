import { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../hooks/useAuth";
import { showAlert } from "../utils/alerts";

/**
 * Banner prompting the signed-in user to verify their email (Phase 6).
 * Renders nothing when there is no user or the email is already verified.
 */
export default function UnverifiedEmailBanner() {
  const { user, emailVerified, resendVerification, reloadUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const insets = useSafeAreaInsets();

  if (!user || emailVerified) return null;

  const handleResend = async () => {
    setBusy(true);
    try {
      await resendVerification();
      showAlert("Sent", "Verification email sent. Check your inbox.");
    } catch (error: any) {
      showAlert("Error", error.message ?? "Could not send the email.");
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setBusy(true);
    try {
      const verified = await reloadUser();
      if (!verified) {
        showAlert(
          "Not verified yet",
          "We don't see a verification yet. Tap the link in the email, then try again."
        );
      }
    } catch (error: any) {
      showAlert("Error", error.message ?? "Could not refresh.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.banner, { paddingTop: insets.top + 10 }]}>
      <Ionicons name="mail-unread-outline" size={16} color="#92400e" />
      <Text style={styles.text}>Verify your email to secure your account.</Text>
      <TouchableOpacity onPress={handleResend} disabled={busy} hitSlop={8}>
        <Text style={styles.action}>Resend</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={handleRefresh} disabled={busy} hitSlop={8}>
        <Text style={styles.action}>I've verified</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fffbeb",
    borderBottomWidth: 1,
    borderBottomColor: "#fde68a",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  text: {
    flex: 1,
    fontSize: 13,
    color: "#92400e",
  },
  action: {
    fontSize: 13,
    fontWeight: "700",
    color: "#2563eb",
  },
});
