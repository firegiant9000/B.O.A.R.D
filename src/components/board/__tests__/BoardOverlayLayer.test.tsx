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

// Month 6 — same recipe for the reaction badge.
const mockReactionBadgeCalls: any[] = [];
jest.mock("../ReactionBadge", () => ({
  __esModule: true,
  default: (props: any) => {
    mockReactionBadgeCalls.push(props);
    return null;
  },
}));

// Month 6 — same recipe for the poll card.
const mockPollCardCalls: any[] = [];
jest.mock("../PollCard", () => ({
  __esModule: true,
  default: (props: any) => {
    mockPollCardCalls.push(props);
    return null;
  },
}));

import React from "react";
import { render } from "@testing-library/react-native";
import BoardOverlayLayer, { PositionedAudioNote, PositionedPoll, PositionedReactionBadge } from "../BoardOverlayLayer";
import { AudioElement, PollElement, REACTION_EMOJIS } from "../../../types";
import type { ReactionCount } from "../../../hooks/useBoardReactions";

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
    audioNotes: [] as PositionedAudioNote[],
    newVoiceNoteAnchor: null,
    reactionBadges: [] as PositionedReactionBadge[],
    canReact: true,
    onToggleReaction: jest.fn(),
    positionedPolls: [] as PositionedPoll[],
    canManagePolls: true,
    canVotePolls: true,
    onVotePoll: jest.fn(),
    onToggleDotPoll: jest.fn(),
    onDeletePoll: jest.fn(),
    onAdvanceQuiz: jest.fn(),
    ...overrides,
  };
}

function makePoll(overrides: Partial<PollElement> = {}): PollElement {
  return {
    id: "p1",
    schemaVersion: 1,
    boardId: "board1",
    question: "Q?",
    options: ["A", "B"],
    anonymous: false,
    mode: "single",
    x: 10,
    y: 20,
    createdById: "author",
    createdAt: new Date(),
    ...overrides,
  };
}

function zeroCounts(): ReactionCount[] {
  return REACTION_EMOJIS.map((emoji) => ({ emoji, count: 0, reactedByMe: false }));
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
  // Deliberately different from the positioned x/y below — item 7 (fix
  // round 1) means the note's own persisted x/y must never reach the render.
  x: 999,
  y: 999,
  createdAt: new Date(),
};

// The caller (BoardCanvas) resolves this from the anchor's live bounds; this
// layer just places what it's handed.
const POSITIONED_NOTE: PositionedAudioNote = { note: NOTE, x: 30, y: 40 };

beforeEach(() => {
  mockAudioAffordanceCalls.length = 0;
  mockReactionBadgeCalls.length = 0;
  mockPollCardCalls.length = 0;
});

describe("existing voice notes", () => {
  it("renders one AudioAffordance per note, in playback mode, at the caller-resolved position (not the note's own x/y)", () => {
    render(<BoardOverlayLayer {...baseProps({ audioNotes: [POSITIONED_NOTE] })} />);
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
    const note2: AudioElement = { ...NOTE, id: "a2", anchorElementId: "el2" };
    const positioned2: PositionedAudioNote = { note: note2, x: 99, y: 1 };
    render(<BoardOverlayLayer {...baseProps({ audioNotes: [POSITIONED_NOTE, positioned2] })} />);
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
          audioNotes: [POSITIONED_NOTE],
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
      <BoardOverlayLayer {...baseProps({ currentUserId: undefined, audioNotes: [POSITIONED_NOTE] })} />
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

// Item 11, fix round 1: the badge must counter-scale via AudioAffordance's
// own `scale` prop (dimensions), never a wrapping `transform: scale`
// (center-origin in RN — drifts the badge off its board-space position at
// any zoom ≠ 1). This is the regression test for that fix.
describe("counter-scale (item 11)", () => {
  it("passes 1 / viewport.scale as AudioAffordance's scale prop, not a wrapper transform", () => {
    render(
      <BoardOverlayLayer
        {...baseProps({
          viewport: { x: 0, y: 0, scale: 2 },
          audioNotes: [POSITIONED_NOTE],
          newVoiceNoteAnchor: { elementId: "el9", x: 0, y: 0 },
        })}
      />
    );
    expect(mockAudioAffordanceCalls).toHaveLength(2);
    for (const props of mockAudioAffordanceCalls) {
      expect(props.scale).toBeCloseTo(0.5);
    }
  });

  it("defaults to scale 1 at viewport.scale 1", () => {
    render(<BoardOverlayLayer {...baseProps({ audioNotes: [POSITIONED_NOTE] })} />);
    expect(mockAudioAffordanceCalls[0].scale).toBe(1);
  });
});

// Month 6 — reactions. Mirrors the voice-note describes above exactly: this
// layer is dumb, so these assert what it's handed reaches ReactionBadge
// unchanged, at the caller-resolved position.
describe("reaction badges", () => {
  const BADGE: PositionedReactionBadge = { elementId: "el1", x: 12, y: 34, counts: zeroCounts() };

  it("renders one ReactionBadge per entry, at the given position, with counts/canReact threaded through", () => {
    render(
      <BoardOverlayLayer
        {...baseProps({ reactionBadges: [BADGE], canReact: true })}
      />
    );
    expect(mockReactionBadgeCalls).toHaveLength(1);
    expect(mockReactionBadgeCalls[0]).toMatchObject({ counts: BADGE.counts, canReact: true });
  });

  it("renders nothing when there are no reaction badges", () => {
    render(<BoardOverlayLayer {...baseProps()} />);
    expect(mockReactionBadgeCalls).toHaveLength(0);
  });

  it("renders one ReactionBadge per element for multiple badges", () => {
    const badge2: PositionedReactionBadge = { elementId: "el2", x: 1, y: 1, counts: zeroCounts() };
    render(<BoardOverlayLayer {...baseProps({ reactionBadges: [BADGE, badge2] })} />);
    expect(mockReactionBadgeCalls).toHaveLength(2);
  });

  it("threads canReact: false through to a viewer who can't react", () => {
    render(<BoardOverlayLayer {...baseProps({ reactionBadges: [BADGE], canReact: false })} />);
    expect(mockReactionBadgeCalls[0].canReact).toBe(false);
  });

  it("composes onToggle so pressing an emoji calls the layer's onToggleReaction with (elementId, emoji)", () => {
    const onToggleReaction = jest.fn();
    render(
      <BoardOverlayLayer {...baseProps({ reactionBadges: [BADGE], onToggleReaction })} />
    );
    mockReactionBadgeCalls[0].onToggle("👍");
    expect(onToggleReaction).toHaveBeenCalledWith("el1", "👍");
  });

  it("passes 1 / viewport.scale as ReactionBadge's scale prop, same as the voice-note badges", () => {
    render(
      <BoardOverlayLayer
        {...baseProps({ viewport: { x: 0, y: 0, scale: 2 }, reactionBadges: [BADGE] })}
      />
    );
    expect(mockReactionBadgeCalls[0].scale).toBeCloseTo(0.5);
  });
});

// Month 6 — polls. Same "this layer is dumb" recipe as reaction badges above:
// asserts what's handed reaches PollCard unchanged, at the poll's OWN
// persisted (x, y) — there is no live-element-geometry join for polls (see
// PositionedPoll's comment), unlike reactions/audio.
describe("polls", () => {
  const POLL: PositionedPoll = { poll: makePoll({ id: "p1", x: 12, y: 34 }), results: null, myVote: [] };

  it("renders one PollCard per entry, with results/myVote/canVote/canManage threaded through", () => {
    render(
      <BoardOverlayLayer
        {...baseProps({ positionedPolls: [POLL], canVotePolls: true, canManagePolls: false })}
      />
    );
    expect(mockPollCardCalls).toHaveLength(1);
    expect(mockPollCardCalls[0]).toMatchObject({
      poll: POLL.poll,
      results: null,
      myVote: [],
      canVote: true,
      canManage: false,
    });
  });

  it("renders nothing when there are no polls to show", () => {
    render(<BoardOverlayLayer {...baseProps()} />);
    expect(mockPollCardCalls).toHaveLength(0);
  });

  it("renders one PollCard per poll for multiple polls", () => {
    const poll2: PositionedPoll = { poll: makePoll({ id: "p2" }), results: null, myVote: [] };
    render(<BoardOverlayLayer {...baseProps({ positionedPolls: [POLL, poll2] })} />);
    expect(mockPollCardCalls).toHaveLength(2);
  });

  it("composes onVote so tapping an option calls the layer's onVotePoll with (pollId, optionIndex)", () => {
    const onVotePoll = jest.fn();
    render(<BoardOverlayLayer {...baseProps({ positionedPolls: [POLL], onVotePoll })} />);
    mockPollCardCalls[0].onVote(1);
    expect(onVotePoll).toHaveBeenCalledWith("p1", 1);
  });

  it("composes onToggleDot so tapping a dot calls the layer's onToggleDotPoll with (pollId, optionIndex)", () => {
    const onToggleDotPoll = jest.fn();
    render(<BoardOverlayLayer {...baseProps({ positionedPolls: [POLL], onToggleDotPoll })} />);
    mockPollCardCalls[0].onToggleDot(2);
    expect(onToggleDotPoll).toHaveBeenCalledWith("p1", 2);
  });

  it("composes onDelete so it calls the layer's onDeletePoll with the pollId", () => {
    const onDeletePoll = jest.fn();
    render(<BoardOverlayLayer {...baseProps({ positionedPolls: [POLL], onDeletePoll })} />);
    mockPollCardCalls[0].onDelete();
    expect(onDeletePoll).toHaveBeenCalledWith("p1");
  });

  it("omits onAdvanceQuiz for a standalone (non-quiz) poll", () => {
    render(<BoardOverlayLayer {...baseProps({ positionedPolls: [POLL] })} />);
    expect(mockPollCardCalls[0].onAdvanceQuiz).toBeUndefined();
  });

  it("composes onAdvanceQuiz for a quiz question, calling the layer's onAdvanceQuiz with its quizId", () => {
    const onAdvanceQuiz = jest.fn();
    const quizPoll: PositionedPoll = { poll: makePoll({ id: "q1", quizId: "quiz1", active: true }), results: null, myVote: [] };
    render(<BoardOverlayLayer {...baseProps({ positionedPolls: [quizPoll], onAdvanceQuiz })} />);
    expect(mockPollCardCalls[0].onAdvanceQuiz).toBeInstanceOf(Function);
    mockPollCardCalls[0].onAdvanceQuiz();
    expect(onAdvanceQuiz).toHaveBeenCalledWith("quiz1");
  });

  it("passes 1 / viewport.scale as PollCard's scale prop, same as the other overlay badges", () => {
    render(
      <BoardOverlayLayer {...baseProps({ viewport: { x: 0, y: 0, scale: 2 }, positionedPolls: [POLL] })} />
    );
    expect(mockPollCardCalls[0].scale).toBeCloseTo(0.5);
  });
});
