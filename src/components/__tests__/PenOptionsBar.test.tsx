jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import PenOptionsBar from "../PenOptionsBar";

/**
 * PenOptionsBar.test.tsx — Month 5 (ROADMAP item 12: colour + stroke polish,
 * eyedropper). Covers the pills this task added; the pre-existing
 * "Perfect shapes" cycle pill already had no test file of its own.
 */

const baseProps = {
  mode: "ask" as const,
  onCycleMode: jest.fn(),
  activePenStyle: "pen" as const,
  onSelectPenStyle: jest.fn(),
  activeColor: "#3366ff",
  onOpenColorPicker: jest.fn(),
  activeStrokeWidth: 5,
  onOpenWidthPicker: jest.fn(),
  eyedropperArmed: false,
  onToggleEyedropper: jest.fn(),
};

afterEach(() => jest.clearAllMocks());

it("renders a pill for every declared pen style", () => {
  render(<PenOptionsBar {...baseProps} />);
  expect(screen.getByLabelText("Pen style: Pen")).toBeTruthy();
  expect(screen.getByLabelText("Pen style: Highlighter")).toBeTruthy();
  expect(screen.getByLabelText("Pen style: Marker")).toBeTruthy();
  expect(screen.getByLabelText("Pen style: Calligraphy")).toBeTruthy();
});

it("selecting a pen style calls onSelectPenStyle with that style", () => {
  render(<PenOptionsBar {...baseProps} />);
  fireEvent.press(screen.getByLabelText("Pen style: Highlighter"));
  expect(baseProps.onSelectPenStyle).toHaveBeenCalledWith("highlighter");
});

it("tapping the colour pill opens the colour picker", () => {
  render(<PenOptionsBar {...baseProps} />);
  fireEvent.press(screen.getByTestId("pen-options-color-pill"));
  expect(baseProps.onOpenColorPicker).toHaveBeenCalledTimes(1);
});

it("tapping the width pill opens the width picker and shows the current width", () => {
  render(<PenOptionsBar {...baseProps} activeStrokeWidth={9} />);
  expect(screen.getByText("Width: 9")).toBeTruthy();
  fireEvent.press(screen.getByTestId("pen-options-width-pill"));
  expect(baseProps.onOpenWidthPicker).toHaveBeenCalledTimes(1);
});

it("tapping the eyedropper pill arms/toggles picking", () => {
  render(<PenOptionsBar {...baseProps} />);
  fireEvent.press(screen.getByTestId("pen-options-eyedropper-pill"));
  expect(baseProps.onToggleEyedropper).toHaveBeenCalledTimes(1);
});

it("shows a distinct label/state while the eyedropper is armed", () => {
  render(<PenOptionsBar {...baseProps} eyedropperArmed />);
  expect(screen.getByText("Picking…")).toBeTruthy();
  expect(screen.getByLabelText("Cancel colour picking")).toBeTruthy();
});

it("the perfect-shapes pill still cycles the mode (pre-existing behavior)", () => {
  render(<PenOptionsBar {...baseProps} />);
  fireEvent.press(screen.getByLabelText("Perfect shapes: Ask"));
  expect(baseProps.onCycleMode).toHaveBeenCalledTimes(1);
});
