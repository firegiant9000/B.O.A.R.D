// Guard-path + escalation + cache unit tests for the OCR callable handler. The
// Vision client, AIProvider, and clock are injected; Firestore + board / rate-limit
// / usage / cache modules are mocked so the branches are exercised without an
// emulator (mirrors generateSummary.test.ts).

jest.mock("firebase-admin/firestore", () => ({ getFirestore: () => ({}) }));
jest.mock("../lib/board");
jest.mock("../ai/rateLimit");
jest.mock("../ai/usage");
jest.mock("../ai/ocrCache");

import { type CallableRequest } from "firebase-functions/v2/https";
import {
  handleRecognizeHandwriting,
  type RecognizeHandwritingRequest,
} from "../callable/recognizeHandwriting";
import * as board from "../lib/board";
import * as rateLimit from "../ai/rateLimit";
import * as usage from "../ai/usage";
import * as ocrCache from "../ai/ocrCache";
import type { AIProvider } from "../ai/provider";
import type { VisionClient } from "../ai/vision";

const resolveBoardAccess = board.resolveBoardAccess as jest.Mock;
const consumeToken = rateLimit.consumeToken as jest.Mock;
const recordAiUsage = usage.recordAiUsage as jest.Mock;
const checkAiQuota = usage.checkAiQuota as jest.Mock;
const getCachedOcr = ocrCache.getCachedOcr as jest.Mock;
const putCachedOcr = ocrCache.putCachedOcr as jest.Mock;
const ocrCacheKey = ocrCache.ocrCacheKey as jest.Mock;

const vision: VisionClient = {
  detectHandwriting: jest.fn(async () => ({ text: "Hello world", confidence: 0.95 })),
};
const provider: AIProvider = {
  chat: jest.fn(async () => ({
    text: '{"text":"Hello world","confidence":0.9}',
    model: "gpt-4o-mini",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  })),
};

const data: RecognizeHandwritingRequest = {
  boardId: "board-1",
  imageDataUrl: "data:image/png;base64,AA",
  pathIds: ["p2", "p1"],
};

function req(over: Partial<CallableRequest<RecognizeHandwritingRequest>> = {}) {
  return { auth: { uid: "u1" }, data, ...over } as CallableRequest<RecognizeHandwritingRequest>;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveBoardAccess.mockResolvedValue({ workspaceId: "wsA", isMember: true });
  consumeToken.mockResolvedValue(true);
  recordAiUsage.mockResolvedValue({ period: "2026-06", costUsd: 0.0015 });
  checkAiQuota.mockResolvedValue(true);
  getCachedOcr.mockResolvedValue(null);
  putCachedOcr.mockResolvedValue(undefined);
  ocrCacheKey.mockReturnValue("hash-1");
  (vision.detectHandwriting as jest.Mock).mockResolvedValue({ text: "Hello world", confidence: 0.95 });
});

it("rejects an unauthenticated caller", async () => {
  await expect(
    handleRecognizeHandwriting(req({ auth: undefined }), vision, provider, 0)
  ).rejects.toMatchObject({ code: "unauthenticated" });
});

it("rejects when the image is missing", async () => {
  await expect(
    handleRecognizeHandwriting(
      req({ data: { ...data, imageDataUrl: "" } }),
      vision,
      provider,
      0
    )
  ).rejects.toMatchObject({ code: "invalid-argument" });
});

it("denies a non-member of the board", async () => {
  resolveBoardAccess.mockResolvedValue({ workspaceId: "wsA", isMember: false });
  await expect(handleRecognizeHandwriting(req(), vision, provider, 0)).rejects.toMatchObject({
    code: "permission-denied",
  });
});

it("returns the Vision result on the high-confidence happy path", async () => {
  const res = await handleRecognizeHandwriting(req(), vision, provider, 0);
  expect(res).toMatchObject({ text: "Hello world", source: "vision", cached: false });
  // High confidence → no LLM escalation.
  expect(provider.chat).not.toHaveBeenCalled();
  // Vision cost is logged as a flat per-image cost.
  expect(recordAiUsage).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ feature: "ocr", model: "google-vision", flatCostUsd: 0.0015 })
  );
  expect(putCachedOcr).toHaveBeenCalled();
});

it("escalates to the LLM when Vision is low-confidence", async () => {
  (vision.detectHandwriting as jest.Mock).mockResolvedValue({ text: "Helo wrld", confidence: 0.3 });
  const res = await handleRecognizeHandwriting(req(), vision, provider, 0);
  expect(provider.chat).toHaveBeenCalledWith(expect.objectContaining({ model: "ocr-vision" }));
  expect(res).toMatchObject({ text: "Hello world", source: "gpt" });
  // Both engines ran → both logged (an escalation paid for both).
  expect(recordAiUsage).toHaveBeenCalledTimes(2);
});

it("serves a cache hit without a paid call or rate-limit consume", async () => {
  getCachedOcr.mockResolvedValue({
    text: "Cached text",
    confidence: 0.9,
    source: "vision",
    model: "google-vision",
    createdAt: 0,
  });
  const res = await handleRecognizeHandwriting(req(), vision, provider, 0);
  expect(res).toEqual({
    text: "Cached text",
    confidence: 0.9,
    source: "vision",
    model: "google-vision",
    cached: true,
  });
  expect(consumeToken).not.toHaveBeenCalled();
  expect(vision.detectHandwriting).not.toHaveBeenCalled();
  expect(recordAiUsage).not.toHaveBeenCalled();
});

it("rejects when the rate limit is exhausted", async () => {
  consumeToken.mockResolvedValue(false);
  await expect(handleRecognizeHandwriting(req(), vision, provider, 0)).rejects.toMatchObject({
    code: "resource-exhausted",
  });
});

it("rejects when the workspace AI quota is exhausted", async () => {
  checkAiQuota.mockResolvedValue(false);
  await expect(handleRecognizeHandwriting(req(), vision, provider, 0)).rejects.toMatchObject({
    code: "resource-exhausted",
  });
  expect(vision.detectHandwriting).not.toHaveBeenCalled();
});

it("surfaces an empty recognition as not-found", async () => {
  (vision.detectHandwriting as jest.Mock).mockResolvedValue({ text: "", confidence: 0 });
  (provider.chat as jest.Mock).mockResolvedValueOnce({
    text: '{"text":"","confidence":0}',
    model: "gpt-4o-mini",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  });
  await expect(handleRecognizeHandwriting(req(), vision, provider, 0)).rejects.toMatchObject({
    code: "not-found",
  });
});

it("buckets a legacy no-workspace board per user and skips telemetry", async () => {
  resolveBoardAccess.mockResolvedValue({ workspaceId: "", isMember: true });
  const res = await handleRecognizeHandwriting(req(), vision, provider, 0);
  expect(consumeToken).toHaveBeenCalledWith(expect.anything(), "solo-u1", 0);
  expect(checkAiQuota).not.toHaveBeenCalled();
  expect(recordAiUsage).not.toHaveBeenCalled();
  expect(res.text).toBe("Hello world");
});

it("still returns text when the cache write fails", async () => {
  putCachedOcr.mockRejectedValue(new Error("firestore down"));
  const res = await handleRecognizeHandwriting(req(), vision, provider, 0);
  expect(res.text).toBe("Hello world");
});
