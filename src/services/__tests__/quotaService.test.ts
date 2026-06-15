import {
  checkQuota,
  assertQuota,
  QuotaExceededError,
  QuotaResource,
} from "../quotaService";

const RESOURCES: QuotaResource[] = ["board", "session", "aiSummary", "aiCall"];

describe("checkQuota (Phase 5 contract: allows everyone today)", () => {
  it.each(RESOURCES)("returns true for resource %s", async (resource) => {
    expect(await checkQuota("ws-1", resource)).toBe(true);
  });

  it("returns true regardless of workspace", async () => {
    expect(await checkQuota("any-other-ws", "board")).toBe(true);
  });
});

describe("assertQuota", () => {
  it.each(RESOURCES)(
    "does not throw while the quota allows resource %s",
    async (resource) => {
      await expect(assertQuota("ws-1", resource)).resolves.toBeUndefined();
    }
  );
});

describe("QuotaExceededError (M5 enforcement seam)", () => {
  it("carries the resource and workspaceId for the future gate", () => {
    const err = new QuotaExceededError("board", "ws-1");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("QuotaExceededError");
    expect(err.resource).toBe("board");
    expect(err.workspaceId).toBe("ws-1");
  });
});
