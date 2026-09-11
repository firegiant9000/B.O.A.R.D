// See boardService.test.ts / templateService.test.ts for why the Firebase
// seams are mocked rather than automocked: boardService/pathService/
// sessionService/templateService all transitively import firebase/firestore,
// which ships ESM this repo's Jest transform can't parse.
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
const mockCallable = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: (..._args: unknown[]) => mockCallable,
}));

import * as fs from "firebase/firestore";
import { makeDocSnap } from "../../test-utils/firestoreMock";
import * as boardService from "../boardService";
import * as sessionService from "../sessionService";
import * as pathService from "../pathService";
import * as templateService from "../templateService";
import {
  seedSampleWorkspace,
  SAMPLE_SESSION_SUMMARY,
  SAMPLE_ROSTER_NOTE_CONTENT,
} from "../onboardingService";

const getDoc = fs.getDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;

const mockCreateBoard = jest.spyOn(boardService, "createBoard");
const mockDeleteBoard = jest.spyOn(boardService, "deleteBoard").mockResolvedValue(undefined);
const mockApplyTemplate = jest.spyOn(templateService, "applyTemplateToBoard").mockResolvedValue(undefined);
const mockSaveTextNote = jest.spyOn(pathService, "saveTextNote").mockResolvedValue("note-id");
const mockCreateSession = jest.spyOn(sessionService, "createSession");
const mockEndSession = jest.spyOn(sessionService, "endSession").mockResolvedValue(undefined);
const mockUpdateSessionSummary = jest
  .spyOn(sessionService, "updateSessionSummary")
  .mockResolvedValue(undefined);
const mockDeleteSession = jest.spyOn(sessionService, "deleteSession").mockResolvedValue(undefined);

const cornellTemplate = templateService.getTemplate("cornell-notes")!;

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteBoard.mockResolvedValue(undefined);
  mockApplyTemplate.mockResolvedValue(undefined);
  mockSaveTextNote.mockResolvedValue("note-id");
  mockEndSession.mockResolvedValue(undefined);
  mockUpdateSessionSummary.mockResolvedValue(undefined);
  mockDeleteSession.mockResolvedValue(undefined);
  mockCreateBoard.mockResolvedValue("board-1");
  mockCreateSession.mockResolvedValue("session-1");
  // Default: a real workspace doc, not yet seeded.
  getDoc.mockResolvedValue(makeDocSnap("ws-1", {}));
  updateDoc.mockResolvedValue(undefined);
});

describe("seedSampleWorkspace", () => {
  it("creates the board from the Cornell Notes template, seeds its elements, and adds the mock roster note", async () => {
    await seedSampleWorkspace("ws-1", "u1", "Arlo");

    expect(mockCreateBoard).toHaveBeenCalledWith("Cornell Notes", "u1", "ws-1", "free", 0);
    expect(mockApplyTemplate).toHaveBeenCalledWith("board-1", "u1", cornellTemplate);
    expect(mockSaveTextNote).toHaveBeenCalledWith("board-1", {
      boardId: "board-1",
      userId: "u1",
      content: SAMPLE_ROSTER_NOTE_CONTENT,
      position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    });
  });

  it("creates a session on the sample board, ends it, and attaches the canned summary — never a real AI call", async () => {
    await seedSampleWorkspace("ws-1", "u1", "Arlo");

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        boardId: "board-1",
        createdById: "u1",
        createdByName: "Arlo",
      }),
      { plan: "free", currentCount: 0 }
    );
    expect(mockEndSession).toHaveBeenCalledWith("session-1");
    // The summary is the module's own canned constant, written directly —
    // nothing here goes through a generateSummary/AI callable path (no such
    // service is imported by onboardingService.ts at all).
    expect(mockUpdateSessionSummary).toHaveBeenCalledWith("session-1", SAMPLE_SESSION_SUMMARY);
  });

  it("marks the workspace seeded on full success", async () => {
    await seedSampleWorkspace("ws-1", "u1", "Arlo");

    expect(updateDoc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sampleSeededAt: "__serverTimestamp__" })
    );
  });

  it("does nothing when the workspace doc doesn't exist", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("ws-missing", null));

    await seedSampleWorkspace("ws-missing", "u1", "Arlo");

    expect(mockCreateBoard).not.toHaveBeenCalled();
  });

  describe("idempotency", () => {
    it("does not seed a second time once the workspace is already marked seeded", async () => {
      getDoc.mockResolvedValue(makeDocSnap("ws-1", { sampleSeededAt: { seconds: 1 } }));

      await seedSampleWorkspace("ws-1", "u1", "Arlo");

      expect(mockCreateBoard).not.toHaveBeenCalled();
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("signing in twice (calling seedSampleWorkspace twice in a row) only seeds once", async () => {
      // First call: not yet seeded -> seeds, and (per the mock) "writes" the marker.
      getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", {}));
      await seedSampleWorkspace("ws-1", "u1", "Arlo");
      expect(mockCreateBoard).toHaveBeenCalledTimes(1);

      // Second call ("signing in twice"): the workspace doc now reflects the marker.
      getDoc.mockResolvedValueOnce(makeDocSnap("ws-1", { sampleSeededAt: { seconds: 1 } }));
      await seedSampleWorkspace("ws-1", "u1", "Arlo");

      expect(mockCreateBoard).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("CF-14 — rollback on partial-write failure", () => {
    it("deletes the freshly-created board when applyTemplateToBoard throws partway through, and never proceeds to the session phase", async () => {
      mockApplyTemplate.mockRejectedValueOnce(new Error("write failed partway"));

      await seedSampleWorkspace("ws-1", "u1", "Arlo");

      expect(mockDeleteBoard).toHaveBeenCalledWith("board-1");
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(updateDoc).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sampleSeededAt: expect.anything() })
      );
    });

    it("deletes the board when the roster note write fails", async () => {
      mockSaveTextNote.mockRejectedValueOnce(new Error("note write failed"));

      await seedSampleWorkspace("ws-1", "u1", "Arlo");

      expect(mockDeleteBoard).toHaveBeenCalledWith("board-1");
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("deletes the board (there is no session to delete) when createSession itself fails", async () => {
      mockCreateSession.mockRejectedValueOnce(new Error("session cap hit"));

      await seedSampleWorkspace("ws-1", "u1", "Arlo");

      expect(mockDeleteBoard).toHaveBeenCalledWith("board-1");
      expect(mockDeleteSession).not.toHaveBeenCalled();
    });

    it("deletes BOTH the session and the board when endSession fails after the session was created", async () => {
      mockEndSession.mockRejectedValueOnce(new Error("write failed"));

      await seedSampleWorkspace("ws-1", "u1", "Arlo");

      expect(mockDeleteSession).toHaveBeenCalledWith("session-1");
      expect(mockDeleteBoard).toHaveBeenCalledWith("board-1");
    });

    it("deletes BOTH the session and the board when the final marker write fails after a full success", async () => {
      updateDoc.mockRejectedValueOnce(new Error("marker write failed"));

      await seedSampleWorkspace("ws-1", "u1", "Arlo");

      expect(mockDeleteSession).toHaveBeenCalledWith("session-1");
      expect(mockDeleteBoard).toHaveBeenCalledWith("board-1");
    });

    it("never throws out of seedSampleWorkspace even when rollback itself also fails", async () => {
      mockApplyTemplate.mockRejectedValueOnce(new Error("write failed partway"));
      mockDeleteBoard.mockRejectedValueOnce(new Error("delete also failed"));

      await expect(seedSampleWorkspace("ws-1", "u1", "Arlo")).resolves.toBeUndefined();
    });
  });
});
