jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));
jest.mock("../../lib/errorReporting", () => ({ captureException: jest.fn() }));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));
jest.mock("../pathService", () => ({
  getBoardNotes: jest.fn(),
  getBoardTextElements: jest.fn(),
}));

import * as fs from "firebase/firestore";
import { auth } from "../../config/firebase";
import { makeDocSnap } from "../../test-utils/firestoreMock";
import * as aiService from "../aiService";
import * as pathService from "../pathService";

const setDoc = fs.setDoc as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (auth as { currentUser: unknown }).currentUser = null;
  (global as any).fetch = jest.fn();
});

describe("key management", () => {
  it("setOpenAIKey caches locally and skips Firestore when signed out", async () => {
    await aiService.setOpenAIKey("sk-abc");
    expect(aiService.getOpenAIKey()).toBe("sk-abc");
    expect(setDoc).not.toHaveBeenCalled();
  });

  it("setOpenAIKey writes to the user's private doc when signed in", async () => {
    (auth as { currentUser: unknown }).currentUser = { uid: "u1" };
    await aiService.setOpenAIKey("sk-xyz");
    expect(setDoc).toHaveBeenCalledTimes(1);
    expect(setDoc.mock.calls[0][1]).toEqual({ openaiKey: "sk-xyz" });
  });

  it("loadOpenAIKey reads the key from Firestore when present", async () => {
    (auth as { currentUser: unknown }).currentUser = { uid: "u1" };
    getDoc.mockResolvedValueOnce(makeDocSnap("apiKeys", { openaiKey: "sk-from-db" }));
    await aiService.loadOpenAIKey();
    expect(aiService.getOpenAIKey()).toBe("sk-from-db");
  });
});

describe("generateSessionSummary", () => {
  const ctx = {
    sessionTitle: "Study",
    boardTitle: "Board",
    durationMinutes: 30,
    participantCount: 2,
  };

  it("throws a helpful error when no key is configured", async () => {
    await aiService.clearOpenAIKey(); // resets cached key to null
    await expect(aiService.generateSessionSummary("board-1", ctx)).rejects.toThrow(
      /API key not configured/i
    );
  });

  it("returns the model summary on a successful call", async () => {
    await aiService.setOpenAIKey("sk-abc");
    (pathService.getBoardNotes as jest.Mock).mockResolvedValueOnce([
      { content: "Big-O notation" },
    ]);
    (pathService.getBoardTextElements as jest.Mock).mockResolvedValueOnce([]);
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "  A tidy summary.  " } }] }),
    }));

    const summary = await aiService.generateSessionSummary("board-1", ctx);

    expect(summary).toBe("A tidy summary.");
    expect((global as any).fetch).toHaveBeenCalledTimes(1);
  });

  it("throws when the API responds with an error status", async () => {
    await aiService.setOpenAIKey("sk-abc");
    (pathService.getBoardNotes as jest.Mock).mockResolvedValueOnce([]);
    (pathService.getBoardTextElements as jest.Mock).mockResolvedValueOnce([]);
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));

    await expect(aiService.generateSessionSummary("board-1", ctx)).rejects.toThrow(
      /AI API error \(429\)/
    );
  });
});
