import { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import BoardScreen from "../../board/[id]";
import { redeemEmbedToken } from "../../../src/services/embedService";
import { captureException } from "../../../src/lib/errorReporting";
import { parseEmbedScope } from "../../../src/lib/embedScope";
import type { EmbedScope } from "../../../src/types";

/**
 * Embeddable board route (Month 4, Phase 8: read-only; Month 5: editable —
 * see docs/functions-deploy-runbook.md's embed sections and web/meet-addon/
 * for the Google Meet add-on that iframes this route): `/embed/b/{boardId}?token=…`.
 *
 * Renders a board inside an external iframe with no login. The signed token in
 * the query is exchanged (via a Cloud Function) for a scoped Firebase identity;
 * on success we render the normal board screen in embed mode (chrome always
 * stripped) and, from Month 5 on, with editing enabled when — and only when —
 * the EXCHANGE itself reports `scope: "edit"`. That response is server-verified
 * (the exchange already checked the token's signature, expiry and issuer
 * allowlist — see functions/src/callable/exchangeEmbedToken.ts), which is why
 * it is the value trusted here rather than anything read from this route's own
 * URL: a query string is caller-controlled and cannot grant a scope the signed
 * token didn't. `parseEmbedScope` is the defensive parse of that response
 * value — see its own doc comment for why "edit" is opt-in, never a default.
 *
 * This route is exempt from the app's auth redirect (see app/_layout.tsx) so an
 * unauthenticated visitor can reach it and drive its own sign-in. An
 * expired/forged token shows a clean error.
 */
export default function EmbedBoardScreen() {
  const { id, token } = useLocalSearchParams<{ id: string; token?: string }>();
  const [status, setStatus] = useState<"redeeming" | "ready" | "error">("redeeming");
  const [errorText, setErrorText] = useState<string>("This embed link is invalid.");
  const [scope, setScope] = useState<EmbedScope>("view");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setErrorText("This embed link is missing its access token.");
        setStatus("error");
        return;
      }
      try {
        const { boardId, scope: exchangedScope } = await redeemEmbedToken(token);
        if (cancelled) return;
        if (boardId !== id) {
          // The token names a different board than the URL path — refuse rather
          // than render the wrong board.
          setErrorText("This embed link does not match the requested board.");
          setStatus("error");
          return;
        }
        setScope(parseEmbedScope(exchangedScope));
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

  // Reuse the full board screen in embed mode: same React tree, chrome always
  // stripped. `id` is already in the route params it reads. `embedScope`
  // (Month 5) is the server-verified scope resolved above; BoardScreen decides
  // what — if anything — that enables.
  return <BoardScreen embedMode embedScope={scope} />;
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
