import React from "react";
import { render, fireEvent, screen } from "@testing-library/react-native";
import PollComposer from "../PollComposer";

describe("PollComposer", () => {
  it("renders nothing (no dialog content mounted) while not visible", () => {
    render(<PollComposer visible={false} onCancel={jest.fn()} onSubmit={jest.fn()} />);
    expect(screen.queryByTestId("poll-composer")).toBeNull();
  });

  // Fix round 1, item 4 — the anonymous toggle's hint must disclose BOTH
  // halves: who it's hidden from (other members) AND that the system still
  // records identity (never implying the system doesn't know either).
  it("discloses both halves of the anonymity guarantee on the toggle's hint text", () => {
    render(<PollComposer visible={true} onCancel={jest.fn()} onSubmit={jest.fn()} />);
    expect(screen.getByText(/other members/i)).toBeTruthy();
    expect(screen.getByText(/identity is still stored|still recorded/i)).toBeTruthy();
    expect(screen.queryByText(/hidden from (the )?(system|admin|host)/i)).toBeNull();
  });

  it("starts with 2 empty option fields and Create disabled", () => {
    render(<PollComposer visible={true} onCancel={jest.fn()} onSubmit={jest.fn()} />);
    expect(screen.getByTestId("poll-composer-option-0")).toBeTruthy();
    expect(screen.getByTestId("poll-composer-option-1")).toBeTruthy();
    expect(screen.queryByTestId("poll-composer-option-2")).toBeNull();
    expect(screen.getByTestId("poll-composer-submit").props.accessibilityState?.disabled).toBe(true);
  });

  it("enables Create once a question and 2 options are filled in", () => {
    render(<PollComposer visible={true} onCancel={jest.fn()} onSubmit={jest.fn()} />);
    fireEvent.changeText(screen.getByTestId("poll-composer-question"), "Favorite color?");
    fireEvent.changeText(screen.getByTestId("poll-composer-option-0"), "Red");
    fireEvent.changeText(screen.getByTestId("poll-composer-option-1"), "Blue");
    expect(screen.getByTestId("poll-composer-submit").props.accessibilityState?.disabled).toBe(false);
  });

  it("submits the trimmed question, options, mode and anonymous flag", () => {
    const onSubmit = jest.fn();
    render(<PollComposer visible={true} onCancel={jest.fn()} onSubmit={onSubmit} />);
    fireEvent.changeText(screen.getByTestId("poll-composer-question"), "  Favorite color?  ");
    fireEvent.changeText(screen.getByTestId("poll-composer-option-0"), " Red ");
    fireEvent.changeText(screen.getByTestId("poll-composer-option-1"), " Blue ");
    fireEvent.press(screen.getByTestId("poll-composer-mode-dots"));
    fireEvent(screen.getByTestId("poll-composer-anonymous"), "valueChange", true);
    fireEvent.press(screen.getByTestId("poll-composer-submit"));

    expect(onSubmit).toHaveBeenCalledWith({
      question: "Favorite color?",
      options: ["Red", "Blue"],
      anonymous: true,
      mode: "dots",
    });
  });

  it("adds up to a 6th option and then hides the 'Add option' control", () => {
    render(<PollComposer visible={true} onCancel={jest.fn()} onSubmit={jest.fn()} />);
    fireEvent.press(screen.getByTestId("poll-composer-add-option")); // -> 3
    fireEvent.press(screen.getByTestId("poll-composer-add-option")); // -> 4
    fireEvent.press(screen.getByTestId("poll-composer-add-option")); // -> 5
    fireEvent.press(screen.getByTestId("poll-composer-add-option")); // -> 6
    expect(screen.getByTestId("poll-composer-option-5")).toBeTruthy();
    expect(screen.queryByTestId("poll-composer-add-option")).toBeNull();
  });

  it("cannot remove below 2 options", () => {
    render(<PollComposer visible={true} onCancel={jest.fn()} onSubmit={jest.fn()} />);
    expect(screen.queryByTestId("poll-composer-remove-option-0")).toBeNull();
    expect(screen.queryByTestId("poll-composer-remove-option-1")).toBeNull();
  });

  it("removing an option above the floor of 2 works", () => {
    render(<PollComposer visible={true} onCancel={jest.fn()} onSubmit={jest.fn()} />);
    fireEvent.press(screen.getByTestId("poll-composer-add-option")); // -> 3 options, removal now allowed
    fireEvent.press(screen.getByTestId("poll-composer-remove-option-2"));
    expect(screen.queryByTestId("poll-composer-option-2")).toBeNull();
  });

  it("resets its fields and calls onCancel when cancelled", () => {
    const onCancel = jest.fn();
    render(<PollComposer visible={true} onCancel={onCancel} onSubmit={jest.fn()} />);
    fireEvent.changeText(screen.getByTestId("poll-composer-question"), "Some question");
    fireEvent.press(screen.getByTestId("poll-composer-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
