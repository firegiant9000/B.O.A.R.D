import {
  checkQuota,
  assertQuota,
  QuotaExceededError,
  QuotaResource,
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
