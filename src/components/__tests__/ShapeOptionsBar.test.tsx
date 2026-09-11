jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import ShapeOptionsBar from "../ShapeOptionsBar";

/**
 * ShapeOptionsBar.test.tsx — Month 5 (ROADMAP item 12) added the eyedropper
 * pill; this bar had no prior test file.
 */

const baseProps = {
  activeKind: "rect" as const,
  onSelectKind: jest.fn(),
  fillEnabled: false,
  onToggleFill: jest.fn(),
  dashed: false,
  onToggleDashed: jest.fn(),
  snapGrid: 0,
  onCycleSnap: jest.fn(),
  arrowheadEnd: "none" as const,
  onCycleArrowhead: jest.fn(),
  eyedropperArmed: false,
  onToggleEyedropper: jest.fn(),
};

afterEach(() => jest.clearAllMocks());

it("renders the eyedropper pill and toggles it on press", () => {
  render(<ShapeOptionsBar {...baseProps} />);
  fireEvent.press(screen.getByTestId("shape-options-eyedropper-pill"));
  expect(baseProps.onToggleEyedropper).toHaveBeenCalledTimes(1);
});

it("shows a distinct label while armed", () => {
  render(<ShapeOptionsBar {...baseProps} eyedropperArmed />);
  expect(screen.getByText("Picking…")).toBeTruthy();
});

it("existing shape-kind selection still works alongside the new pill", () => {
  render(<ShapeOptionsBar {...baseProps} />);
  fireEvent.press(screen.getByLabelText("Shape: ellipse"));
  expect(baseProps.onSelectKind).toHaveBeenCalledWith("ellipse");
});
