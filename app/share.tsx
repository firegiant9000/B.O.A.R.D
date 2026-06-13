import { useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../src/hooks/useAuth";
import { getMemberBoards } from "../src/services/boardService";
import { Board } from "../src/types";
import { takePendingShare, PendingImage } from "../src/lib/pendingShare";
import { prepareNativeImageUri } from "../src/lib/imagePicker";
import { placeSharedItem } from "../src/lib/shareIntake";
import { captureException } from "../src/lib/errorReporting";

/**
 * Share-target board picker (Month 2, Phase 4). Reached when an image is shared
 * INTO B.O.A.R.D from another app (the native receiver in `_layout.tsx` stashes
 * the payload in `pendingShare` and routes here). The user picks a destination
 * board; each shared image is downscaled and placed via the Phase 9 pipeline,
 * then we navigate to that board. Pure-link shares never land here.
 */
export default function ShareTargetScreen() {
  const { user } = useAuth();
  const router = useRouter();
  // Drain the pending payload once, on first render.
  const [images] = useState<PendingImage[]>(() => takePendingShare());
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    getMemberBoards(user.uid)
      .then((b) => !cancelled && setBoards(b))
      .catch((e) => {
        captureException(e, { op: "share.loadBoards" });
        if (!cancelled) setBoards([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  const placeOnBoard = async (board: Board) => {
    if (!user || placingId) return;
    setPlacingId(board.id);
    setError(null);
    try {
      // Place near the board origin; a small cascade keeps a multi-image share
      // from stacking exactly on top of itself. The user can reposition after.
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const prepared = await prepareNativeImageUri(
          img.uri,
          img.width,
          img.height,
          img.name
        );
        const res = await placeSharedItem(board.id, user.uid, prepared, {
          x: i * 24,
          y: i * 24,
        });
        if (!res.placed) throw new Error(res.reason ?? "placement failed");
      }
      router.replace(`/board/${board.id}`);
    } catch (e) {
      captureException(e, { op: "share.place" });
      setPlacingId(null);
      setError("Couldn't add the image to that board. Try again.");
    }
  };

  if (images.length === 0) {
    return (
      <View style={styles.centered}>
        <Ionicons name="share-outline" size={40} color="#9ca3af" />
        <Text style={styles.title}>Nothing to share</Text>
        <Text style={styles.subtitle}>
          Share an image from another app to add it to a board.
        </Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() => router.replace("/(tabs)")}
        >
          <Text style={styles.buttonText}>Go to my boards</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>
        Add {images.length === 1 ? "image" : `${images.length} images`} to…
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {boards === null ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#2563eb" />
        </View>
      ) : boards.length === 0 ? (
        <Text style={styles.subtitle}>
          You don't have any boards yet. Create one first, then share into it.
        </Text>
      ) : (
        <FlatList
          data={boards}
          keyExtractor={(b) => b.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              onPress={() => placeOnBoard(item)}
              disabled={placingId !== null}
            >
              <Ionicons name="easel-outline" size={22} color="#2563eb" />
              <Text style={styles.rowText} numberOfLines={1}>
                {item.title || "Untitled board"}
              </Text>
              {placingId === item.id ? (
                <ActivityIndicator color="#2563eb" />
              ) : (
                <Ionicons name="chevron-forward" size={18} color="#9ca3af" />
              )}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", padding: 16 },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
    gap: 12,
    backgroundColor: "#fff",
  },
  heading: { fontSize: 20, fontWeight: "700", color: "#111", marginBottom: 12 },
  title: { fontSize: 18, fontWeight: "700", color: "#111" },
  subtitle: { fontSize: 14, color: "#6b7280", textAlign: "center" },
  error: { color: "#dc2626", fontSize: 14, marginBottom: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e7eb",
  },
  rowText: { flex: 1, fontSize: 16, color: "#111" },
  button: {
    marginTop: 12,
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
