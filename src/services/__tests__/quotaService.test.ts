import {
  checkQuota,
  assertQuota,
  QuotaExceededError,
  QuotaResource,
  isResourceExhausted,
  isQuotaDenial,
  resourceExhaustedReason,
  RESOURCE_EXHAUSTED_CODE,
} from "../quotaService";

const RESOURCES: QuotaResource[] = ["board", "session", "aiSummary", "aiCall"];

describe("checkQuota (advisory pre-flight — see module header, not the gate)", () => {
  it.each(RESOURCES)(
    "returns true for resource %s when nothing has been used yet",
    async (resource) => {
      expect(await checkQuota("ws-1", resource)).toBe(true);
    }
  );

  it("is advisory: allows when under the mirrored limit", async () => {
    await expect(checkQuota("ws1", "board", "free", 4)).resolves.toBe(true);
  });

  it("is advisory: warns when at the mirrored limit", async () => {
    await expect(checkQuota("ws1", "board", "free", 5)).resolves.toBe(false);
  });

  it("defaults to free when no plan is supplied", async () => {
    await expect(checkQuota("ws1", "board", undefined, 5)).resolves.toBe(false);
  });

  it("never warns for pro, however high the count", async () => {
    await expect(checkQuota("ws1", "aiCall", "pro", 100000)).resolves.toBe(true);
  });

  it("is unaffected by which workspace is passed (the id isn't part of the check)", async () => {
    expect(await checkQuota("any-other-ws", "board", "free", 4)).toBe(true);
  });
});

describe("assertQuota", () => {
  it.each(RESOURCES)(
    "does not throw while under the (default, zero-usage) quota for resource %s",
    async (resource) => {
      await expect(assertQuota("ws-1", resource)).resolves.toBeUndefined();
    }
  );

  it("throws QuotaExceededError once the mirrored limit is reached", async () => {
    await expect(assertQuota("ws1", "board", "free", 5)).rejects.toBeInstanceOf(
      QuotaExceededError
    );
  });

  it("does not throw for pro even far past the free limit", async () => {
    await expect(
      assertQuota("ws1", "aiCall", "pro", 100000)
    ).resolves.toBeUndefined();
  });
});

describe("QuotaExceededError", () => {
  it("carries the resource and workspaceId for the caller to act on", () => {
    const err = new QuotaExceededError("board", "ws-1");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("QuotaExceededError");
    expect(err.resource).toBe("board");
    expect(err.workspaceId).toBe("ws-1");
  });
});

describe("isResourceExhausted", () => {
  it("matches the real Firebase callable rejection shape (functions/resource-exhausted)", () => {
    const err = Object.assign(new Error("You've reached your plan's board limit."), {
      code: "functions/resource-exhausted",
    });
    expect(isResourceExhausted(err)).toBe(true);
    expect(err.code).toBe(RESOURCE_EXHAUSTED_CODE);
  });

  it("does not match an unprefixed code — the client SDK always prefixes it", () => {
    // Guards against re-introducing a bare "resource-exhausted" check: that is
    // the server-side HttpsError code, not what actually reaches the client.
    expect(isResourceExhausted(Object.assign(new Error("x"), { code: "resource-exhausted" }))).toBe(
      false
    );
  });

  it("does not match a different callable rejection (e.g. failed-precondition)", () => {
    expect(
      isResourceExhausted(Object.assign(new Error("x"), { code: "functions/failed-precondition" }))
    ).toBe(false);
  });

  it("does not match a plain network/generic error with no code at all", () => {
    expect(isResourceExhausted(new Error("Network request failed"))).toBe(false);
  });

  it("does not match a reworded message alone — this must never branch on .message", () => {
    const err = Object.assign(new Error("You are completely out of room, upgrade now!"), {
      code: "functions/failed-precondition",
    });
    expect(isResourceExhausted(err)).toBe(false);
  });

  it("does not throw on non-object / null input", () => {
    expect(isResourceExhausted(null)).toBe(false);
    expect(isResourceExhausted(undefined)).toBe(false);
    expect(isResourceExhausted("resource-exhausted")).toBe(false);
  });
});

describe("isQuotaDenial", () => {
  it("matches the client-side pre-flight's own QuotaExceededError, which carries no .code", () => {
    // This is the shape `assertQuota` throws BEFORE any callable runs
    // (boardService.createBoard, sessionService.createSession) — a caller
    // checking isResourceExhausted alone would miss it entirely, since it has
    // no `.code` at all. This is the regression this predicate exists to fix.
    const err = new QuotaExceededError("board", "ws-1");
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(isQuotaDenial(err)).toBe(true);
  });

  it("matches the real server rejection too (delegates to isResourceExhausted)", () => {
    const err = Object.assign(new Error("x"), { code: "functions/resource-exhausted" });
    expect(isQuotaDenial(err)).toBe(true);
  });

  it("does not match a plain network/generic error", () => {
    expect(isQuotaDenial(new Error("Network request failed"))).toBe(false);
  });

  it("does not match an unrelated Error subclass", () => {
    class SomeOtherError extends Error {}
    expect(isQuotaDenial(new SomeOtherError("x"))).toBe(false);
  });

  it("does not throw on non-object / null input", () => {
    expect(isQuotaDenial(null)).toBe(false);
    expect(isQuotaDenial(undefined)).toBe(false);
  });
});

// EG-16 — generateFlashcards is the first AI callable to attach `details` to a
// resource-exhausted rejection; its client (flashcardService.ts) must route on
// THIS, never re-infer the reason the way the four M4 callables' callers do.
describe("resourceExhaustedReason", () => {
  it("reads 'plan-quota' off a resource-exhausted rejection's details", () => {
    const err = Object.assign(new Error("over quota"), {
      code: RESOURCE_EXHAUSTED_CODE,
      details: { reason: "plan-quota" },
    });
    expect(resourceExhaustedReason(err)).toBe("plan-quota");
  });

  it("reads 'rate-limit' off a resource-exhausted rejection's details", () => {
    const err = Object.assign(new Error("slow down"), {
      code: RESOURCE_EXHAUSTED_CODE,
      details: { reason: "rate-limit" },
    });
    expect(resourceExhaustedReason(err)).toBe("rate-limit");
  });

  it("returns null for a resource-exhausted rejection with no details — the four M4 callables' shape", () => {
    const err = Object.assign(new Error("Too many AI requests right now."), {
      code: RESOURCE_EXHAUSTED_CODE,
    });
    expect(resourceExhaustedReason(err)).toBeNull();
  });

  it("returns null for a resource-exhausted rejection with an unrecognized reason string", () => {
    const err = Object.assign(new Error("x"), {
      code: RESOURCE_EXHAUSTED_CODE,
      details: { reason: "something-new" },
    });
    expect(resourceExhaustedReason(err)).toBeNull();
  });

  it("returns null for an error that isn't resource-exhausted at all, even with a details-shaped payload", () => {
    const err = Object.assign(new Error("x"), {
      code: "functions/failed-precondition",
      details: { reason: "plan-quota" },
    });
    expect(resourceExhaustedReason(err)).toBeNull();
  });

  it("does not throw on non-object / null input", () => {
    expect(resourceExhaustedReason(null)).toBeNull();
    expect(resourceExhaustedReason(undefined)).toBeNull();
  });
});
