import React from "react";
import DeckListScreen from "../../src/components/study/DeckListScreen";

// Month 6 — flashcard decks entry point. Deliberately a BARE route:
// every gate and every bit of data-fetching logic lives in DeckListScreen
// (src/components/study/) or flashcardService, never here — same reasoning
// as app/classes.tsx's own header (screens under app/ can't be
// render/import-tested in this Jest setup).
export default function DecksScreen() {
  return <DeckListScreen />;
}
