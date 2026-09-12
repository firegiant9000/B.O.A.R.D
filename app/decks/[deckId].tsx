import React from "react";
import { useLocalSearchParams } from "expo-router";
import FlashcardReviewScreen from "../../src/components/study/FlashcardReviewScreen";

// Month 6 — flashcard review entry point (task 30). Deliberately a BARE
// route: every gate and every bit of logic lives in FlashcardReviewScreen
// (src/components/study/) or flashcardService, never here — screens under
// app/ can't be render/import-tested in this Jest setup (expo-font is
// unresolvable via @expo/vector-icons, and @firebase/util ships ESM the
// transform doesn't handle), mirroring app/class/[id].tsx's own header.
export default function DeckReviewScreen() {
  const { deckId } = useLocalSearchParams<{ deckId: string }>();
  return <FlashcardReviewScreen deckId={deckId ?? ""} />;
}
