import { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import BoardScreen from "../../board/[id]";
import { redeemEmbedToken } from "../../../src/services/embedService";
import { captureException } from "../../../src/lib/errorReporting";

/**
 * Embeddable board route (Month 4, Phase 8): `/embed/b/{boardId}?token=…`.
 *
 * Renders a read-only board inside an external iframe with no login. The signed
 * token in the query is exchanged (via a Cloud Function) for a scoped, read-only
 * Firebase identity; on success we render the normal board screen in embed mode
 * (chrome stripped, edits disabled). This route is exempt from the app's auth
 * redirect (see app/_layout.tsx) so an unauthenticated visitor can reach it and
 * drive its own sign-in. An expired/forged token shows a clean error.
 */
export default function EmbedBoardScreen() {
  const { id, token } = useLocalSearchParams<{ id: string; token?: string }>();
  const [status, setStatus] = useState<"redeeming" | "ready" | "error">("redeeming");
  const [errorText, setErrorText] = useState<string>("This embed link is invalid.");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setErrorText("This embed link is missing its access token.");
        setStatus("error");
        return;
      }
      try {
        const { boardId } = await redeemEmbedToken(token);
        if (cancelled) return;
        if (boardId !== id) {
          // The token names a different board than the URL path — refuse rather
          // than render the wrong board.
          setErrorText("This embed link does not match the requested board.");
          setStatus("error");
          return;
        }
        setStatus("ready");
      } catch (e: any) {
        if (cancelled) return;
        captureException(e, { op: "embed.redeem" });
        // The function distinguishes expiry from a generic invalid token.
        setErrorText(e?.message ?? "This embed link is invalid.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, token]);

  if (status === "redeeming") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2563eb" />
        <Text style={styles.subtitle}>Loading board…</Text>
      </View>
    );
  }

  if (status === "error") {
    return (
      <View style={styles.centered}>
        <Ionicons name="lock-closed-outline" size={40} color="#9ca3af" />
        <Text style={styles.title}>Can't open this board</Text>
        <Text style={styles.subtitle}>{errorText}</Text>
      </View>
    );
  }

  // Reuse the full board screen in embed mode: same React tree, chrome stripped
  // and editing disabled. `id` is already in the route params it reads.
  return <BoardScreen embedMode />;
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
    padding: 24,
  },
  title: { fontSize: 18, fontWeight: "600", color: "#111827", marginTop: 12 },
  subtitle: { fontSize: 14, color: "#6b7280", marginTop: 6, textAlign: "center" },
});
