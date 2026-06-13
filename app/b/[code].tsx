import { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { getBoardByInviteCode } from "../../src/services/boardService";

/**
 * Universal Link (iOS) / App Link (Android) landing route for
 * `https://<domain>/b/{inviteCode}` (and the in-app equivalent). Resolves the
 * invite code to a board, then hands off to `/board/{id}`, whose existing
 * membership gate prompts the viewer to join if they aren't a member yet. Shows a
 * clean error if the code is invalid. The deep-link contract lives in
 * `src/lib/deepLinks.ts`.
 */
export default function InviteLandingScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!code) {
        setNotFound(true);
        return;
      }
      try {
        const board = await getBoardByInviteCode(code);
        if (cancelled) return;
        if (board) {
          router.replace(`/board/${board.id}`);
        } else {
          setNotFound(true);
        }
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (notFound) {
    return (
      <View style={styles.centered}>
        <Ionicons name="unlink-outline" size={40} color="#9ca3af" />
        <Text style={styles.title}>Invalid invite link</Text>
        <Text style={styles.subtitle}>
          This board link is broken or the board no longer exists.
        </Text>
        <TouchableOpacity style={styles.button} onPress={() => router.replace("/(tabs)")}>
          <Text style={styles.buttonText}>Go to my boards</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.centered}>
      <ActivityIndicator size="large" color="#2563eb" />
      <Text style={styles.subtitle}>Opening shared board…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
    gap: 12,
    backgroundColor: "#fff",
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111",
  },
  subtitle: {
    fontSize: 14,
    color: "#6b7280",
    textAlign: "center",
  },
  button: {
    marginTop: 12,
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  buttonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
});
