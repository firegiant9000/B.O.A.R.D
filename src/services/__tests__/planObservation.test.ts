// A real, round-tripping in-memory AsyncStorage fake — NOT a mock that echoes
// what a test sets. Same convention (and for the same reason) as
// src/services/__tests__/upsellCadence.test.ts: `getItem` returns whatever was
// actually handed to `setItem` for that exact key, so the dedupe below is being
// driven by a value that genuinely survived a write/read cycle. If
// `observeWorkspacePlan` never wrote, or read a different key than it wrote,
// this store would surface it instead of quietly agreeing.
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

// analyticsService has no Firebase import in its own graph, so a plain
// automock is enough here (same note as templateService.test.ts).
jest.mock("../analyticsService");

import AsyncStorage from "@react-native-async-storage/async-storage";
import { track } from "../analyticsService";
import { observeWorkspacePlan } from "../planObservation";

const mockTrack = track as jest.Mock;

const WS = "ws-alpha";
const OTHER_WS = "ws-beta";

const resetStorageBehaviour = () => {
  mockStore = {};
  mockGetItemImpl = (k) => Promise.resolve(k in mockStore ? mockStore[k] : null);
  mockSetItemImpl = (k, v) => {
    mockStore[k] = v;
    return Promise.resolve();
  };
};

/** Every `upgrade_completed` call this suite's mock seam has seen. Used rather
 *  than `mockTrack.mock.calls` directly so a future unrelated event emitted from
 *  the same module can't silently be counted as a conversion. */
const upgradeCalls = () =>
  mockTrack.mock.calls.filter(([event]) => event === "upgrade_completed");

describe("planObservation — `upgrade_completed` fires at most once per workspace, ever", () => {
  beforeEach(() => {
    resetStorageBehaviour();
    jest.clearAllMocks();
  });

  // THE test. A naive "if the plan is pro, emit" implementation passes every
  // other case in this file and fails only this one — and the metric it would
  // produce measures retention (how often a paying customer opens the app),
  // not conversion, while still being named `upgrade_completed`.
  it("does NOT fire a second time for the same workspace, however many times the paid plan is re-observed", async () => {
    await observeWorkspacePlan(WS, "free");
    await observeWorkspacePlan(WS, "pro");
    expect(upgradeCalls()).toHaveLength(1);

    // Every subsequent app start for this same paying workspace.
    await observeWorkspacePlan(WS, "pro");
    await observeWorkspacePlan(WS, "pro");
    await observeWorkspacePlan(WS, "pro");
    expect(upgradeCalls()).toHaveLength(1);
  });

  // The load-bearing persistence test. A counter held in module memory would
  // make this dedupe evaporate on the next app launch — which is the single
  // most likely way this over-counts in production, since the whole point is
  // that it survives a restart. `jest.isolateModules` re-evaluates the module
  // from scratch against the SAME storage fake, the closest thing this suite
  // has to an app relaunch.
  it("survives the module being re-evaluated from scratch — the marker lives in storage, not module memory", async () => {
    await observeWorkspacePlan(WS, "free");
    await observeWorkspacePlan(WS, "pro");
    expect(upgradeCalls()).toHaveLength(1);

    let reloaded: typeof observeWorkspacePlan = observeWorkspacePlan;
    jest.isolateModules(() => {
      reloaded = require("../planObservation").observeWorkspacePlan;
    });
    expect(reloaded).not.toBe(observeWorkspacePlan); // premise: really a fresh module

    await reloaded(WS, "pro");
    expect(upgradeCalls()).toHaveLength(1);
  });

  // The case that makes "fire on first sight of a paid plan" wrong even WITH a
  // dedupe marker: an existing paying customer installing on a new device, or
  // simply clearing storage, has no marker and no prior observation — but
  // nothing converted. Nothing was observed to change, so nothing is reported.
  it("never fires on the first-ever observation of a workspace that is already paid", async () => {
    await observeWorkspacePlan(WS, "pro");
    await observeWorkspacePlan(WS, "pro");
    expect(upgradeCalls()).toHaveLength(0);
  });

  // A second workspace created by an already-Pro owner is born "pro"
  // (functions/src/callable/createWorkspace.ts#resolveOwnerPlan inherits the
  // owner's plan), so this is not a hypothetical: without the first-observation
  // rule above, every extra workspace a paying customer makes would report a
  // fresh conversion.
  it("never fires for a workspace that is born paid, even alongside a workspace that genuinely converted", async () => {
    await observeWorkspacePlan(WS, "free");
    await observeWorkspacePlan(WS, "pro");
    await observeWorkspacePlan(OTHER_WS, "pro"); // born pro — inherited, not bought
    expect(upgradeCalls()).toHaveLength(1);
  });

  it("fires once for each workspace that genuinely transitions — the marker is per workspace, not global", async () => {
    await observeWorkspacePlan(WS, "free");
    await observeWorkspacePlan(OTHER_WS, "free");
    await observeWorkspacePlan(WS, "pro");
    await observeWorkspacePlan(OTHER_WS, "pro");
    expect(upgradeCalls()).toHaveLength(2);
    await observeWorkspacePlan(WS, "pro");
    await observeWorkspacePlan(OTHER_WS, "pro");
    expect(upgradeCalls()).toHaveLength(2);
  });

  it("writes distinct keys per workspace, so two workspaces' markers cannot alias", async () => {
    await observeWorkspacePlan(WS, "free");
    await observeWorkspacePlan(OTHER_WS, "free");
    const keys = Object.keys(mockStore);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("carries no raw workspace id, uid, or other identifier in the event properties", async () => {
    await observeWorkspacePlan(WS, "free");
    await observeWorkspacePlan(WS, "pro");
    const [, props] = upgradeCalls()[0];
    expect(JSON.stringify(props)).not.toContain(WS);
    // Falsifiability: the assertion above would also pass for an empty bag, so
    // pin what the event IS allowed to say — both closed unions, neither
    // derived from anything a user typed.
    expect(props).toEqual({ fromPlan: "free", toPlan: "pro" });
  });

  it("reports a downgrade-then-reconversion at most once in total — 'once per workspace, ever' is literal", async () => {
    await observeWorkspacePlan(WS, "free");
    await observeWorkspacePlan(WS, "pro");
    expect(upgradeCalls()).toHaveLength(1);

    // Subscription lapses (stripeWebhook's REVOKE_STATUSES revert plan to
    // "free"), then the customer comes back.
    await observeWorkspacePlan(WS, "free");
    await observeWorkspacePlan(WS, "pro");
    expect(upgradeCalls()).toHaveLength(1);
  });

  it("does not treat an out-of-band edu grant as a completed upgrade", async () => {
    // Edu is granted by an operator, never through self-serve checkout
    // (functions/src/callable/createCheckoutSession.ts resolves a Pro price ID
    // and nothing else). Counting it would mix operator grants into a paid-
    // conversion metric.
    await observeWorkspacePlan(WS, "free");
    await observeWorkspacePlan(WS, "edu");
    expect(upgradeCalls()).toHaveLength(0);
  });

  it("still reports an edu workspace that later buys Pro", async () => {
    await observeWorkspacePlan(WS, "edu");
    await observeWorkspacePlan(WS, "pro");
    expect(upgradeCalls()).toHaveLength(1);
    expect(upgradeCalls()[0][1]).toEqual({ fromPlan: "edu", toPlan: "pro" });
  });

  it("does nothing at all without a workspace id — an embed viewer has no workspace to observe", async () => {
    await observeWorkspacePlan("", "pro");
    expect(mockTrack).not.toHaveBeenCalled();
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  describe("fails soft, and fails CLOSED on the emit — a broken store must never over-report", () => {
    it("never rejects when the read rejects", async () => {
      mockGetItemImpl = () => Promise.reject(new Error("storage unavailable"));
      await expect(observeWorkspacePlan(WS, "pro")).resolves.toBeUndefined();
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it("never rejects when the read throws synchronously", async () => {
      // AsyncStorage's web/native shims can throw before returning a promise
      // (a disabled localStorage in a hardened browser profile), which an
      // `await`-only guard would miss if the call were not itself inside the try.
      mockGetItemImpl = () => {
        throw new Error("storage unavailable");
      };
      await expect(observeWorkspacePlan(WS, "pro")).resolves.toBeUndefined();
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it("never rejects when the write rejects, and emits NOTHING it could not durably mark", async () => {
      // The direction this deliberately fails in. If the marker cannot be
      // written, emitting anyway would emit again on the next app start, and
      // again after that — turning one conversion into an unbounded count.
      // Losing a real conversion is the cheaper error.
      await observeWorkspacePlan(WS, "free");
      mockSetItemImpl = () => Promise.reject(new Error("quota exceeded"));
      await expect(observeWorkspacePlan(WS, "pro")).resolves.toBeUndefined();
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it("never rejects when the analytics seam itself throws", async () => {
      // track() throws only for an undocumented event (a programmer error),
      // but this runs off a render effect: a throw here would surface as an
      // unhandled rejection in the middle of an ordinary app start.
      mockTrack.mockImplementationOnce(() => {
        throw new Error("vendor exploded");
      });
      await observeWorkspacePlan(WS, "free");
      await expect(observeWorkspacePlan(WS, "pro")).resolves.toBeUndefined();
    });

    it.each([
      ["not a plan", "banana"],
      ["empty", ""],
      ["JSON someone else wrote", '{"plan":"free"}'],
    ])(
      "treats a %s stored plan as 'never observed before', reporting nothing rather than guessing a transition",
      async (_label, raw) => {
        // The key is DISCOVERED (by making one real observation and reading back
        // whatever key the module wrote), never guessed — a hardcoded key string
        // would quietly stop testing anything the day the module renamed its key.
        await observeWorkspacePlan(WS, "free");
        const seenKey = Object.keys(mockStore)[0];
        expect(seenKey).toBeDefined();
        mockStore[seenKey] = raw;
        jest.clearAllMocks();

        await observeWorkspacePlan(WS, "pro");
        expect(mockTrack).not.toHaveBeenCalled();
      }
    );
  });

  it("performs no write when nothing changed — this runs on every workspace resolve, not a denial path", async () => {
    await observeWorkspacePlan(WS, "free");
    jest.clearAllMocks();
    await observeWorkspacePlan(WS, "free");
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});
