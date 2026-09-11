// A real, round-tripping in-memory AsyncStorage fake — NOT a mock that
// hardcodes/echoes what a test sets. getItem returns whatever was actually
// passed to setItem for that exact key (or null), so `hasCompletedOnboarding`
// and `markOnboardingComplete` are being tested against real persistence
// semantics: if `dismiss()` never called `setItem`, or `visible` never read
// through to `getItem`, this store would surface it.
let mockStore: Record<string, string> = {};
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn((k: string) => Promise.resolve(k in mockStore ? mockStore[k] : null)),
  setItem: jest.fn((k: string, v: string) => {
    mockStore[k] = v;
    return Promise.resolve();
  }),
  removeItem: jest.fn((k: string) => {
    delete mockStore[k];
    return Promise.resolve();
  }),
}));

import { renderHook, act, waitFor } from "@testing-library/react-native";
import { useOnboardingTutorial } from "../useOnboardingTutorial";

describe("useOnboardingTutorial — shown once per uid (Month 5, ROADMAP item 4)", () => {
  beforeEach(() => {
    mockStore = {};
  });

  it("shows on first run and not after completion", async () => {
    // First run for this uid: nothing in storage yet.
    const first = renderHook(() => useOnboardingTutorial("user-1"));
    await waitFor(() => expect(first.result.current.visible).toBe(true));

    // Dismissing persists completion (via the real store above, not an echo).
    await act(async () => {
      await first.result.current.dismiss();
    });
    expect(first.result.current.visible).toBe(false);

    // A fresh hook instance simulates the app relaunching for the same uid —
    // if `dismiss()` hadn't actually written through to storage, or if the
    // hook ignored the stored flag on mount, this would come back `true`.
    const second = renderHook(() => useOnboardingTutorial("user-1"));
    await waitFor(() => expect(second.result.current.visible).toBe(false));
  });

  it("is per-uid: a different uid on the same device still sees it", async () => {
    const a = renderHook(() => useOnboardingTutorial("user-a"));
    await waitFor(() => expect(a.result.current.visible).toBe(true));
    await act(async () => {
      await a.result.current.dismiss();
    });

    // A second account signing into the same (shared, e.g. classroom) device
    // must not inherit user-a's completion — a global key would fail this.
    const b = renderHook(() => useOnboardingTutorial("user-b"));
    await waitFor(() => expect(b.result.current.visible).toBe(true));
  });

  it("shows nothing (stays not-visible) with no signed-in user", () => {
    const { result } = renderHook(() => useOnboardingTutorial(null));
    expect(result.current.visible).toBe(false);
  });
});
