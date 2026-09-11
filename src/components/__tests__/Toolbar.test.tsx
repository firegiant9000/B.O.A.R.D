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
