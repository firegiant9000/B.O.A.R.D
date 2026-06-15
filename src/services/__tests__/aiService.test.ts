jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({
  db: {},
  auth: { currentUser: null },
  functions: {},
}));
const mockCallable = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: () => mockCallable,
}));
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

    // Legacy prose is wrapped into the structured shape as the TL;DR.
    expect(summary).toEqual({
      tldr: "A tidy summary.",
      actionItems: [],
      decisions: [],
      openQuestions: [],
    });
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

describe("gateway path (AI_GATEWAY_ENABLED)", () => {
  const ctx = {
    sessionTitle: "Study",
    boardTitle: "Board",
    durationMinutes: 30,
    participantCount: 2,
  };

  // The flag is read at module-eval, so re-import aiService with the env set.
  function loadWithGateway() {
    let svc: typeof import("../aiService");
    jest.isolateModules(() => {
      process.env.EXPO_PUBLIC_AI_GATEWAY = "1";
      svc = require("../aiService");
    });
    return svc!;
  }

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_AI_GATEWAY;
  });

  it("calls the callable and returns its structured summary (no key, no fetch)", async () => {
    const svc = loadWithGateway();
    const structured = {
      tldr: "Gateway summary.",
      actionItems: ["Follow up"],
      decisions: [],
      openQuestions: [],
    };
    mockCallable.mockResolvedValueOnce({ data: { summary: structured, model: "gpt-3.5-turbo" } });

    const summary = await svc.generateSessionSummary("board-1", ctx, "data:image/png;base64,AA");

    expect(summary).toEqual(structured);
    expect(mockCallable).toHaveBeenCalledWith({
      boardId: "board-1",
      context: ctx,
      imageDataUrl: "data:image/png;base64,AA",
    });
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it("tolerates an older function that still returns a string summary", async () => {
    const svc = loadWithGateway();
    mockCallable.mockResolvedValueOnce({ data: { summary: "Plain text.", model: "gpt-3.5-turbo" } });

    const summary = await svc.generateSessionSummary("board-1", ctx);

    expect(summary).toEqual({
      tldr: "Plain text.",
      actionItems: [],
      decisions: [],
      openQuestions: [],
    });
  });

  it("surfaces the function error message", async () => {
    const svc = loadWithGateway();
    mockCallable.mockRejectedValueOnce(new Error("Too many AI requests right now."));

    await expect(svc.generateSessionSummary("board-1", ctx)).rejects.toThrow(
      /Too many AI requests/
    );
  });

  it("isSummaryConfigured is true with the gateway on even without a key", () => {
    const svc = loadWithGateway();
    expect(svc.isSummaryConfigured()).toBe(true);
  });
});

describe("recognizeHandwriting (Phase 10 OCR)", () => {
  it("calls the callable and returns its result", async () => {
    mockCallable.mockResolvedValueOnce({
      data: { text: "Hello", confidence: 0.95, source: "vision", cached: false },
    });

    const res = await aiService.recognizeHandwriting("board-1", "data:image/png;base64,AA", [
      "p1",
      "p2",
    ]);

    expect(res).toEqual({ text: "Hello", confidence: 0.95, source: "vision", cached: false });
    expect(mockCallable).toHaveBeenCalledWith({
      boardId: "board-1",
      imageDataUrl: "data:image/png;base64,AA",
      pathIds: ["p1", "p2"],
    });
  });

  it("throws on an empty recognition", async () => {
    mockCallable.mockResolvedValueOnce({ data: { text: "", confidence: 0, source: "gpt", cached: false } });
    await expect(
      aiService.recognizeHandwriting("board-1", "data:image/png;base64,AA", ["p1"])
    ).rejects.toThrow(/No legible text/i);
  });

  it("surfaces the function error message", async () => {
    mockCallable.mockRejectedValueOnce(new Error("Too many AI requests right now."));
    await expect(
      aiService.recognizeHandwriting("board-1", "data:image/png;base64,AA", ["p1"])
    ).rejects.toThrow(/Too many AI requests/);
  });

  it("isOcrConfigured requires both the OCR and gateway flags", () => {
    // Neither flag set in this default-import context.
    expect(aiService.isOcrConfigured()).toBe(false);
  });
});

describe("explainSelection (Phase 11)", () => {
  it("calls the callable with image + text and returns its result", async () => {
    const result = { concept: "Big-O", explanation: "Growth rate.", example: "" };
    mockCallable.mockResolvedValueOnce({
      data: { result, text: "Big-O\n\nGrowth rate.", model: "gpt-4o-mini" },
    });

    const res = await aiService.explainSelection(
      "board-1",
      "data:image/png;base64,AA",
      "O(n log n)"
    );

    expect(res.text).toBe("Big-O\n\nGrowth rate.");
    expect(res.result).toEqual(result);
    expect(mockCallable).toHaveBeenCalledWith({
      boardId: "board-1",
      imageDataUrl: "data:image/png;base64,AA",
      selectionText: "O(n log n)",
    });
  });

  it("throws when the function returns no text", async () => {
    mockCallable.mockResolvedValueOnce({ data: { result: {}, text: "", model: "gpt-4o-mini" } });
    await expect(aiService.explainSelection("board-1", "data:image/png;base64,AA")).rejects.toThrow(
      /Couldn't produce an explanation/i
    );
  });

  it("surfaces the function error message", async () => {
    mockCallable.mockRejectedValueOnce(new Error("Too many AI requests right now."));
    await expect(aiService.explainSelection("board-1", undefined, "x")).rejects.toThrow(
      /Too many AI requests/
    );
  });

  it("isExplainConfigured requires both the explain and gateway flags", () => {
    expect(aiService.isExplainConfigured()).toBe(false);
  });
});

describe("textToDiagram (Phase 12)", () => {
  it("calls the callable with the prompt and returns the Mermaid result", async () => {
    mockCallable.mockResolvedValueOnce({
      data: { mermaid: "flowchart TD\n A-->B", family: "flowchart", model: "gpt-4o-mini", retried: false },
    });

    const res = await aiService.textToDiagram("board-1", "a login flow");

    expect(res.mermaid).toBe("flowchart TD\n A-->B");
    expect(res.family).toBe("flowchart");
    expect(mockCallable).toHaveBeenCalledWith({ boardId: "board-1", prompt: "a login flow" });
  });

  it("throws when the function returns no Mermaid", async () => {
    mockCallable.mockResolvedValueOnce({ data: { mermaid: "", family: "flowchart", model: "x", retried: false } });
    await expect(aiService.textToDiagram("board-1", "x")).rejects.toThrow(
      /Couldn't generate a diagram/i
    );
  });

  it("surfaces the function error message", async () => {
    mockCallable.mockRejectedValueOnce(new Error("Too many AI requests right now."));
    await expect(aiService.textToDiagram("board-1", "x")).rejects.toThrow(/Too many AI requests/);
  });

  it("isDiagramConfigured requires both the diagram and gateway flags", () => {
    expect(aiService.isDiagramConfigured()).toBe(false);
  });
});
