import { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { AntDesign } from "@expo/vector-icons";
import { getProvider } from "../services/authProviders";
import { showAlert } from "../utils/alerts";

/**
 * "Continue with Google" button (Phase 11). Renders nothing when the Google
 * provider isn't configured for this build (`isAvailable` false in Expo Go /
 * unconfigured builds), so the auth screens degrade to email-only without changes.
 *
 * On success, navigation is driven by the auth-state listener in AuthContext (which
 * provisions the profile + personal workspace), so this button only runs the flow
 * and surfaces errors. A user-cancelled flow is silent.
 */
export function GoogleSignInButton() {
  const provider = getProvider("google");
  const [loading, setLoading] = useState(false);

  if (!provider.isAvailable) return null;

  const handlePress = async () => {
    setLoading(true);
    try {
      await provider.signIn();
    } catch (error: any) {
      const message = error?.message ?? "An error occurred.";
      // Swallow the explicit cancel — the user knows they backed out.
      if (!/cancel/i.test(message)) {
        showAlert("Google Sign-In Failed", message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.wrapper}>
      <View style={styles.divider}>
        <View style={styles.line} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.line} />
      </View>

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handlePress}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel="Continue with Google"
      >
        {loading ? (
          <ActivityIndicator color="#3c4043" />
        ) : (
          <>
            <AntDesign name="google" size={18} color="#4285F4" />
            <Text style={styles.buttonText}>Continue with Google</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginTop: 8,
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 16,
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: "#e5e7eb",
  },
  dividerText: {
    marginHorizontal: 12,
    color: "#9ca3af",
    fontSize: 14,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: "#dadce0",
    borderRadius: 12,
    padding: 16,
    backgroundColor: "#fff",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#3c4043",
    fontSize: 16,
    fontWeight: "600",
  },
});
