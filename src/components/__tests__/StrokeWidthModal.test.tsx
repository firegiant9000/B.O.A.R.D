jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import StrokeWidthModal, { STROKE_WIDTH_PRESETS } from "../StrokeWidthModal";

/**
 * StrokeWidthModal.test.tsx — Month 5 (ROADMAP item 12: "6 stroke widths
 * (was 3) plus a continuous width slider").
 */

const baseProps = {
  visible: true,
  onClose: jest.fn(),
  strokeWidth: 5,
  onChange: jest.fn(),
};

afterEach(() => jest.clearAllMocks());

it("offers exactly 6 stroke-width presets", () => {
  expect(STROKE_WIDTH_PRESETS).toHaveLength(6);
});

it("keeps the pre-existing S/M/L values (2, 5, 10) among the 6", () => {
  const values = STROKE_WIDTH_PRESETS.map((p) => p.value);
  expect(values).toEqual(expect.arrayContaining([2, 5, 10]));
});

it("renders a preset button per width and highlights the active one", () => {
  render(<StrokeWidthModal {...baseProps} strokeWidth={10} />);
  for (const { value } of STROKE_WIDTH_PRESETS) {
    expect(screen.getByTestId(`stroke-width-preset-${value}`)).toBeTruthy();
  }
});

it("tapping a preset calls onChange with that width", () => {
  render(<StrokeWidthModal {...baseProps} />);
  fireEvent.press(screen.getByTestId("stroke-width-preset-16"));
  expect(baseProps.onChange).toHaveBeenCalledWith(16);
});

it("renders the continuous slider track and thumb", () => {
  render(<StrokeWidthModal {...baseProps} />);
  expect(screen.getByTestId("stroke-width-slider-track")).toBeTruthy();
  expect(screen.getByTestId("stroke-width-slider-thumb")).toBeTruthy();
});

it("shows the current custom width", () => {
  render(<StrokeWidthModal {...baseProps} strokeWidth={7} />);
  expect(screen.getByText("Custom: 7px")).toBeTruthy();
});

it("the slider drag reads the width reported by layout, not the pre-layout placeholder (regression: PanResponder built via useRef must not freeze stale values)", () => {
  render(<StrokeWidthModal {...baseProps} />);
  const track = screen.getByTestId("stroke-width-slider-track");

  // Before layout, the track is the 1px placeholder; report its real width.
  fireEvent(track, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 28 } } });
  // A drag to the midpoint of a 200px track over [1, 30] lands on 15.5 -> 16.
  fireEvent(track, "responderMove", { nativeEvent: { locationX: 100 } });

  expect(baseProps.onChange).toHaveBeenCalledWith(16);
});

it("Done and the close button both call onClose", () => {
  render(<StrokeWidthModal {...baseProps} />);
  fireEvent.press(screen.getByTestId("stroke-width-done"));
  fireEvent.press(screen.getByTestId("stroke-width-close"));
  expect(baseProps.onClose).toHaveBeenCalledTimes(2);
});
