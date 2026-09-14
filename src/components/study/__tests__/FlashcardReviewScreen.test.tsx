const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: mockPush })),
}));

jest.mock("../../../hooks/useAuth", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../../../services/flashcardService", () => {
  class CorruptCardError extends Error {
    field: string;
    constructor(field: string) {
      super("corrupt " + field);
      this.name = "CorruptCardError";
      this.field = field;
    }
  }
  return {
    getDueCards: jest.fn(),
    reviewCard: jest.fn(),
    listCards: jest.fn(),
    exportDeckToCsv: jest.fn(() => "front,back"),
    CorruptCardError,
  };
});

jest.mock("../../../lib/osClipboard", () => ({
  setClipboardText: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import FlashcardReviewScreen from "../FlashcardReviewScreen";
import { useAuth } from "../../../hooks/useAuth";
import * as flashcardService from "../../../services/flashcardService";
import { CorruptCardError } from "../../../services/flashcardService";
import { setClipboardText } from "../../../lib/osClipboard";
import type { FlashcardCard } from "../../../types";

const mockUseAuth = useAuth as jest.Mock;
const mockGetDueCards = flashcardService.getDueCards as jest.Mock;
const mockReviewCard = flashcardService.reviewCard as jest.Mock;
const mockListCards = flashcardService.listCards as jest.Mock;
const mockExportDeckToCsv = flashcardService.exportDeckToCsv as jest.Mock;
const mockSetClipboardText = setClipboardText as jest.Mock;

function makeCard(overrides: Partial<FlashcardCard> = {}): FlashcardCard {
  return {
    id: "card1",
    schemaVersion: 1,
    front: "What is 2+2?",
    back: "4",
    repetitions: 0,
    intervalDays: 0,
    easeFactor: 2.5,
    dueAtMs: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAuth.mockReturnValue({ user: { uid: "u1" } });
  mockListCards.mockResolvedValue([]);
  mockSetClipboardText.mockResolvedValue(true);
});

describe("FlashcardReviewScreen", () => {
  it("prompts sign-in when there is no user, and never calls the service", () => {
    mockUseAuth.mockReturnValue({ user: null });
    render(<FlashcardReviewScreen deckId="deck1" />);
    expect(screen.getByTestId("flashcard-review-signed-out")).toBeTruthy();
    expect(mockGetDueCards).not.toHaveBeenCalled();
  });

  it("shows a loading state before due cards resolve", async () => {
    let resolveDue: (v: FlashcardCard[]) => void = () => {};
    mockGetDueCards.mockReturnValue(new Promise((r) => (resolveDue = r)));

    render(<FlashcardReviewScreen deckId="deck1" />);
    expect(screen.getByTestId("flashcard-review-loading")).toBeTruthy();

    resolveDue([]);
    await waitFor(() => expect(screen.getByTestId("flashcard-review-empty")).toBeTruthy());
  });

  it("queries due cards for the given deck", async () => {
    mockGetDueCards.mockResolvedValue([]);
    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(mockGetDueCards).toHaveBeenCalledWith("u1", "deck1"));
  });

  it("shows the empty state when nothing is due", async () => {
    mockGetDueCards.mockResolvedValue([]);
    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(screen.getByTestId("flashcard-review-empty")).toBeTruthy());
  });

  it("shows a load error with a retry that re-queries", async () => {
    mockGetDueCards.mockRejectedValueOnce(new Error("offline"));
    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(screen.getByTestId("flashcard-review-error")).toBeTruthy());

    mockGetDueCards.mockResolvedValueOnce([]);
    fireEvent.press(screen.getByTestId("retry-load"));
    await waitFor(() => expect(screen.getByTestId("flashcard-review-empty")).toBeTruthy());
    expect(mockGetDueCards).toHaveBeenCalledTimes(2);
  });

  it("shows the front but not the back until 'Show answer' is pressed", async () => {
    mockGetDueCards.mockResolvedValue([makeCard()]);
    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(screen.getByTestId("card-front")).toBeTruthy());

    expect(screen.getByText("What is 2+2?")).toBeTruthy();
    expect(screen.queryByTestId("card-back")).toBeNull();
    expect(screen.queryByTestId("quality-good")).toBeNull();

    fireEvent.press(screen.getByTestId("show-back"));
    expect(screen.getByTestId("card-back")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByTestId("quality-good")).toBeTruthy();
  });

  it("reviews the current card with the pressed quality and advances to the next", async () => {
    mockGetDueCards.mockResolvedValue([
      makeCard({ id: "card1", front: "Q1" }),
      makeCard({ id: "card2", front: "Q2" }),
    ]);
    mockReviewCard.mockResolvedValue({ repetitions: 1, intervalDays: 1, easeFactor: 2.5, dueAtMs: 86_400_000 });

    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(screen.getByText("Q1")).toBeTruthy());

    fireEvent.press(screen.getByTestId("show-back"));
    fireEvent.press(screen.getByTestId("quality-good"));

    await waitFor(() => expect(mockReviewCard).toHaveBeenCalledWith("u1", "deck1", "card1", 4));
    await waitFor(() => expect(screen.getByText("Q2")).toBeTruthy());
    // Advancing must reset back to the front-only state for the new card.
    expect(screen.queryByTestId("card-back")).toBeNull();
  });

  it.each([
    ["quality-again", (q: number) => expect(q).toBeLessThan(3)],
    ["quality-hard", (q: number) => expect(q).toBeGreaterThanOrEqual(3)],
    ["quality-good", (q: number) => expect(q).toBeGreaterThanOrEqual(3)],
    ["quality-easy", (q: number) => expect(q).toBeGreaterThanOrEqual(3)],
  ])("pressing %s sends the quality SM-2 expects (below 3 only resets a card)", async (testId, assertQuality) => {
    mockGetDueCards.mockResolvedValue([makeCard()]);
    mockReviewCard.mockResolvedValue({ repetitions: 0, intervalDays: 1, easeFactor: 2.0, dueAtMs: 86_400_000 });
    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(screen.getByTestId("card-front")).toBeTruthy());
    fireEvent.press(screen.getByTestId("show-back"));
    fireEvent.press(screen.getByTestId(testId));
    await waitFor(() => expect(mockReviewCard).toHaveBeenCalled());
    const quality = mockReviewCard.mock.calls[0][3];
    assertQuality(quality);
  });

  it("CF-15 — skips a corrupted card with a visible warning instead of crashing, and still advances", async () => {
    mockGetDueCards.mockResolvedValue([
      makeCard({ id: "card1", front: "Corrupt" }),
      makeCard({ id: "card2", front: "Fine" }),
    ]);
    mockReviewCard.mockRejectedValueOnce(new CorruptCardError("easeFactor"));

    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(screen.getByText("Corrupt")).toBeTruthy());

    fireEvent.press(screen.getByTestId("show-back"));
    fireEvent.press(screen.getByTestId("quality-good"));

    await waitFor(() => expect(screen.getByTestId("flashcard-review-message")).toBeTruthy());
    expect(screen.getByText(/corrupted schedule data \(easeFactor\)/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Fine")).toBeTruthy());
  });

  it("surfaces a non-corruption review failure as a message without advancing", async () => {
    mockGetDueCards.mockResolvedValue([makeCard({ id: "card1", front: "Q1" })]);
    mockReviewCard.mockRejectedValueOnce(new Error("network down"));

    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(screen.getByText("Q1")).toBeTruthy());
    fireEvent.press(screen.getByTestId("show-back"));
    fireEvent.press(screen.getByTestId("quality-good"));

    await waitFor(() => expect(screen.getByText("network down")).toBeTruthy());
    // Did NOT advance — still on the same (only) card, front visible again.
    expect(screen.getByText("Q1")).toBeTruthy();
  });

  it("exports the whole deck as CSV via the clipboard, not just the due cards", async () => {
    mockGetDueCards.mockResolvedValue([]);
    mockListCards.mockResolvedValue([
      { front: "A", back: "B" },
      { front: "C", back: "D" },
    ]);
    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(screen.getByTestId("flashcard-review-empty")).toBeTruthy());

    fireEvent.press(screen.getByTestId("export-csv"));

    await waitFor(() => expect(mockListCards).toHaveBeenCalledWith("u1", "deck1"));
    expect(mockExportDeckToCsv).toHaveBeenCalledWith([
      { front: "A", back: "B" },
      { front: "C", back: "D" },
    ]);
    await waitFor(() => expect(mockSetClipboardText).toHaveBeenCalledWith("front,back"));
    await waitFor(() => expect(screen.getByText(/copied csv/i)).toBeTruthy());
  });

  it("tells the user when there is nothing to export", async () => {
    mockGetDueCards.mockResolvedValue([]);
    mockListCards.mockResolvedValue([]);
    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(screen.getByTestId("flashcard-review-empty")).toBeTruthy());

    fireEvent.press(screen.getByTestId("export-csv"));
    await waitFor(() => expect(screen.getByText(/no cards to export/i)).toBeTruthy());
    expect(mockExportDeckToCsv).not.toHaveBeenCalled();
  });

  it("navigates back to the decks list", async () => {
    mockGetDueCards.mockResolvedValue([]);
    render(<FlashcardReviewScreen deckId="deck1" />);
    await waitFor(() => expect(screen.getByTestId("flashcard-review-empty")).toBeTruthy());
    fireEvent.press(screen.getByTestId("back-to-decks"));
    expect(mockPush).toHaveBeenCalledWith("/decks");
  });
});
