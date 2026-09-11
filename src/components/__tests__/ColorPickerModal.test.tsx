jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});

// ColorPickerModal imports workspaceService for canUseCustomPalette/
// MAX_WORKSPACE_SWATCHES; that module builds a `collection(db, "workspaces")`
// reference at module scope, so even though this component never calls a
// Firestore-writing export, the module graph still needs the same
// firebase/firestore + config/firebase mocks every other workspaceService
// consumer test uses (see workspaceService.test.ts).
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import ColorPickerModal from "../ColorPickerModal";

/**
 * ColorPickerModal.test.tsx — Month 5 (ROADMAP items 12 + 14): hex input,
 * alpha slider, recent-colours row, per-workspace swatch palette with its
 * Pro badge.
 */

const baseProps = {
  visible: true,
  onClose: jest.fn(),
  color: "#3366ff",
  alpha: 1,
  onChange: jest.fn(),
  recentColors: ["#ff0000", "#00ff00"],
  plan: "pro" as const,
  canManageWorkspace: true,
  workspaceSwatches: ["#123456"],
  onAddSwatch: jest.fn(),
  onUpgradeRequested: jest.fn(),
};

afterEach(() => jest.clearAllMocks());

it("shows the current alpha as a percentage", () => {
  render(<ColorPickerModal {...baseProps} alpha={0.4} />);
  expect(screen.getByText("Alpha: 40%")).toBeTruthy();
});

it("submitting a valid 6-digit hex in the text field applies it, alpha unchanged", () => {
  render(<ColorPickerModal {...baseProps} />);
  const input = screen.getByTestId("color-picker-hex-input");
  fireEvent.changeText(input, "#00aaff");
  fireEvent(input, "submitEditing");
  expect(baseProps.onChange).toHaveBeenCalledWith("#00aaff", 1);
});

// Fix round 1, item 6: an 8-digit hex DOES carry a real alpha byte
// (`fromHex8` reads it) — the field must apply it, not silently keep
// whatever the alpha slider happened to be at.
it("submitting an 8-digit hex applies its OWN embedded alpha, not the current slider value", () => {
  render(<ColorPickerModal {...baseProps} alpha={1} />);
  const input = screen.getByTestId("color-picker-hex-input");
  fireEvent.changeText(input, "#00aaff80");
  fireEvent(input, "submitEditing");
  expect(baseProps.onChange).toHaveBeenCalledWith("#00aaff", 0x80 / 255);
});

it("does not call onChange for a malformed hex", () => {
  render(<ColorPickerModal {...baseProps} />);
  const input = screen.getByTestId("color-picker-hex-input");
  fireEvent.changeText(input, "not-a-color");
  fireEvent(input, "submitEditing");
  expect(baseProps.onChange).not.toHaveBeenCalled();
});

it("renders every recent colour and applies one on tap", () => {
  render(<ColorPickerModal {...baseProps} />);
  fireEvent.press(screen.getByTestId("color-picker-recent-#ff0000"));
  expect(baseProps.onChange).toHaveBeenCalledWith("#ff0000", 1);
});

it("renders every workspace swatch and applies one on tap", () => {
  render(<ColorPickerModal {...baseProps} />);
  fireEvent.press(screen.getByTestId("color-picker-swatch-#123456"));
  expect(baseProps.onChange).toHaveBeenCalledWith("#123456", 1);
});

describe("Pro gate on adding a swatch (ROADMAP item 14)", () => {
  it("a pro-plan workspace can add the current colour with no badge shown", () => {
    render(<ColorPickerModal {...baseProps} plan="pro" />);
    expect(screen.queryByTestId("color-picker-swatch-pro-badge")).toBeNull();
    fireEvent.press(screen.getByTestId("color-picker-add-swatch"));
    expect(baseProps.onAddSwatch).toHaveBeenCalledWith("#3366ff");
  });

  it("a free-plan workspace sees the Pro badge and adding is blocked", () => {
    render(<ColorPickerModal {...baseProps} plan="free" />);
    expect(screen.getByTestId("color-picker-swatch-pro-badge")).toBeTruthy();
    fireEvent.press(screen.getByTestId("color-picker-add-swatch"));
    expect(baseProps.onAddSwatch).not.toHaveBeenCalled();
  });

  it("tapping the badge or the disabled add control on free routes to the caller's upgrade flow", () => {
    render(<ColorPickerModal {...baseProps} plan="free" />);
    fireEvent.press(screen.getByTestId("color-picker-swatch-pro-badge"));
    expect(baseProps.onUpgradeRequested).toHaveBeenCalledTimes(1);
    expect(baseProps.onAddSwatch).not.toHaveBeenCalled();
  });
});

describe("workspace-role gate on adding a swatch (firestore.rules restricts non-name writes to owner/admin)", () => {
  it("a pro-plan MEMBER who is not owner/admin sees no Pro badge, but adding is still blocked", () => {
    render(<ColorPickerModal {...baseProps} plan="pro" canManageWorkspace={false} />);
    // Not a plan problem, so no "Pro" badge — a different reason entirely.
    expect(screen.queryByTestId("color-picker-swatch-pro-badge")).toBeNull();
    fireEvent.press(screen.getByTestId("color-picker-add-swatch"));
    expect(baseProps.onAddSwatch).not.toHaveBeenCalled();
  });

  it("a pro-plan owner/admin can add normally", () => {
    render(<ColorPickerModal {...baseProps} plan="pro" canManageWorkspace={true} />);
    fireEvent.press(screen.getByTestId("color-picker-add-swatch"));
    expect(baseProps.onAddSwatch).toHaveBeenCalledWith("#3366ff");
  });
});

describe("alpha slider drag (fix round 1, item 2 — must not write on every move)", () => {
  it("reads the width reported by layout, not the pre-layout placeholder", () => {
    render(<ColorPickerModal {...baseProps} alpha={0} />);
    const track = screen.getByTestId("color-picker-alpha-track");

    fireEvent(track, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 28 } } });
    // Midpoint of a 200px track over [0, 1] is 0.5.
    fireEvent(track, "responderGrant", { nativeEvent: { locationX: 100 } });
    fireEvent(track, "responderRelease", { nativeEvent: { locationX: 100 } });

    expect(baseProps.onChange).toHaveBeenCalledWith("#3366ff", 0.5);
  });

  it("a move updates the live label but does NOT call onChange — only release commits", () => {
    render(<ColorPickerModal {...baseProps} alpha={0} />);
    const track = screen.getByTestId("color-picker-alpha-track");
    fireEvent(track, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 28 } } });

    fireEvent(track, "responderGrant", { nativeEvent: { locationX: 100 } });
    expect(baseProps.onChange).not.toHaveBeenCalled();
    fireEvent(track, "responderMove", { nativeEvent: { locationX: 150 } });
    fireEvent(track, "responderMove", { nativeEvent: { locationX: 160 } });
    expect(baseProps.onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Alpha: 80%")).toBeTruthy();

    fireEvent(track, "responderRelease", { nativeEvent: { locationX: 160 } });
    expect(baseProps.onChange).toHaveBeenCalledTimes(1);
    expect(baseProps.onChange).toHaveBeenCalledWith("#3366ff", 0.8);
  });

  it("an interrupted drag (responderTerminate) still commits the last value, same as a release", () => {
    render(<ColorPickerModal {...baseProps} alpha={0} />);
    const track = screen.getByTestId("color-picker-alpha-track");
    fireEvent(track, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 28 } } });

    fireEvent(track, "responderGrant", { nativeEvent: { locationX: 100 } });
    fireEvent(track, "responderTerminate", { nativeEvent: { locationX: 100 } });

    expect(baseProps.onChange).toHaveBeenCalledWith("#3366ff", 0.5);
  });
});

it("closing via Done or the close button calls onClose", () => {
  render(<ColorPickerModal {...baseProps} />);
  fireEvent.press(screen.getByTestId("color-picker-done"));
  fireEvent.press(screen.getByTestId("color-picker-close"));
  expect(baseProps.onClose).toHaveBeenCalledTimes(2);
});
