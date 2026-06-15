// Guard-path + validate-and-retry unit tests for the text→diagram callable
// handler. The AIProvider and clock are injected; Firestore + board / rate-limit /
// usage modules are mocked so branches run without an emulator (mirrors
// recognizeHandwriting.test.ts).

jest.mock("firebase-admin/firestore", () => ({ getFirestore: () => ({}) }));
jest.mock("../lib/board");
jest.mock("../ai/rateLimit");
jest.mock("../ai/usage");

import { type CallableRequest } from "firebase-functions/v2/https";
import { handleTextToDiagram, type TextToDiagramRequest } from "../callable/textToDiagram";
import * as board from "../lib/board";
import * as rateLimit from "../ai/rateLimit";
import * as usage from "../ai/usage";
import type { AIProvider } from "../ai/provider";

const resolveBoardAccess = board.resolveBoardAccess as jest.Mock;
const consumeToken = rateLimit.consumeToken as jest.Mock;
const recordAiUsage = usage.recordAiUsage as jest.Mock;
const checkAiQuota = usage.checkAiQuota as jest.Mock;

const GOOD = "flowchart TD\n  A --> B";
const usageStub = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };

function makeProvider(replies: string[]): AIProvider {
  let i = 0;
  return {
    chat: jest.fn(async () => ({
      text: replies[Math.min(i++, replies.length - 1)],
      model: "gpt-4o-mini",
      usage: usageStub,
    })),
  };
}

const data: TextToDiagramRequest = { boardId: "board-1", prompt: "a login flow" };

function req(over: Partial<CallableRequest<TextToDiagramRequest>> = {}) {
  return { auth: { uid: "u1" }, data, ...over } as CallableRequest<TextToDiagramRequest>;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveBoardAccess.mockResolvedValue({ workspaceId: "wsA", isMember: true });
  consumeToken.mockResolvedValue(true);
  recordAiUsage.mockResolvedValue({ period: "2026-06", costUsd: 0.001 });
  checkAiQuota.mockResolvedValue(true);
});

it("rejects an unauthenticated caller", async () => {
  await expect(
    handleTextToDiagram(req({ auth: undefined }), makeProvider([GOOD]), 0)
  ).rejects.toMatchObject({ code: "unauthenticated" });
});

it("rejects a blank prompt", async () => {
  await expect(
    handleTextToDiagram(req({ data: { boardId: "board-1", prompt: "  " } }), makeProvider([GOOD]), 0)
  ).rejects.toMatchObject({ code: "invalid-argument" });
});

it("denies a non-member of the board", async () => {
  resolveBoardAccess.mockResolvedValue({ workspaceId: "wsA", isMember: false });
  await expect(handleTextToDiagram(req(), makeProvider([GOOD]), 0)).rejects.toMatchObject({
    code: "permission-denied",
  });
});

it("returns valid Mermaid on the first try without retrying", async () => {
  const provider = makeProvider([GOOD]);
  const res = await handleTextToDiagram(req(), provider, 0);
  expect(res).toMatchObject({ mermaid: GOOD, family: "flowchart", retried: false });
  expect(provider.chat).toHaveBeenCalledTimes(1);
  expect(recordAiUsage).toHaveBeenCalledTimes(1);
});

it("retries once with the stricter prompt after an invalid first reply", async () => {
  const provider = makeProvider(["sorry, here is a chart of the flow", GOOD]);
  const res = await handleTextToDiagram(req(), provider, 0);
  expect(res).toMatchObject({ mermaid: GOOD, retried: true });
  expect(provider.chat).toHaveBeenCalledTimes(2);
  // The retry used the stricter system prompt.
  const secondCall = (provider.chat as jest.Mock).mock.calls[1][0];
  expect(secondCall.messages[0].content).toContain("could not be parsed");
  // Both paid attempts are metered.
  expect(recordAiUsage).toHaveBeenCalledTimes(2);
});

it("fails after the retry also produces garbage", async () => {
  const provider = makeProvider(["nope", "still prose"]);
  await expect(handleTextToDiagram(req(), provider, 0)).rejects.toMatchObject({
    code: "internal",
  });
  expect(provider.chat).toHaveBeenCalledTimes(2);
});

it("consumes only one rate-limit token across both attempts", async () => {
  const provider = makeProvider(["bad", GOOD]);
  await handleTextToDiagram(req(), provider, 0);
  expect(consumeToken).toHaveBeenCalledTimes(1);
});

it("rejects when the rate limit is exhausted", async () => {
  consumeToken.mockResolvedValue(false);
  await expect(handleTextToDiagram(req(), makeProvider([GOOD]), 0)).rejects.toMatchObject({
    code: "resource-exhausted",
  });
});

it("rejects when the workspace AI quota is exhausted", async () => {
  checkAiQuota.mockResolvedValue(false);
  const provider = makeProvider([GOOD]);
  await expect(handleTextToDiagram(req(), provider, 0)).rejects.toMatchObject({
    code: "resource-exhausted",
  });
  expect(provider.chat).not.toHaveBeenCalled();
});

it("buckets a legacy no-workspace board per user and skips telemetry", async () => {
  resolveBoardAccess.mockResolvedValue({ workspaceId: "", isMember: true });
  const res = await handleTextToDiagram(req(), makeProvider([GOOD]), 0);
  expect(consumeToken).toHaveBeenCalledWith(expect.anything(), "solo-u1", 0);
  expect(checkAiQuota).not.toHaveBeenCalled();
  expect(recordAiUsage).not.toHaveBeenCalled();
  expect(res.mermaid).toBe(GOOD);
});
