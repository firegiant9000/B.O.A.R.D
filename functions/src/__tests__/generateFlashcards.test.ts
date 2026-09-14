// Guard-path + memoization + EG-16 `details` unit tests for the flashcard
// generation callable handler. The AIProvider and clock are injected;
// Firestore + board / rate-limit / usage modules are mocked so the branches
// are exercised without an emulator (mirrors recognizeHandwriting.test.ts).
// The cache module is DELIBERATELY given a real in-memory backing store below
// (not just a jest.fn() returning a canned value) so the memoization test is a
// genuine two-call behavioral proof, not an assertion against a mock's own
// return value.

jest.mock("firebase-admin/firestore", () => ({ getFirestore: () => ({}) }));
jest.mock("../lib/board");
jest.mock("../ai/rateLimit");
jest.mock("../ai/usage");
jest.mock("../ai/flashcardCache");

import { type CallableRequest } from "firebase-functions/v2/https";
import {
  handleGenerateFlashcards,
  type GenerateFlashcardsRequest,
} from "../callable/generateFlashcards";
import * as board from "../lib/board";
import * as rateLimit from "../ai/rateLimit";
import * as usage from "../ai/usage";
import * as flashcardCache from "../ai/flashcardCache";
import type { AIProvider } from "../ai/provider";

const resolveBoardAccess = board.resolveBoardAccess as jest.Mock;
const consumeToken = rateLimit.consumeToken as jest.Mock;
const recordAiUsage = usage.recordAiUsage as jest.Mock;
const checkAiQuota = usage.checkAiQuota as jest.Mock;
const getCachedFlashcards = flashcardCache.getCachedFlashcards as jest.Mock;
const putCachedFlashcards = flashcardCache.putCachedFlashcards as jest.Mock;
const flashcardCacheKey = flashcardCache.flashcardCacheKey as jest.Mock;

function makeProvider(text: string): AIProvider {
  return {
    chat: jest.fn(async () => ({
      text,
      model: "gpt-4o-mini",
      usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
    })),
  };
}

const CARDS_JSON = '[{"front":"Q1","back":"A1"},{"front":"Q2","back":"A2"}]';

const data: GenerateFlashcardsRequest = {
  boardId: "board-1",
  selectionText: "Mitochondria is the powerhouse of the cell.",
  pathIds: ["p2", "p1"],
};

function req(over: Partial<CallableRequest<GenerateFlashcardsRequest>> = {}) {
  return { auth: { uid: "u1" }, data, ...over } as CallableRequest<GenerateFlashcardsRequest>;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveBoardAccess.mockResolvedValue({ workspaceId: "wsA", isMember: true });
  consumeToken.mockResolvedValue(true);
  recordAiUsage.mockResolvedValue({ period: "2026-06", costUsd: 0.001 });
  checkAiQuota.mockResolvedValue(true);
  getCachedFlashcards.mockResolvedValue(null);
  putCachedFlashcards.mockResolvedValue(undefined);
  flashcardCacheKey.mockReturnValue("hash-1");
});

it("rejects an unauthenticated caller", async () => {
  const provider = makeProvider(CARDS_JSON);
  await expect(
    handleGenerateFlashcards(req({ auth: undefined }), provider, 0)
  ).rejects.toMatchObject({ code: "unauthenticated" });
});

it("rejects when neither an image nor selected text is given", async () => {
  const provider = makeProvider(CARDS_JSON);
  await expect(
    handleGenerateFlashcards(
      req({ data: { boardId: "board-1", pathIds: [] } }),
      provider,
      0
    )
  ).rejects.toMatchObject({ code: "invalid-argument" });
});

it("denies a non-member of the board", async () => {
  resolveBoardAccess.mockResolvedValue({ workspaceId: "wsA", isMember: false });
  const provider = makeProvider(CARDS_JSON);
  await expect(handleGenerateFlashcards(req(), provider, 0)).rejects.toMatchObject({
    code: "permission-denied",
  });
});

it("generates cards on the happy path and logs usage under the flashcards feature", async () => {
  const provider = makeProvider(CARDS_JSON);
  const res = await handleGenerateFlashcards(req(), provider, 0);
  expect(res).toEqual({
    cards: [
      { front: "Q1", back: "A1" },
      { front: "Q2", back: "A2" },
    ],
    model: "gpt-4o-mini",
    cached: false,
  });
  expect(recordAiUsage).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ feature: "flashcards", model: "gpt-4o-mini" })
  );
  expect(putCachedFlashcards).toHaveBeenCalled();
});

it("surfaces no-cards-parsed as not-found", async () => {
  const provider = makeProvider("[]");
  await expect(handleGenerateFlashcards(req(), provider, 0)).rejects.toMatchObject({
    code: "not-found",
  });
});

it("surfaces an empty provider reply as internal", async () => {
  const provider = makeProvider("");
  await expect(handleGenerateFlashcards(req(), provider, 0)).rejects.toMatchObject({
    code: "internal",
  });
});

it("buckets a legacy no-workspace board per user and skips telemetry", async () => {
  resolveBoardAccess.mockResolvedValue({ workspaceId: "", isMember: true });
  const provider = makeProvider(CARDS_JSON);
  const res = await handleGenerateFlashcards(req(), provider, 0);
  expect(consumeToken).toHaveBeenCalledWith(expect.anything(), "solo-u1", 0);
  expect(checkAiQuota).not.toHaveBeenCalled();
  expect(recordAiUsage).not.toHaveBeenCalled();
  expect(res.cards).toHaveLength(2);
});

it("still returns cards when the cache write fails", async () => {
  putCachedFlashcards.mockRejectedValue(new Error("firestore down"));
  const provider = makeProvider(CARDS_JSON);
  const res = await handleGenerateFlashcards(req(), provider, 0);
  expect(res.cards).toHaveLength(2);
});

describe("EG-16 — resource-exhausted details distinguish rate-limit from plan-quota", () => {
  it("attaches details: { reason: 'rate-limit' } when the throttle denies, without ever reaching the quota check", async () => {
    consumeToken.mockResolvedValue(false);
    const provider = makeProvider(CARDS_JSON);
    await expect(handleGenerateFlashcards(req(), provider, 0)).rejects.toMatchObject({
      code: "resource-exhausted",
      details: { reason: "rate-limit" },
    });
    expect(checkAiQuota).not.toHaveBeenCalled();
  });

  it("attaches details: { reason: 'plan-quota' } when the workspace AI quota is exhausted", async () => {
    checkAiQuota.mockResolvedValue(false);
    const provider = makeProvider(CARDS_JSON);
    await expect(handleGenerateFlashcards(req(), provider, 0)).rejects.toMatchObject({
      code: "resource-exhausted",
      details: { reason: "plan-quota" },
    });
    expect(provider.chat).not.toHaveBeenCalled();
  });
});

describe("generation memoization (same selection hash ⇒ no second provider call)", () => {
  it("serves a cache hit without a paid call or rate-limit consume", async () => {
    getCachedFlashcards.mockResolvedValue({
      cards: [{ front: "Cached Q", back: "Cached A" }],
      model: "gpt-4o-mini",
      createdAt: 0,
    });
    const provider = makeProvider(CARDS_JSON);
    const res = await handleGenerateFlashcards(req(), provider, 0);
    expect(res).toEqual({
      cards: [{ front: "Cached Q", back: "Cached A" }],
      model: "gpt-4o-mini",
      cached: true,
    });
    expect(consumeToken).not.toHaveBeenCalled();
    expect(provider.chat).not.toHaveBeenCalled();
    expect(recordAiUsage).not.toHaveBeenCalled();
  });

  // The behavioral proof: a real in-memory store backs get/put (not a static
  // mock return), so this exercises the actual read-then-write cache path
  // twice, end to end. If the cache short-circuit were ever removed from
  // handleGenerateFlashcards, this test would call the provider twice and fail
  // — see this task's report for the RED-check that confirmed exactly that.
  it("a second call with the same selection hash does not call the provider again", async () => {
    const store = new Map<string, any>();
    getCachedFlashcards.mockImplementation(async (_db: unknown, _boardId: string, key: string) =>
      store.get(key) ?? null
    );
    putCachedFlashcards.mockImplementation(
      async (_db: unknown, _boardId: string, key: string, value: unknown) => {
        store.set(key, value);
      }
    );
    flashcardCacheKey.mockReturnValue("stable-hash");

    const provider = makeProvider(CARDS_JSON);

    const first = await handleGenerateFlashcards(req(), provider, 0);
    const second = await handleGenerateFlashcards(req(), provider, 1000);

    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.cards).toEqual(first.cards);
  });

  it("a DIFFERENT selection hash is not memoized against the first — the provider runs again", async () => {
    const store = new Map<string, any>();
    getCachedFlashcards.mockImplementation(async (_db: unknown, _boardId: string, key: string) =>
      store.get(key) ?? null
    );
    putCachedFlashcards.mockImplementation(
      async (_db: unknown, _boardId: string, key: string, value: unknown) => {
        store.set(key, value);
      }
    );

    const provider = makeProvider(CARDS_JSON);

    flashcardCacheKey.mockReturnValue("hash-a");
    await handleGenerateFlashcards(req(), provider, 0);

    flashcardCacheKey.mockReturnValue("hash-b");
    await handleGenerateFlashcards(req({ data: { ...data, pathIds: ["other"] } }), provider, 1000);

    expect(provider.chat).toHaveBeenCalledTimes(2);
  });
});
