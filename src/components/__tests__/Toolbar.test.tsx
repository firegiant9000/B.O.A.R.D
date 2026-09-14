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
  onScanDocument: jest.fn(),
  onInsertPoll: jest.fn(),
  onInsertMath: jest.fn(),
  onInsertCode: jest.fn(),
  onInsertNote: jest.fn(),
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

describe("Toolbar — canScanDocument (Month 6, camera capture + OCR)", () => {
  it("shows the scan button by default, wired to onScanDocument — the board's one reachable entry point", () => {
    const onScanDocument = jest.fn();
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} onScanDocument={onScanDocument} />
    );
    fireEvent.press(screen.getByText("scan-outline"));
    expect(onScanDocument).toHaveBeenCalledTimes(1);
  });

  it("hides the scan button when canScanDocument is false (embed edit sessions)", () => {
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} canScanDocument={false} />
    );
    expect(screen.queryByText("scan-outline")).toBeNull();
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

describe("Toolbar — canInsertMath (Month 6, math elements)", () => {
  // This button is the board's ONE insert entry point for an equation (the
  // edit path is a tap on the element itself, in BoardCanvas). Without it the
  // whole feature is unreachable no matter how well the callable works.
  it("shows the equation button by default, wired to onInsertMath", () => {
    const onInsertMath = jest.fn();
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} onInsertMath={onInsertMath} />
    );
    fireEvent.press(screen.getByTestId("toolbar-insert-math"));
    expect(onInsertMath).toHaveBeenCalledTimes(1);
  });

  it("hides the equation button when canInsertMath is false", () => {
    // The screen passes false in an embed session and when the build-time
    // flag is off. Hiding a button is an affordance, never the gate — that
    // is firestore.rules' `mathElements` match plus the callable's own
    // membership check.
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} canInsertMath={false} />
    );
    expect(screen.queryByTestId("toolbar-insert-math")).toBeNull();
  });

  it("is not offered at all on the read-only viewer toolbar", () => {
    // A viewer cannot write `mathElements`; offering the button would mean
    // offering what the rules would deny.
    render(<Toolbar {...baseProps} activeTool="select" canEdit={false} onToolChange={jest.fn()} />);
    expect(screen.queryByTestId("toolbar-insert-math")).toBeNull();
  });
});

describe("Toolbar — canInsertCode (Month 6, code elements)", () => {
  // This button is the board's ONE insert entry point for a code block (the
  // edit path is a tap on the element itself, in BoardCanvas). Without it the
  // whole feature is unreachable no matter how well codeRender.ts tokenizes.
  it("shows the code button by default, wired to onInsertCode", () => {
    const onInsertCode = jest.fn();
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} onInsertCode={onInsertCode} />
    );
    fireEvent.press(screen.getByTestId("toolbar-insert-code"));
    expect(onInsertCode).toHaveBeenCalledTimes(1);
  });

  it("hides the code button when canInsertCode is false", () => {
    // The screen passes false only when the build-time flag is off — UNLIKE
    // `canInsertMath`, this is never conditioned on embed mode (firestore.rules'
    // `codeElements` match carries the same `isEmbedEditor` disjunct every
    // other geometry-only collection does). Hiding a button is an affordance,
    // never the gate — that is firestore.rules' `codeElements` match.
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} canInsertCode={false} />
    );
    expect(screen.queryByTestId("toolbar-insert-code")).toBeNull();
  });

  it("is not offered at all on the read-only viewer toolbar", () => {
    // A viewer cannot write `codeElements`; offering the button would mean
    // offering what the rules would deny.
    render(<Toolbar {...baseProps} activeTool="select" canEdit={false} onToolChange={jest.fn()} />);
    expect(screen.queryByTestId("toolbar-insert-code")).toBeNull();
  });
});

describe("Toolbar — canInsertNote (Month 6, sticky-note polish)", () => {
  // This button is the board's ONE insert entry point for a sticky note.
  // Without it, the colour/size picker in TextNoteOverlay.tsx would be a
  // component nobody could ever reach.
  it("shows the note-insert button by default, wired to onInsertNote", () => {
    const onInsertNote = jest.fn();
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} onInsertNote={onInsertNote} />
    );
    fireEvent.press(screen.getByTestId("toolbar-insert-note"));
    expect(onInsertNote).toHaveBeenCalledTimes(1);
  });

  it("hides the note-insert button when canInsertNote is false", () => {
    render(
      <Toolbar {...baseProps} activeTool="pen" onToolChange={jest.fn()} canInsertNote={false} />
    );
    expect(screen.queryByTestId("toolbar-insert-note")).toBeNull();
  });

  it("is not offered at all on the read-only viewer toolbar", () => {
    render(<Toolbar {...baseProps} activeTool="select" canEdit={false} onToolChange={jest.fn()} />);
    expect(screen.queryByTestId("toolbar-insert-note")).toBeNull();
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
