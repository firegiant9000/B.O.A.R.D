// Guard-path unit tests for the callable handler. The provider and clock are
// injected; Firestore + board/rate-limit modules are mocked so the auth /
// membership / rate-limit branches are exercised without an emulator. The
// happy-path end-to-end run is the emulator integration test (see the runbook).

jest.mock("firebase-admin/firestore", () => ({ getFirestore: () => ({}) }));
jest.mock("../lib/board");
jest.mock("../ai/rateLimit");
jest.mock("../ai/usage");

import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { handleGenerateSummary, type GenerateSummaryRequest } from "../callable/generateSummary";
import * as board from "../lib/board";
import * as rateLimit from "../ai/rateLimit";
import * as usage from "../ai/usage";
import type { AIProvider } from "../ai/provider";

const resolveBoardAccess = board.resolveBoardAccess as jest.Mock;
const gatherBoardContent = board.gatherBoardContent as jest.Mock;
const consumeToken = rateLimit.consumeToken as jest.Mock;
const recordAiUsage = usage.recordAiUsage as jest.Mock;
const checkAiQuota = usage.checkAiQuota as jest.Mock;

const provider: AIProvider = {
  chat: jest.fn(async () => ({
    text: "A tidy summary.",
    model: "gpt-3.5-turbo",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  })),
};

const data: GenerateSummaryRequest = {
  boardId: "board-1",
  context: { sessionTitle: "S", boardTitle: "B", durationMinutes: 30, participantCount: 2 },
};

function req(over: Partial<CallableRequest<GenerateSummaryRequest>> = {}) {
  return { auth: { uid: "u1" }, data, ...over } as CallableRequest<GenerateSummaryRequest>;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveBoardAccess.mockResolvedValue({ workspaceId: "wsA", isMember: true });
  gatherBoardContent.mockResolvedValue({ notes: ["x"], textElements: [] });
  consumeToken.mockResolvedValue(true);
  recordAiUsage.mockResolvedValue({ period: "2026-06", costUsd: 0.001 });
  checkAiQuota.mockResolvedValue(true);
});

it("rejects an unauthenticated caller", async () => {
  await expect(handleGenerateSummary(req({ auth: undefined }), provider, 0)).rejects.toMatchObject({
    code: "unauthenticated",
  });
});

it("rejects when the board does not exist", async () => {
  resolveBoardAccess.mockResolvedValue(null);
  await expect(handleGenerateSummary(req(), provider, 0)).rejects.toMatchObject({
    code: "not-found",
  });
});

it("denies a non-member of the board", async () => {
  resolveBoardAccess.mockResolvedValue({ workspaceId: "wsA", isMember: false });
  await expect(handleGenerateSummary(req(), provider, 0)).rejects.toMatchObject({
    code: "permission-denied",
  });
});

it("rejects when the rate limit is exhausted", async () => {
  consumeToken.mockResolvedValue(false);
  await expect(handleGenerateSummary(req(), provider, 0)).rejects.toMatchObject({
    code: "resource-exhausted",
  });
});

it("returns the structured summary on the happy path", async () => {
  const res = await handleGenerateSummary(req(), provider, 0);
  // The provider returns non-JSON prose here, so it degrades to a TL;DR.
  expect(res.summary).toEqual({
    tldr: "A tidy summary.",
    actionItems: [],
    decisions: [],
    openQuestions: [],
  });
  expect(provider.chat).toHaveBeenCalledWith(
    expect.objectContaining({ model: "summary-text" })
  );
});

it("parses a structured JSON reply from the model", async () => {
  (provider.chat as jest.Mock).mockResolvedValueOnce({
    text: '{"tldr":"Covered Big-O.","actionItems":["Email notes"],"decisions":[],"openQuestions":["Master theorem?"]}',
    model: "gpt-3.5-turbo",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  });
  const res = await handleGenerateSummary(req(), provider, 0);
  expect(res.summary).toEqual({
    tldr: "Covered Big-O.",
    actionItems: ["Email notes"],
    decisions: [],
    openQuestions: ["Master theorem?"],
  });
});

it("picks the vision model when an image is supplied", async () => {
  await handleGenerateSummary(
    req({ data: { ...data, imageDataUrl: "data:image/png;base64,AA" } }),
    provider,
    0
  );
  expect(provider.chat).toHaveBeenCalledWith(
    expect.objectContaining({ model: "summary-vision" })
  );
});

it("buckets a legacy no-workspace board per user", async () => {
  resolveBoardAccess.mockResolvedValue({ workspaceId: "", isMember: true });
  await handleGenerateSummary(req(), provider, 0);
  expect(consumeToken).toHaveBeenCalledWith(expect.anything(), "solo-u1", 0);
});

it("surfaces an empty model reply as an internal error", async () => {
  (provider.chat as jest.Mock).mockResolvedValueOnce({
    text: "",
    model: "gpt-3.5-turbo",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  await expect(handleGenerateSummary(req(), provider, 0)).rejects.toBeInstanceOf(HttpsError);
});

it("records cost telemetry for the workspace on the happy path", async () => {
  await handleGenerateSummary(req(), provider, 123);
  expect(recordAiUsage).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      workspaceId: "wsA",
      uid: "u1",
      feature: "summary",
      model: "gpt-3.5-turbo",
      now: 123,
    })
  );
});

it("rejects when the workspace AI quota is exhausted", async () => {
  checkAiQuota.mockResolvedValue(false);
  await expect(handleGenerateSummary(req(), provider, 0)).rejects.toMatchObject({
    code: "resource-exhausted",
  });
  // Quota is checked before the provider — no paid call when over the cap.
  expect(provider.chat).not.toHaveBeenCalled();
});

it("still returns the summary when telemetry write fails", async () => {
  recordAiUsage.mockRejectedValue(new Error("firestore down"));
  const res = await handleGenerateSummary(req(), provider, 0);
  expect(res.summary.tldr).toBe("A tidy summary.");
});

it("skips quota + telemetry for a solo/legacy no-workspace board", async () => {
  resolveBoardAccess.mockResolvedValue({ workspaceId: "", isMember: true });
  const res = await handleGenerateSummary(req(), provider, 0);
  expect(res.summary.tldr).toBe("A tidy summary.");
  expect(checkAiQuota).not.toHaveBeenCalled();
  expect(recordAiUsage).not.toHaveBeenCalled();
});
