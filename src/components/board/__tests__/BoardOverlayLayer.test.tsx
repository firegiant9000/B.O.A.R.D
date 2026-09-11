jest.mock("../../TextNoteOverlay", () => ({ __esModule: true, default: () => null }));
jest.mock("../../TextElementView", () => ({ __esModule: true, default: () => null }));
jest.mock("../../SelectionOverlay", () => ({ __esModule: true, default: () => null }));
jest.mock("../../CommentPinLayer", () => ({ __esModule: true, default: () => null }));

// AudioAffordance is the one child this file actually cares about: capture
// every render's props so tests can assert what BoardOverlayLayer decided to
// pass, without dragging expo-audio (AudioAffordance's own dependency) into
// this file's mocks — same "mock the heavy children, assert on behaviour"
// recipe as BoardCanvas.test.tsx.
const mockAudioAffordanceCalls: any[] = [];
jest.mock("../AudioAffordance", () => ({
  __esModule: true,
  default: (props: any) => {
    mockAudioAffordanceCalls.push(props);
    return null;
  },
}));

import React from "react";
import { render } from "@testing-library/react-native";
import BoardOverlayLayer from "../BoardOverlayLayer";
import { AudioElement } from "../../../types";

/**
 * BoardOverlayLayer.test.tsx — Month 5 voice notes (ROADMAP.md:583-587).
 *
 * This file covers only the audio wiring this task added; the rest of
 * BoardOverlayLayer's existing behavior (text notes, text elements, the
 * selection overlay, comment pins) has no dedicated coverage of its own
 * today and is out of this task's scope — none of it was touched.
 */

function baseProps(overrides: Partial<React.ComponentProps<typeof BoardOverlayLayer>> = {}) {
  return {
    enablePanZoom: true,
    viewport: { x: 0, y: 0, scale: 1 },
    notes: [],
    pendingNotePosition: null,
    onSubmitNote: jest.fn(),
    onCancelNote: jest.fn(),
    onDeleteNote: jest.fn(),
    textElements: [],
    previewText: jest.fn((el: any) => el),
    isSelected: jest.fn(() => false),
    editingTextId: null,
    onSelectText: jest.fn(),
    onBlurText: jest.fn(),
    onResizeText: jest.fn(),
    onDeleteText: jest.fn(),
    currentUserId: "self",
    isAdmin: false,
    overlayBounds: null,
    overlayRotation: 0,
    selectToolActive: true,
    marquee: null,
    selectionCount: 0,
    showSelectionActions: true,
    onDeleteSelected: jest.fn(),
    onDuplicateSelected: jest.fn(),
    onBringToFront: jest.fn(),
    onSendToBack: jest.fn(),
    onTransformStart: jest.fn(),
    onTransformMove: jest.fn(),
    onTransformEnd: jest.fn(),
    showCommentPins: true,
    commentPins: [],
    activeCommentId: null,
    onPressPin: jest.fn(),
    boardId: "board1",
    plan: "pro" as const,
    audioNotes: [] as AudioElement[],
    newVoiceNoteAnchor: null,
    ...overrides,
  };
}

const NOTE: AudioElement = {
  id: "a1",
  schemaVersion: 1,
  boardId: "board1",
  userId: "author",
  anchorElementId: "el1",
  storagePath: "boards/board1/audio/a1/note.m4a",
  downloadUrl: "https://dl/a1",
  durationMs: 4000,
  x: 30,
  y: 40,
  createdAt: new Date(),
};

beforeEach(() => {
  mockAudioAffordanceCalls.length = 0;
});

describe("existing voice notes", () => {
  it("renders one AudioAffordance per note, in playback mode, at its own x/y", () => {
    render(<BoardOverlayLayer {...baseProps({ audioNotes: [NOTE] })} />);
    expect(mockAudioAffordanceCalls).toHaveLength(1);
    expect(mockAudioAffordanceCalls[0]).toMatchObject({
      boardId: "board1",
      anchorElementId: "el1",
      userId: "self",
      x: 30,
      y: 40,
      plan: "pro",
      audio: NOTE,
    });
  });

  it("renders nothing extra when there are no notes and no new-note anchor", () => {
    render(<BoardOverlayLayer {...baseProps()} />);
    expect(mockAudioAffordanceCalls).toHaveLength(0);
  });

  it("renders one AudioAffordance per note for multiple notes", () => {
    const note2: AudioElement = { ...NOTE, id: "a2", anchorElementId: "el2", x: 99, y: 1 };
    render(<BoardOverlayLayer {...baseProps({ audioNotes: [NOTE, note2] })} />);
    expect(mockAudioAffordanceCalls).toHaveLength(2);
    expect(mockAudioAffordanceCalls.map((p) => p.anchorElementId).sort()).toEqual(["el1", "el2"]);
  });
});

describe("the record-entry-point (newVoiceNoteAnchor)", () => {
  it("renders one more AudioAffordance, in record mode (audio: null), at the given position", () => {
    render(
      <BoardOverlayLayer
        {...baseProps({ newVoiceNoteAnchor: { elementId: "el9", x: 12, y: 34 } })}
      />
    );
    expect(mockAudioAffordanceCalls).toHaveLength(1);
    expect(mockAudioAffordanceCalls[0]).toMatchObject({
      boardId: "board1",
      anchorElementId: "el9",
      userId: "self",
      x: 12,
      y: 34,
      plan: "pro",
      audio: null,
    });
  });

  it("renders both an existing note's badge and the new-note anchor together", () => {
    render(
      <BoardOverlayLayer
        {...baseProps({
          audioNotes: [NOTE],
          newVoiceNoteAnchor: { elementId: "el2", x: 12, y: 34 },
        })}
      />
    );
    expect(mockAudioAffordanceCalls).toHaveLength(2);
    const kinds = mockAudioAffordanceCalls.map((p) => (p.audio ? "playback" : "record"));
    expect(kinds.sort()).toEqual(["playback", "record"]);
  });
});

describe("plan and userId threading", () => {
  it("falls back to an empty userId when currentUserId is undefined", () => {
    render(
      <BoardOverlayLayer {...baseProps({ currentUserId: undefined, audioNotes: [NOTE] })} />
    );
    expect(mockAudioAffordanceCalls[0].userId).toBe("");
  });

  it("passes the free plan through unchanged (advisory gate lives inside AudioAffordance)", () => {
    render(
      <BoardOverlayLayer
        {...baseProps({ plan: "free", newVoiceNoteAnchor: { elementId: "el9", x: 0, y: 0 } })}
      />
    );
    expect(mockAudioAffordanceCalls[0].plan).toBe("free");
  });
});
