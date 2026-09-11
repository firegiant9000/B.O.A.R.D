// Real icon names, not `null`, so the laser button (the only consumer of
// "locate-outline" in this component) is queryable by name.
jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import Toolbar from "../Toolbar";

/**
 * Toolbar.test.tsx — Month 5 laser pointer, fix round 1: the toolbar button
 * is the tool's one touch entry point (a Bluetooth-keyboard-only Shift+L
 * hotkey is unreachable on the phone/tablet a presenter is likely holding).
 */

const baseProps = {
  activeColor: "#000000",
  activeStrokeWidth: 5,
  isAdmin: false,
  onColorChange: jest.fn(),
  onStrokeWidthChange: jest.fn(),
  onOpenColorPicker: jest.fn(),
  onOpenWidthPicker: jest.fn(),
  onInsertImage: jest.fn(),
  onUndo: jest.fn(),
  onClear: jest.fn(),
  onSave: jest.fn(),
};

describe("Toolbar — laser pointer touch entry point (Month 5, fix round 1)", () => {
  it("renders a laser button on the editing toolbar, wired to onToolChange", () => {
    const onToolChange = jest.fn();
    render(<Toolbar {...baseProps} activeTool="pen" onToolChange={onToolChange} />);

    fireEvent.press(screen.getByText("locate-outline"));

    expect(onToolChange).toHaveBeenCalledWith("laser");
  });

  it("renders a laser button on the read-only viewer toolbar too — the laser isn't content creation", () => {
    const onToolChange = jest.fn();
    render(
      <Toolbar {...baseProps} activeTool="select" canEdit={false} onToolChange={onToolChange} />
    );

    fireEvent.press(screen.getByText("locate-outline"));

    expect(onToolChange).toHaveBeenCalledWith("laser");
  });
});

describe("Toolbar — colour + stroke polish (Month 5, ROADMAP item 12)", () => {
  it("offers 6 stroke-width presets (was 3), keeping the original S/M/L values (2/5/10) reachable", () => {
    const onStrokeWidthChange = jest.fn();
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} onStrokeWidthChange={onStrokeWidthChange} />
    );
    for (const value of [1, 2, 5, 10, 16, 24]) {
      expect(screen.getByTestId(`toolbar-stroke-${value}`)).toBeTruthy();
    }
    fireEvent.press(screen.getByTestId("toolbar-stroke-16"));
    expect(onStrokeWidthChange).toHaveBeenCalledWith(16);
  });

  it("the 'more' stroke-width button opens the continuous-slider picker without changing the width itself", () => {
    const onStrokeWidthChange = jest.fn();
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} onStrokeWidthChange={onStrokeWidthChange} />
    );
    fireEvent.press(screen.getByLabelText("More stroke widths"));
    expect(baseProps.onOpenWidthPicker).toHaveBeenCalledTimes(1);
    expect(onStrokeWidthChange).not.toHaveBeenCalled();
  });

  it("the 8 quick colour dots still call onColorChange unchanged", () => {
    const onColorChange = jest.fn();
    render(<Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} onColorChange={onColorChange} />);
    fireEvent.press(screen.getByTestId("toolbar-color-#FF3B30"));
    expect(onColorChange).toHaveBeenCalledWith("#FF3B30");
  });

  it("the 'more' colour button opens the custom picker without changing the active colour itself", () => {
    const onColorChange = jest.fn();
    render(<Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} onColorChange={onColorChange} />);
    fireEvent.press(screen.getByLabelText("More colours"));
    expect(baseProps.onOpenColorPicker).toHaveBeenCalledTimes(1);
    expect(onColorChange).not.toHaveBeenCalled();
  });
});
