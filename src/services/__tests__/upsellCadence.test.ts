// A real, round-tripping in-memory AsyncStorage fake — NOT a mock that echoes
// what a test sets. `getItem` returns whatever was actually handed to `setItem`
// for that exact key (or null), so the escalation below is being driven by a
// value that genuinely survived a write/read cycle. If `recordUpsellAttempt`
// never wrote, or read a different key than it wrote, this store would surface
// it instead of quietly agreeing. Same convention as
// src/components/onboarding/__tests__/useOnboardingTutorial.test.ts.
let mockStore: Record<string, string> = {};
let mockGetItemImpl: (k: string) => Promise<string | null> = (k) =>
  Promise.resolve(k in mockStore ? mockStore[k] : null);
let mockSetItemImpl: (k: string, v: string) => Promise<void> = (k, v) => {
  mockStore[k] = v;
  return Promise.resolve();
};

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn((k: string) => mockGetItemImpl(k)),
  setItem: jest.fn((k: string, v: string) => mockSetItemImpl(k, v)),
  removeItem: jest.fn((k: string) => {
    delete mockStore[k];
    return Promise.resolve();
  }),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { recordUpsellAttempt, HARD_PUSH_AT_ATTEMPT } from "../upsellCadence";

const resetStorageBehaviour = () => {
  mockStore = {};
  mockGetItemImpl = (k) => Promise.resolve(k in mockStore ? mockStore[k] : null);
  mockSetItemImpl = (k, v) => {
    mockStore[k] = v;
    return Promise.resolve();
  };
};

/** Runs one real attempt and returns the key the module actually wrote under,
 *  leaving the store empty again. Lets the parse tests seed a value the module
 *  is guaranteed to read, without the module having to export its key scheme
 *  purely so a test can reach it. */
const discoverKeyFor = async (resource: Parameters<typeof recordUpsellAttempt>[0]) => {
  mockStore = {};
  await recordUpsellAttempt(resource);
  const keys = Object.keys(mockStore);
  expect(keys).toHaveLength(1); // premise: one attempt writes exactly one key
  mockStore = {};
  return keys[0];
};

describe("upsellCadence — ROADMAP.md:608 'skip on first attempt; harder push on second'", () => {
  beforeEach(() => {
    resetStorageBehaviour();
    jest.clearAllMocks();
  });

  it("resolves soft on the first attempt, hard on the second, and stays hard after that", async () => {
    expect(await recordUpsellAttempt("board")).toBe("soft");
    expect(await recordUpsellAttempt("board")).toBe("hard");
    expect(await recordUpsellAttempt("board")).toBe("hard");
    expect(await recordUpsellAttempt("board")).toBe("hard");
  });

  it("counts each resource independently — hitting the AI cap twice leaves the session gate on its first attempt", async () => {
    // The defect a single shared counter would produce: a user who burned
    // their AI calls would be hard-sold the moment they first tried to start
    // a session, a gate they had never hit before. Sequential, not
    // Promise.all: these are read-modify-write cycles on the same store, and
    // interleaving them would test the fake's scheduling rather than the
    // per-resource keying.
    expect(await recordUpsellAttempt("aiCall")).toBe("soft");
    expect(await recordUpsellAttempt("aiCall")).toBe("hard");
    expect(await recordUpsellAttempt("session")).toBe("soft");
    expect(await recordUpsellAttempt("customPalette")).toBe("soft");
    expect(await recordUpsellAttempt("session")).toBe("hard");
    // …and the resource that was already escalated stays escalated.
    expect(await recordUpsellAttempt("aiCall")).toBe("hard");
  });

  it("writes under a distinct key per resource, so the counters cannot alias", async () => {
    await recordUpsellAttempt("board");
    await recordUpsellAttempt("presenter");
    const keys = Object.keys(mockStore);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  // The load-bearing persistence test. A gate hit usually unmounts or
  // re-renders the board screen, so a counter held anywhere in module or
  // component memory would make every attempt look like the first and the
  // whole feature a no-op. `jest.isolateModules` re-evaluates the module from
  // scratch against the SAME storage fake — the closest thing this suite has
  // to an app relaunch. If anyone ever memoises the count in a module-level
  // Map, this fails and that one does not.
  it("survives the module being re-evaluated from scratch — the count lives in storage, not in module memory", async () => {
    expect(await recordUpsellAttempt("boardQa")).toBe("soft");

    let reloaded: typeof recordUpsellAttempt = recordUpsellAttempt;
    jest.isolateModules(() => {
      reloaded = require("../upsellCadence").recordUpsellAttempt;
    });
    expect(reloaded).not.toBe(recordUpsellAttempt); // premise: really a fresh module

    expect(await reloaded("boardQa")).toBe("hard");
  });

  describe("fails soft, never closed — a broken store must not hard-sell anyone", () => {
    it("resolves soft (and does not throw) when the read rejects", async () => {
      mockGetItemImpl = () => Promise.reject(new Error("storage unavailable"));
      await expect(recordUpsellAttempt("board")).resolves.toBe("soft");
    });

    it("resolves soft (and does not throw) when the read throws synchronously", async () => {
      // AsyncStorage's web/native shims can throw before returning a promise
      // (e.g. a disabled localStorage in a hardened browser profile), which an
      // `await`-only guard would miss if the call were not itself inside the
      // try.
      mockGetItemImpl = () => {
        throw new Error("storage unavailable");
      };
      await expect(recordUpsellAttempt("board")).resolves.toBe("soft");
    });

    it("does not overwrite a real stored count when the read fails — a transient read error must not reset the cadence", async () => {
      await recordUpsellAttempt("board"); // a genuine first attempt, persisted
      const persisted = { ...mockStore };

      mockGetItemImpl = () => Promise.reject(new Error("transient"));
      expect(await recordUpsellAttempt("board")).toBe("soft");
      expect(mockStore).toEqual(persisted);

      // Once the store recovers, the real count is still there: the next
      // attempt is the second, not the first.
      resetStorageBehaviour();
      mockStore = { ...persisted };
      expect(await recordUpsellAttempt("board")).toBe("hard");
    });

    it("resolves soft (and does not throw) when the write rejects", async () => {
      mockSetItemImpl = () => Promise.reject(new Error("quota exceeded"));
      await expect(recordUpsellAttempt("board")).resolves.toBe("soft");
    });

    it("still resolves hard on a later attempt when only the write is broken — the read is what decides", async () => {
      await recordUpsellAttempt("board");
      mockSetItemImpl = () => Promise.reject(new Error("quota exceeded"));
      expect(await recordUpsellAttempt("board")).toBe("hard");
    });

    it.each([
      ["not a number", "banana"],
      ["empty", ""],
      ["negative", "-4"],
      ["a float", "1.9"],
      ["JSON someone else wrote", '{"count":7}'],
    ])("treats a %s stored value as no prior attempt, resolving soft", async (_label, raw) => {
      // The key is DISCOVERED (by making one real attempt and reading back
      // whatever key the module wrote), never guessed. A hardcoded key string
      // here would quietly stop testing anything the day the module renamed
      // its key: the seeded garbage would land somewhere nothing reads, the
      // call would see an empty store, and "soft" would pass for the wrong
      // reason. This way the garbage genuinely goes through the parse.
      const storageKey = await discoverKeyFor("board");
      mockStore[storageKey] = raw;
      expect(await recordUpsellAttempt("board")).toBe("soft");
    });

    it("treats a stored value from the future (a larger count than we write) as escalated, not as garbage", async () => {
      // The inverse of the test above, and the reason the parse can't simply
      // reject anything it wouldn't itself have written: a real count left by
      // a newer build must still escalate. Only values that cannot be a count
      // at all fall back to "first attempt".
      const storageKey = await discoverKeyFor("board");
      mockStore[storageKey] = "99";
      expect(await recordUpsellAttempt("board")).toBe("hard");
    });
  });

  it("saturates the stored counter instead of growing without bound", async () => {
    for (let i = 0; i < 12; i += 1) await recordUpsellAttempt("board");
    const stored = Object.values(mockStore);
    expect(stored).toHaveLength(1);
    expect(Number(stored[0])).toBe(HARD_PUSH_AT_ATTEMPT);
  });

  it("performs exactly one read and one write per gate hit — this runs on a denial path, not a hot loop", async () => {
    await recordUpsellAttempt("board");
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  });

  it("stops writing once saturated — a user who keeps hitting the same gate stops touching the disk", async () => {
    await recordUpsellAttempt("board"); // 1st: writes 1
    await recordUpsellAttempt("board"); // 2nd: writes 2 (saturated)
    jest.clearAllMocks();
    expect(await recordUpsellAttempt("board")).toBe("hard");
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});
