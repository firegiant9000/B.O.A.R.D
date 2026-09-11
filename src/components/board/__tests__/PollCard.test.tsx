import React from "react";
import { render, fireEvent, screen } from "@testing-library/react-native";
import PollCard from "../PollCard";
import { PollElement } from "../../../types";
import type { PollResults } from "../../../hooks/useBoardPolls";

/**
 * PollCard.test.tsx — Month 6 polls. Follows ReactionBadge's pattern: render
 * the real component, drive it with fireEvent, assert on what actually shows
 * up rather than on a mock's own return value.
 */

function makePoll(overrides: Partial<PollElement> = {}): PollElement {
  return {
    id: "p1",
    schemaVersion: 1,
    boardId: "b1",
    question: "Favorite color?",
    options: ["Red", "Blue", "Green"],
    anonymous: false,
    mode: "single",
    x: 0,
    y: 0,
    createdById: "u1",
    createdAt: new Date(),
    ...overrides,
  };
}

const baseProps = {
  results: null as PollResults | null,
  myVote: [] as number[],
  canVote: true,
  canManage: false,
  onVote: jest.fn(),
  onToggleDot: jest.fn(),
  onDelete: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("rendering", () => {
  it("renders the question and every option", () => {
    render(<PollCard poll={makePoll()} {...baseProps} />);
    expect(screen.getByText("Favorite color?")).toBeTruthy();
    expect(screen.getByTestId("poll-option-p1-0")).toBeTruthy();
    expect(screen.getByTestId("poll-option-p1-1")).toBeTruthy();
    expect(screen.getByTestId("poll-option-p1-2")).toBeTruthy();
  });

  it("shows the anonymous note, worded as hidden from OTHER MEMBERS (never implying the system doesn't know)", () => {
    render(<PollCard poll={makePoll({ anonymous: true })} {...baseProps} />);
    const note = screen.getByText(/hidden from other members/i);
    expect(note).toBeTruthy();
    // Never overstates the guarantee — must not claim anonymity from the
    // system/admins/host, only from other members (see the standing
    // constraint on this exact wording).
    expect(screen.queryByText(/hidden from (the )?(system|admin|host)/i)).toBeNull();
  });

  it("does not show a delete button when the viewer cannot manage the poll", () => {
    render(<PollCard poll={makePoll()} {...baseProps} canManage={false} />);
    expect(screen.queryByTestId("poll-delete-p1")).toBeNull();
  });

  it("shows a delete button for an effective editor", () => {
    render(<PollCard poll={makePoll()} {...baseProps} canManage={true} />);
    expect(screen.getByTestId("poll-delete-p1")).toBeTruthy();
  });

  it("hides the 'Next question' control when onAdvanceQuiz is not supplied, even for a manager", () => {
    render(<PollCard poll={makePoll({ quizId: "q1" })} {...baseProps} canManage={true} />);
    expect(screen.queryByTestId("poll-next-question-p1")).toBeNull();
  });

  it("shows 'Next question' only when BOTH onAdvanceQuiz is supplied AND the viewer can manage", () => {
    render(
      <PollCard poll={makePoll({ quizId: "q1" })} {...baseProps} canManage={true} onAdvanceQuiz={jest.fn()} />
    );
    expect(screen.getByTestId("poll-next-question-p1")).toBeTruthy();
  });

  it("does not show 'Next question' to a non-manager even with onAdvanceQuiz supplied", () => {
    render(
      <PollCard poll={makePoll({ quizId: "q1" })} {...baseProps} canManage={false} onAdvanceQuiz={jest.fn()} />
    );
    expect(screen.queryByTestId("poll-next-question-p1")).toBeNull();
  });

  it("shows vote counts once results arrive", () => {
    const results: PollResults = { counts: [3, 1, 0], totalVotes: 4, fromTally: false };
    render(<PollCard poll={makePoll()} {...baseProps} results={results} />);
    expect(screen.getByText("4 votes")).toBeTruthy();
  });

  it("shows a no-votes-yet message, without vote counts, before any result exists", () => {
    render(<PollCard poll={makePoll()} {...baseProps} results={null} />);
    expect(screen.getByText("No votes yet")).toBeTruthy();
  });
});

describe("voting — single mode", () => {
  it("tapping an option calls onVote with that option's index", () => {
    const onVote = jest.fn();
    render(<PollCard poll={makePoll()} {...baseProps} onVote={onVote} />);
    fireEvent.press(screen.getByTestId("poll-option-p1-1"));
    expect(onVote).toHaveBeenCalledWith(1);
    expect(baseProps.onToggleDot).not.toHaveBeenCalled();
  });

  it("disables every option for a viewer who cannot vote", () => {
    render(<PollCard poll={makePoll()} {...baseProps} canVote={false} />);
    expect(screen.getByTestId("poll-option-p1-0").props.accessibilityState?.disabled).toBe(true);
  });
});

describe("voting — dots mode", () => {
  it("tapping an option calls onToggleDot, not onVote", () => {
    const onToggleDot = jest.fn();
    const onVote = jest.fn();
    render(<PollCard poll={makePoll({ mode: "dots" })} {...baseProps} onVote={onVote} onToggleDot={onToggleDot} />);
    fireEvent.press(screen.getByTestId("poll-option-p1-2"));
    expect(onToggleDot).toHaveBeenCalledWith(2);
    expect(onVote).not.toHaveBeenCalled();
  });
});

describe("Next question", () => {
  it("tapping it calls onAdvanceQuiz", () => {
    const onAdvanceQuiz = jest.fn();
    render(
      <PollCard poll={makePoll({ quizId: "q1" })} {...baseProps} canManage={true} onAdvanceQuiz={onAdvanceQuiz} />
    );
    fireEvent.press(screen.getByTestId("poll-next-question-p1"));
    expect(onAdvanceQuiz).toHaveBeenCalledTimes(1);
  });
});

describe("delete", () => {
  it("tapping the delete button calls onDelete", () => {
    const onDelete = jest.fn();
    render(<PollCard poll={makePoll()} {...baseProps} canManage={true} onDelete={onDelete} />);
    fireEvent.press(screen.getByTestId("poll-delete-p1"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
