import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../hooks/useAuth";
import * as flashcardService from "../../services/flashcardService";
import { CorruptCardError } from "../../services/flashcardService";
import { setClipboardText } from "../../lib/osClipboard";
import type { FlashcardCard } from "../../types";

// Month 6 — the flashcard review surface: the real cost of flashcard
// generation, per the roadmap, is this second app surface, not the AI call.
// Lives under src/components/ with a BARE route (app/decks/[deckId].tsx) —
// screens under app/ can't be render/import-tested in this Jest setup
// (expo-font is unresolvable via @expo/vector-icons, and @firebase/util ships
// ESM the transform doesn't handle), so every gate and every bit of logic
// lives HERE, mirroring ClassroomHome/InstructorCohortGrid's own precedent.
//
// Data source is `flashcardService.getDueCards` — the due-cards query. Only
// due cards are shown; this is a review session, not a browse-all-cards view
// (that's what CSV export, below, is for — it exports the WHOLE deck).

interface FlashcardReviewScreenProps {
  deckId: string;
}

/** SM-2's quality scale is 0-5, but nobody picks a raw integer on a review
 *  screen — Anki itself exposes four buttons. "Again" is the only one below 3
 *  (resets the card, src/lib/sm2.ts); the other three all advance it. */
const QUALITY_BUTTONS: { label: string; quality: number; testId: string }[] = [
  { label: "Again", quality: 0, testId: "quality-again" },
  { label: "Hard", quality: 3, testId: "quality-hard" },
  { label: "Good", quality: 4, testId: "quality-good" },
  { label: "Easy", quality: 5, testId: "quality-easy" },
];

export default function FlashcardReviewScreen({ deckId }: FlashcardReviewScreenProps) {
  const { user } = useAuth();
  const router = useRouter();
  const uid = user?.uid ?? "";

  const [cards, setCards] = useState<FlashcardCard[] | null>(null);
  const [index, setIndex] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!uid || !deckId) return;
    setLoadError(null);
    try {
      const due = await flashcardService.getDueCards(uid, deckId);
      setCards(due);
      setIndex(0);
      setShowBack(false);
    } catch (e: any) {
      setLoadError(e?.message ?? "Couldn't load due cards.");
    }
  }, [uid, deckId]);

  useEffect(() => {
    load();
  }, [load]);

  const current = cards && index < cards.length ? cards[index] : null;

  const advance = () => {
    setShowBack(false);
    setIndex((i) => i + 1);
  };

  const handleQuality = async (quality: number) => {
    if (!current || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await flashcardService.reviewCard(uid, deckId, current.id, quality);
      advance();
    } catch (e: any) {
      // CF-15 — a corrupted card fails closed in the service (it never
      // schedules from a non-finite field). The review session must not stop
      // dead on one bad card: skip it with a visible warning and keep going.
      if (e instanceof CorruptCardError) {
        setMessage(`Skipped a card with corrupted schedule data (${e.field}) — it was not rescheduled.`);
        advance();
      } else {
        setMessage(e?.message ?? "Couldn't save that review. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleExportCsv = async () => {
    setMessage(null);
    try {
      const all = await flashcardService.listCards(uid, deckId);
      if (all.length === 0) {
        setMessage("This deck has no cards to export yet.");
        return;
      }
      const csv = flashcardService.exportDeckToCsv(all);
      const copied = await setClipboardText(csv);
      setMessage(
        copied
          ? "Copied CSV to your clipboard — paste it into a .csv file and import it into Anki."
          : "Couldn't copy the CSV export."
      );
    } catch (e: any) {
      setMessage(e?.message ?? "Couldn't export this deck.");
    }
  };

  if (!uid) {
    return (
      <View style={styles.center} testID="flashcard-review-signed-out">
        <Text style={styles.bodyText}>Sign in to review your flashcards.</Text>
      </View>
    );
  }

  if (cards === null && !loadError) {
    return (
      <View style={styles.center} testID="flashcard-review-loading">
        <ActivityIndicator />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.center} testID="flashcard-review-error">
        <Text style={styles.errorText}>{loadError}</Text>
        <TouchableOpacity style={styles.secondaryButton} onPress={load} testID="retry-load">
          <Text style={styles.secondaryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} testID="flashcard-review-screen">
      <TouchableOpacity onPress={() => router.push("/decks")} testID="back-to-decks">
        <Text style={styles.backLink}>{"< Decks"}</Text>
      </TouchableOpacity>

      {message && (
        <View style={styles.messageBanner} testID="flashcard-review-message">
          <Text style={styles.messageText}>{message}</Text>
        </View>
      )}

      {!current ? (
        <View style={styles.center} testID="flashcard-review-empty">
          <Text style={styles.bodyText}>Nothing due right now. Nice work!</Text>
        </View>
      ) : (
        <View style={styles.card} testID="flashcard-current">
          <Text style={styles.progressText}>
            {index + 1} of {cards!.length} due
          </Text>
          <Text style={styles.cardFront} testID="card-front">
            {current.front}
          </Text>
          {showBack ? (
            <Text style={styles.cardBack} testID="card-back">
              {current.back}
            </Text>
          ) : (
            <TouchableOpacity
              style={styles.showBackButton}
              onPress={() => setShowBack(true)}
              testID="show-back"
            >
              <Text style={styles.showBackButtonText}>Show answer</Text>
            </TouchableOpacity>
          )}

          {showBack && (
            <View style={styles.qualityRow}>
              {QUALITY_BUTTONS.map((q) => (
                <TouchableOpacity
                  key={q.label}
                  style={styles.qualityButton}
                  onPress={() => handleQuality(q.quality)}
                  disabled={busy}
                  testID={q.testId}
                >
                  <Text style={styles.qualityButtonText}>{q.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}

      <TouchableOpacity style={styles.secondaryButton} onPress={handleExportCsv} testID="export-csv">
        <Text style={styles.secondaryButtonText}>Export deck as CSV</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    gap: 16,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  bodyText: {
    fontSize: 15,
    color: "#374151",
    textAlign: "center",
  },
  errorText: {
    fontSize: 15,
    color: "#b91c1c",
    textAlign: "center",
  },
  backLink: {
    fontSize: 14,
    color: "#2563eb",
    fontWeight: "600",
  },
  messageBanner: {
    backgroundColor: "#eff6ff",
    borderRadius: 8,
    padding: 10,
  },
  messageText: {
    fontSize: 13,
    color: "#1d4ed8",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 24,
    gap: 16,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  progressText: {
    fontSize: 12,
    color: "#6b7280",
  },
  cardFront: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0f172a",
  },
  cardBack: {
    fontSize: 17,
    color: "#374151",
  },
  showBackButton: {
    alignSelf: "flex-start",
    backgroundColor: "#2563eb",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  showBackButtonText: {
    color: "#fff",
    fontWeight: "600",
  },
  qualityRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  qualityButton: {
    backgroundColor: "#f3f4f6",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  qualityButtonText: {
    fontWeight: "600",
    color: "#111827",
  },
  secondaryButton: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: "#f3f4f6",
  },
  secondaryButtonText: {
    fontWeight: "600",
    color: "#374151",
  },
});
