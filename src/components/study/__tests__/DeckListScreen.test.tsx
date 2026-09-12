const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: mockPush })),
}));

jest.mock("../../../hooks/useAuth", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../../../services/flashcardService", () => ({
  listDecks: jest.fn(),
  createDeck: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import DeckListScreen from "../DeckListScreen";
import { useAuth } from "../../../hooks/useAuth";
import * as flashcardService from "../../../services/flashcardService";

const mockUseAuth = useAuth as jest.Mock;
const mockListDecks = flashcardService.listDecks as jest.Mock;
const mockCreateDeck = flashcardService.createDeck as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAuth.mockReturnValue({ user: { uid: "u1" } });
});

describe("DeckListScreen", () => {
  it("prompts sign-in when there is no user", () => {
    mockUseAuth.mockReturnValue({ user: null });
    render(<DeckListScreen />);
    expect(screen.getByTestId("deck-list-signed-out")).toBeTruthy();
    expect(mockListDecks).not.toHaveBeenCalled();
  });

  it("shows the empty state when the user has no decks", async () => {
    mockListDecks.mockResolvedValue([]);
    render(<DeckListScreen />);
    await waitFor(() => expect(screen.getByTestId("deck-list-empty")).toBeTruthy());
  });

  it("lists the user's decks and navigates to a deck on tap", async () => {
    mockListDecks.mockResolvedValue([
      { id: "deck1", name: "Biology 101", schemaVersion: 1, createdAt: new Date() },
    ]);
    render(<DeckListScreen />);
    await waitFor(() => expect(screen.getByTestId("deck-row-deck1")).toBeTruthy());
    expect(screen.getByText("Biology 101")).toBeTruthy();

    fireEvent.press(screen.getByTestId("deck-row-deck1"));
    expect(mockPush).toHaveBeenCalledWith("/decks/deck1");
  });

  it("creates a new deck through flashcardService and navigates to it", async () => {
    mockListDecks.mockResolvedValue([]);
    mockCreateDeck.mockResolvedValue("newDeck1");
    render(<DeckListScreen />);
    await waitFor(() => expect(screen.getByTestId("deck-list-empty")).toBeTruthy());

    fireEvent.changeText(screen.getByTestId("new-deck-name"), "Chemistry");
    fireEvent.press(screen.getByTestId("create-deck"));

    await waitFor(() => expect(mockCreateDeck).toHaveBeenCalledWith("u1", "Chemistry"));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/decks/newDeck1"));
  });
});
