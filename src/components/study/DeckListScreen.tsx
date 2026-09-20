import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  FlatList,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../hooks/useAuth";
import * as flashcardService from "../../services/flashcardService";
import type { FlashcardDeck } from "../../types";

// Month 6 — the flashcard decks list. This + FlashcardReviewScreen are what
// make `generateFlashcards`/the review surface actually REACHABLE: a card
// generated from the board (useBoardAI's "Make flashcards" affordance) lands
// in a per-board deck, and THIS screen (Profile → "Flashcard decks") is where
// a user comes back to study it later. Bare route: app/decks/index.tsx.

export default function DeckListScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const uid = user?.uid ?? "";

  const [decks, setDecks] = useState<FlashcardDeck[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newDeckName, setNewDeckName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!uid) return;
    setLoadError(null);
    try {
      setDecks(await flashcardService.listDecks(uid));
    } catch (e: any) {
      setLoadError(e?.message ?? "Couldn't load your decks.");
    }
  }, [uid]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    const name = newDeckName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const id = await flashcardService.createDeck(uid, name);
      setNewDeckName("");
      await load();
      router.push(`/decks/${id}`);
    } catch (e: any) {
      setLoadError(e?.message ?? "Couldn't create that deck.");
    } finally {
      setCreating(false);
    }
  };

  if (!uid) {
    return (
      <View style={styles.center} testID="deck-list-signed-out">
        <Text style={styles.bodyText}>Sign in to see your flashcard decks.</Text>
      </View>
    );
  }

  if (decks === null && !loadError) {
    return (
      <View style={styles.center} testID="deck-list-loading">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.container} testID="deck-list-screen">
      <Text style={styles.title}>Flashcard decks</Text>

      {loadError && <Text style={styles.errorText}>{loadError}</Text>}

      {decks && decks.length === 0 ? (
        <Text style={styles.bodyText} testID="deck-list-empty">
          No decks yet. Generate flashcards from a board selection, or create one below.
        </Text>
      ) : (
        <FlatList
          data={decks ?? []}
          keyExtractor={(d) => d.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.deckRow}
              onPress={() => router.push(`/decks/${item.id}`)}
              testID={`deck-row-${item.id}`}
            >
              <Text style={styles.deckName}>{item.name}</Text>
            </TouchableOpacity>
          )}
        />
      )}

      <View style={styles.newDeckRow}>
        <TextInput
          style={styles.input}
          placeholder="New deck name"
          value={newDeckName}
          onChangeText={setNewDeckName}
          testID="new-deck-name"
        />
        <TouchableOpacity
          style={styles.createButton}
          onPress={handleCreate}
          disabled={creating || !newDeckName.trim()}
          testID="create-deck"
        >
          <Text style={styles.createButtonText}>{creating ? "..." : "Create"}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    gap: 12,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: "#0f172a",
  },
  bodyText: {
    fontSize: 14,
    color: "#374151",
  },
  errorText: {
    fontSize: 13,
    color: "#b91c1c",
  },
  deckRow: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    marginBottom: 8,
  },
  deckName: {
    fontSize: 15,
    fontWeight: "600",
    color: "#0f172a",
  },
  newDeckRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  createButton: {
    backgroundColor: "#2563eb",
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  createButtonText: {
    color: "#fff",
    fontWeight: "600",
  },
});
