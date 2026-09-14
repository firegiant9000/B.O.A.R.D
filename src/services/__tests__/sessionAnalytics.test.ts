// analyticsService has no Firebase import in its own graph, so a plain
// automock is enough here (same note as templateService.test.ts).
jest.mock("../analyticsService");

import { track } from "../analyticsService";
import { trackSessionCompleted, trackAiSummaryGenerated } from "../sessionAnalytics";
import type { Session, SessionSummary } from "../../types";

const mockTrack = track as jest.Mock;

// Deliberately hostile: every free-text field on a Session is filled with a
// distinctive marker, so any property that leaks one shows up by name in the
// PII assertions below rather than having to be anticipated field by field.
const FREE_TEXT = {
  title: "Ms Alvarez period 3 — LEAK_TITLE",
  boardTitle: "Chem revision LEAK_BOARD_TITLE",
  description: "LEAK_DESCRIPTION",
  agenda: "LEAK_AGENDA",
  createdByName: "LEAK_CREATOR_NAME",
};

const session = (overrides: Partial<Session> = {}): Session => ({
  id: "sess-1",
  workspaceId: "ws-1",
  boardId: "board-1",
  boardTitle: FREE_TEXT.boardTitle,
  title: FREE_TEXT.title,
  description: FREE_TEXT.description,
  scheduledAt: new Date("2026-09-01T10:00:00Z"),
  durationMinutes: 45,
  createdById: "uid-creator",
  createdByName: FREE_TEXT.createdByName,
  participantIds: ["uid-a", "uid-b"],
  status: "ended",
  agenda: FREE_TEXT.agenda,
  participants: [
    { uid: "uid-a", displayName: "LEAK_PARTICIPANT_NAME", email: "student@university.edu" },
  ],
  createdAt: new Date("2026-08-30T10:00:00Z"),
  ...overrides,
});

const summary: SessionSummary = {
  tldr: "LEAK_TLDR",
  actionItems: ["LEAK_ACTION_1", "LEAK_ACTION_2", "LEAK_ACTION_3"],
  decisions: ["LEAK_DECISION"],
  openQuestions: [],
};

/** Everything that reached the seam, as one string. The PII tests assert
 *  against this rather than against a named property, so a leak added under a
 *  property nobody thought to check still fails. */
const emitted = () => JSON.stringify(mockTrack.mock.calls);

describe("sessionAnalytics", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("trackSessionCompleted", () => {
    it("emits session_completed with counts and surface, and nothing else", () => {
      trackSessionCompleted(session(), "board", true);
      expect(mockTrack).toHaveBeenCalledWith("session_completed", {
        surface: "board",
        snapshotCaptured: true,
        participantCount: 2,
        plannedDurationMinutes: 45,
        hadAgenda: true,
      });
    });

    it("reports snapshotCaptured from the caller, not from the stale session object", () => {
      // The board screen writes the snapshot as part of the same endSession
      // call, so its local Session predates that write and would report false.
      trackSessionCompleted(session({ canvasSnapshot: undefined }), "board", true);
      expect(mockTrack.mock.calls[0][1]).toMatchObject({ snapshotCaptured: true });
    });

    it.each(["board", "schedule", "session-detail"] as const)(
      "distinguishes the %s surface, so three end paths stay separable downstream",
      (surface) => {
        trackSessionCompleted(session(), surface, false);
        expect(mockTrack.mock.calls[0][1]).toMatchObject({ surface });
      }
    );

    it("reports hadAgenda as false for a session with no agenda, rather than omitting the key", () => {
      trackSessionCompleted(session({ agenda: undefined }), "schedule", false);
      expect(mockTrack.mock.calls[0][1]).toMatchObject({ hadAgenda: false });
    });
  });

  describe("trackAiSummaryGenerated", () => {
    it("emits ai_summary_generated with structure counts, never the summary text", () => {
      trackAiSummaryGenerated(session({ canvasSnapshot: "data:image/png;base64,AAA" }), summary, "schedule");
      expect(mockTrack).toHaveBeenCalledWith("ai_summary_generated", {
        surface: "schedule",
        hadSnapshot: true,
        participantCount: 2,
        plannedDurationMinutes: 45,
        actionItemCount: 3,
        decisionCount: 1,
        openQuestionCount: 0,
      });
    });

    it("reports hadSnapshot false when the model was given no canvas image", () => {
      trackAiSummaryGenerated(session({ canvasSnapshot: undefined }), summary, "session-detail");
      expect(mockTrack.mock.calls[0][1]).toMatchObject({ hadSnapshot: false });
    });

    it("counts a legacy plain-string summary as unstructured instead of throwing on .actionItems", () => {
      // Sessions summarized before Month 4's Phase 3 carry a string on disk
      // (see Session.summary in src/types). `tsc` forbids passing one here, so
      // the cast is the point of the test: this is about what arrives at
      // runtime from a document written by an older build.
      const legacy = "A plain string summary from an older build" as unknown as SessionSummary;
      expect(() => trackAiSummaryGenerated(session(), legacy, "schedule")).not.toThrow();
      expect(mockTrack.mock.calls[0][1]).toMatchObject({
        actionItemCount: 0,
        decisionCount: 0,
        openQuestionCount: 0,
      });
    });
  });

  // The reason this module exists rather than five inline track() calls: one
  // reviewable place decides what a session may report. These assertions are
  // what makes that claim checkable.
  describe("PII — no identifier and no user-authored text may reach the seam", () => {
    it("sends no free text from the session on either event", () => {
      trackSessionCompleted(session(), "board", true);
      trackAiSummaryGenerated(session(), summary, "schedule");
      for (const marker of Object.values(FREE_TEXT)) {
        expect(emitted()).not.toContain(marker);
      }
      expect(emitted()).not.toContain("LEAK_PARTICIPANT_NAME");
      expect(emitted()).not.toContain("LEAK_TLDR");
      expect(emitted()).not.toContain("LEAK_ACTION_1");
      expect(emitted()).not.toContain("LEAK_DECISION");
    });

    it("sends no raw id of any kind — not the session, board, workspace, creator, or any participant", () => {
      trackSessionCompleted(session(), "board", true);
      trackAiSummaryGenerated(session(), summary, "schedule");
      for (const id of ["sess-1", "ws-1", "board-1", "uid-creator", "uid-a", "uid-b"]) {
        expect(emitted()).not.toContain(id);
      }
    });

    it("sends no email address, even though the scrub would also have caught one", () => {
      // Belt and braces: analyticsService's scrub strips email-shaped values,
      // but it is the last line of defence, not the first. Nothing here should
      // ever hand it one to strip.
      trackSessionCompleted(session(), "board", true);
      expect(emitted()).not.toContain("student@university.edu");
      expect(emitted()).not.toContain("@");
    });
  });
});
