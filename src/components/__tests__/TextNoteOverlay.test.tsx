jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { Linking, StyleSheet } from "react-native";
import TextNoteOverlay from "../TextNoteOverlay";
import type { PositionedTextNote, TextNote } from "../../types";

/**
 * TextNoteOverlay.test.tsx — Month 6 sticky-note polish (8 colours, 3 sizes,
 * markdown rendering, pin-to-position/attach-to-element). Plain RN views, no
 * SVG, so this component is fully render-testable (unlike the board screen).
 */

function makeNote(overrides: Partial<TextNote> = {}): TextNote {
  return {
    id: "n1",
    boardId: "b1",
    userId: "u1",
    content: "hello",
    position: { x: 100, y: 100 },
    createdAt: new Date(),
    ...overrides,
  };
}

function positioned(note: TextNote, x = note.position.x, y = note.position.y): PositionedTextNote {
  return { note, x, y };
}

const baseProps = {
  pendingNotePosition: null,
  currentUserId: "u1",
  isAdmin: false,
  onSubmitNote: jest.fn(),
  onCancelNote: jest.fn(),
  onDeleteNote: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("markdown rendering", () => {
  it("renders **bold** text as a distinct run", () => {
    const note = makeNote({ content: "this is **bold** text" });
    render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    expect(screen.getByText("bold")).toBeTruthy();
  });

  it("renders *italic* text as a distinct run", () => {
    const note = makeNote({ content: "this is *italic* text" });
    render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    expect(screen.getByText("italic")).toBeTruthy();
  });

  it("renders a list item with its bullet marker", () => {
    const note = makeNote({ content: "- first item" });
    render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    expect(screen.getByText("• ")).toBeTruthy();
    expect(screen.getByText("first item")).toBeTruthy();
  });

  it("renders an ordered list item keeping its typed ordinal", () => {
    const note = makeNote({ content: "2. second item" });
    render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    expect(screen.getByText("2. ")).toBeTruthy();
  });

  it("opens a safe (https) link on tap", () => {
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    const note = makeNote({ content: "see [my site](https://example.com)" });
    render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    fireEvent.press(screen.getByText("my site"));
    expect(openURLSpy).toHaveBeenCalledWith("https://example.com");
  });

  it("never opens a link with an unsafe scheme, even if tapped", () => {
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    const note = makeNote({ content: "click [here](javascript:alert(1))" });
    render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    fireEvent.press(screen.getByText("here"));
    expect(openURLSpy).not.toHaveBeenCalled();
  });
});

describe("colour (corrupt-stored-value guard)", () => {
  it("falls back to the default colour for an unknown stored value", () => {
    const note = makeNote({ color: "chartreuse" as any });
    const { getByTestId } = render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    const style = StyleSheet.flatten(getByTestId("note-card-n1").props.style);
    expect(style.backgroundColor).toBe("#FFF9C4");
  });
});

describe("colour and size (render layer)", () => {
  it("renders a note in its stored colour", () => {
    const note = makeNote({ color: "pink" });
    const { getByTestId } = render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    const style = StyleSheet.flatten(getByTestId("note-card-n1").props.style);
    expect(style.backgroundColor).toBe("#F8BBD0");
  });

  it("renders a note at its stored size", () => {
    // Both rendered consequences of `size`, not just the card's width: the
    // block text's own `fontSize` too. A component that only ever wired up
    // `maxWidth` (or hardcoded `fontSize: 14`) would leave this test green
    // if it asserted card width alone — see markdown.ts's sibling render
    // tests for the same "assert both, not just the one the name implies"
    // discipline.
    const note = makeNote({ size: 18 });
    const { getByTestId } = render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    const cardStyle = StyleSheet.flatten(getByTestId("note-card-n1").props.style);
    expect(cardStyle.maxWidth).toBe(260);
    const textStyle = StyleSheet.flatten(getByTestId("note-text-n1-0").props.style);
    expect(textStyle.fontSize).toBe(18);
  });
});

describe("attach-to-element indicator", () => {
  it("shows an anchor badge for a note with anchorElementId set", () => {
    const note = makeNote({ anchorElementId: "shape-1" });
    render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    expect(screen.getByTestId("note-anchor-badge-n1")).toBeTruthy();
  });

  it("omits the anchor badge for a plain pinned note", () => {
    const note = makeNote();
    render(<TextNoteOverlay {...baseProps} notes={[positioned(note)]} />);
    expect(screen.queryByTestId("note-anchor-badge-n1")).toBeNull();
  });
});

describe("delete permissions", () => {
  it("shows delete for the note's own author", () => {
    const note = makeNote({ userId: "u1" });
    render(<TextNoteOverlay {...baseProps} currentUserId="u1" notes={[positioned(note)]} />);
    fireEvent.press(screen.getByText("close-circle"));
    expect(baseProps.onDeleteNote).toHaveBeenCalledWith("n1");
  });

  it("hides delete for another user's note when not admin", () => {
    const note = makeNote({ userId: "someone-else" });
    render(
      <TextNoteOverlay {...baseProps} currentUserId="u1" isAdmin={false} notes={[positioned(note)]} />
    );
    expect(screen.queryByText("close-circle")).toBeNull();
  });

  it("shows delete for another user's note when admin", () => {
    const note = makeNote({ userId: "someone-else" });
    render(
      <TextNoteOverlay {...baseProps} currentUserId="u1" isAdmin={true} notes={[positioned(note)]} />
    );
    expect(screen.getByText("close-circle")).toBeTruthy();
  });
});

describe("pending note editor — colour/size picker", () => {
  it("submits the default colour and size when the author doesn't change either", () => {
    render(
      <TextNoteOverlay {...baseProps} notes={[]} pendingNotePosition={{ x: 50, y: 50 }} />
    );
    fireEvent.changeText(screen.getByPlaceholderText(/Type note/), "hello there");
    fireEvent.press(screen.getByTestId("note-editor-submit"));
    expect(baseProps.onSubmitNote).toHaveBeenCalledWith("hello there", { color: "yellow", size: 14 });
  });

  it("submits the picked colour and size", () => {
    render(
      <TextNoteOverlay {...baseProps} notes={[]} pendingNotePosition={{ x: 50, y: 50 }} />
    );
    fireEvent.changeText(screen.getByPlaceholderText(/Type note/), "hello there");
    fireEvent.press(screen.getByTestId("note-editor-color-pink"));
    fireEvent.press(screen.getByTestId("note-editor-size-18"));
    fireEvent.press(screen.getByTestId("note-editor-submit"));
    expect(baseProps.onSubmitNote).toHaveBeenCalledWith("hello there", { color: "pink", size: 18 });
  });

  it("cancel never calls onSubmitNote", () => {
    render(
      <TextNoteOverlay {...baseProps} notes={[]} pendingNotePosition={{ x: 50, y: 50 }} />
    );
    fireEvent.changeText(screen.getByPlaceholderText(/Type note/), "hello there");
    fireEvent.press(screen.getByTestId("note-editor-cancel"));
    expect(baseProps.onCancelNote).toHaveBeenCalledTimes(1);
    expect(baseProps.onSubmitNote).not.toHaveBeenCalled();
  });

  it("submitting empty/whitespace-only text cancels instead of creating a blank note", () => {
    render(
      <TextNoteOverlay {...baseProps} notes={[]} pendingNotePosition={{ x: 50, y: 50 }} />
    );
    fireEvent.changeText(screen.getByPlaceholderText(/Type note/), "   ");
    fireEvent.press(screen.getByTestId("note-editor-submit"));
    expect(baseProps.onSubmitNote).not.toHaveBeenCalled();
    expect(baseProps.onCancelNote).toHaveBeenCalledTimes(1);
  });
});
