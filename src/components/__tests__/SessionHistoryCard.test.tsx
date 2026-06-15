jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import SessionHistoryCard from "../session/SessionHistoryCard";
import type { Session } from "../../types";

const baseSession: Session = {
  id: "sess-1",
  workspaceId: "ws-1",
  boardId: "board-1",
  boardTitle: "Algorithms",
  title: "Midterm Review",
  description: "",
  scheduledAt: new Date("2026-03-01T15:00:00Z"),
  durationMinutes: 45,
  createdById: "u1",
  createdByName: "Arlo",
  participantIds: ["u2", "u3"],
  status: "ended",
  endedAt: new Date("2026-03-01T16:00:00Z"),
  startedAt: new Date("2026-03-01T15:00:00Z"),
  createdAt: new Date("2026-02-28T00:00:00Z"),
};

describe("SessionHistoryCard", () => {
  it("renders title, board, real elapsed duration, and attendee count", () => {
    render(<SessionHistoryCard session={baseSession} onPress={() => {}} />);

    expect(screen.getByText("Midterm Review")).toBeTruthy();
    expect(screen.getByText("Algorithms")).toBeTruthy();
    // startedAt → endedAt is 1h, overriding the 45m planned duration.
    expect(screen.getByText("1h")).toBeTruthy();
    // creator + 2 invited when no frozen snapshot exists.
    expect(screen.getByText("3 people")).toBeTruthy();
  });

  it("prefers the frozen participant snapshot for the attendee count", () => {
    render(
      <SessionHistoryCard
        session={{
          ...baseSession,
          participants: [{ uid: "u1", displayName: "Arlo", email: "" }],
        }}
        onPress={() => {}}
      />
    );
    expect(screen.getByText("1 person")).toBeTruthy();
  });

  it("renders the summary when present and a placeholder when absent", () => {
    const { rerender } = render(
      <SessionHistoryCard
        session={{ ...baseSession, summary: "We covered dynamic programming." }}
        onPress={() => {}}
      />
    );
    expect(screen.getByText("We covered dynamic programming.")).toBeTruthy();

    rerender(<SessionHistoryCard session={baseSession} onPress={() => {}} />);
    expect(screen.getByText("No summary")).toBeTruthy();
  });

  it("fires onPress when tapped", () => {
    const onPress = jest.fn();
    render(<SessionHistoryCard session={baseSession} onPress={onPress} />);
    fireEvent.press(screen.getByText("Midterm Review"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
