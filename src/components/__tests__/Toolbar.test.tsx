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
  onInsertPoll: jest.fn(),
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

describe("Toolbar — canInsertImage (Month 5, embed edit sessions)", () => {
  it("shows the image-insert button by default", () => {
    render(<Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} />);
    expect(screen.getByText("image-outline")).toBeTruthy();
  });

  it("hides the image-insert button when canInsertImage is false", () => {
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} canInsertImage={false} />
    );
    expect(screen.queryByText("image-outline")).toBeNull();
  });
});

describe("Toolbar — canInsertPoll (Month 6, embed edit sessions)", () => {
  it("shows the poll-insert button by default, wired to onInsertPoll", () => {
    const onInsertPoll = jest.fn();
    render(<Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} onInsertPoll={onInsertPoll} />);
    fireEvent.press(screen.getByText("bar-chart-outline"));
    expect(onInsertPoll).toHaveBeenCalledTimes(1);
  });

  it("hides the poll-insert button when canInsertPoll is false", () => {
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} canInsertPoll={false} />
    );
    expect(screen.queryByText("bar-chart-outline")).toBeNull();
  });
});

describe("Toolbar — canManualSave (Month 5, embed edit sessions)", () => {
  it("shows the save button by default", () => {
    render(<Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} />);
    expect(screen.getByText("save-outline")).toBeTruthy();
  });

  it("hides the save button when canManualSave is false", () => {
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} canManualSave={false} />
    );
    expect(screen.queryByText("save-outline")).toBeNull();
  });
});
