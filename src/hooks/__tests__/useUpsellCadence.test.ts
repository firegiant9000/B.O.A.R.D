// A real, round-tripping in-memory AsyncStorage fake, shared across every
// `renderHook` in this file — the whole point of the tests below is that the
// count outlives the component, so the store deliberately does NOT reset
// between mounts within a test, only between tests.
let mockStore: Record<string, string> = {};
let mockGetItemImpl: (k: string) => Promise<string | null> = (k) =>
  Promise.resolve(k in mockStore ? mockStore[k] : null);

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn((k: string) => mockGetItemImpl(k)),
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
import { useUpsellCadence } from "../useUpsellCadence";

/** The signed-in user these tests act as. The cadence is stored per-uid (see
 *  `upsellCadence.ts`'s header on shared classroom tablets), so every mount
 *  here has to present the same one for the count to carry across them. */
const UID = "student-a";

describe("useUpsellCadence — resolves the variant before the modal ever renders", () => {
  beforeEach(() => {
    mockStore = {};
    mockGetItemImpl = (k) => Promise.resolve(k in mockStore ? mockStore[k] : null);
    jest.clearAllMocks();
  });

  it("starts with nothing shown", () => {
    const { result } = renderHook(() => useUpsellCadence(UID));
    expect(result.current.resource).toBeNull();
  });

  it("shows the soft notice on a first gate hit and the hard push on the second", async () => {
    const { result } = renderHook(() => useUpsellCadence(UID));

    act(() => result.current.show("board"));
    await waitFor(() => expect(result.current.resource).toBe("board"));
    expect(result.current.variant).toBe("soft");

    act(() => result.current.dismiss());
    await waitFor(() => expect(result.current.resource).toBeNull());

    act(() => result.current.show("board"));
    await waitFor(() => expect(result.current.resource).toBe("board"));
    expect(result.current.variant).toBe("hard");
  });

  // THE load-bearing test for this feature. Hitting a plan gate routinely
  // unmounts or remounts the board screen (a navigation back out of a board a
  // user could not create, a re-render from the workspace subscription, an app
  // relaunch after a background kill). An attempt counter held in component
  // state would reset on every one of those, every attempt would look like the
  // first, and the escalation would be a no-op that still passed a
  // single-mount test. So this one deliberately throws the component away
  // between the two attempts: NOTHING in React survives the unmount, and the
  // second attempt must still resolve "hard" purely from what reached storage.
  it("escalates across a full unmount and remount — the count lives in storage, not in component state", async () => {
    const first = renderHook(() => useUpsellCadence(UID));
    act(() => first.result.current.show("session"));
    await waitFor(() => expect(first.result.current.resource).toBe("session"));
    expect(first.result.current.variant).toBe("soft");

    first.unmount();

    // A brand-new hook instance with no shared React state whatsoever. If the
    // counter were component-local, this would read "soft" again forever.
    const second = renderHook(() => useUpsellCadence(UID));
    expect(second.result.current.resource).toBeNull(); // premise: genuinely fresh state
    act(() => second.result.current.show("session"));
    await waitFor(() => expect(second.result.current.resource).toBe("session"));
    expect(second.result.current.variant).toBe("hard");
  });

  it("keeps each gate on its own cadence across remounts", async () => {
    const first = renderHook(() => useUpsellCadence(UID));
    act(() => first.result.current.show("aiCall"));
    await waitFor(() => expect(first.result.current.variant).toBe("soft"));
    act(() => first.result.current.dismiss());
    act(() => first.result.current.show("aiCall"));
    await waitFor(() => expect(first.result.current.variant).toBe("hard"));
    first.unmount();

    // A different gate, on a fresh mount, is still this user's first encounter
    // with THAT gate — being out of AI calls says nothing about sessions.
    const second = renderHook(() => useUpsellCadence(UID));
    act(() => second.result.current.show("session"));
    await waitFor(() => expect(second.result.current.resource).toBe("session"));
    expect(second.result.current.variant).toBe("soft");
  });

  it("sets the resource and its variant in the same commit — no frame renders the hard body before the count arrives", async () => {
    // The flash this prevents: if the modal mounted on `resource` alone and
    // the variant landed a tick later, a first-time user would see the price
    // for one frame. That is exactly the leak this branch's store-compliance
    // work exists to stop, so the hook must never expose a non-null resource
    // paired with a variant that hasn't been resolved for it.
    const seen: Array<{ resource: string | null; variant: string }> = [];
    const { result } = renderHook(() => {
      const state = useUpsellCadence(UID);
      seen.push({ resource: state.resource, variant: state.variant });
      return state;
    });

    act(() => result.current.show("board"));
    await waitFor(() => expect(result.current.resource).toBe("board"));

    // Every render that had a resource to show had already resolved "soft" for
    // it — there is no intermediate `{ resource: "board", variant: "hard" }`.
    const withResource = seen.filter((s) => s.resource !== null);
    expect(withResource.length).toBeGreaterThan(0);
    expect(withResource.every((s) => s.variant === "soft")).toBe(true);
  });

  it("falls back to soft, not hard, when storage is unavailable", async () => {
    mockGetItemImpl = () => Promise.reject(new Error("storage unavailable"));
    const { result } = renderHook(() => useUpsellCadence(UID));
    act(() => result.current.show("boardQa"));
    await waitFor(() => expect(result.current.resource).toBe("boardQa"));
    expect(result.current.variant).toBe("soft");
  });

  it("still shows the notice when storage is unavailable — a storage failure must not swallow the explanation", async () => {
    // Failing soft has to mean "gentler", never "silent". If a storage error
    // skipped the modal entirely, a blocked user would get no feedback at all,
    // which is the outcome the literal reading of ROADMAP.md:608 was rejected
    // for producing.
    mockGetItemImpl = () => {
      throw new Error("storage unavailable");
    };
    const { result } = renderHook(() => useUpsellCadence(UID));
    act(() => result.current.show("presenter"));
    await waitFor(() => expect(result.current.resource).toBe("presenter"));
  });

  it("dismiss clears the resource so the modal unmounts", async () => {
    const { result } = renderHook(() => useUpsellCadence(UID));
    act(() => result.current.show("customPalette"));
    await waitFor(() => expect(result.current.resource).toBe("customPalette"));
    act(() => result.current.dismiss());
    expect(result.current.resource).toBeNull();
  });

  it("does not set state after unmount when the lookup resolves late", async () => {
    // The board screen can be navigated away from between the gate hit and the
    // storage read completing. Being honest about what this does and does not
    // prove: React 18+ dropped the "can't perform a state update on an
    // unmounted component" warning, so the console spy is a tripwire for a
    // renderer that reintroduces one, not the substance. What it actually
    // pins is that a lookup resolving after unmount neither throws nor takes
    // the suite down — the `mounted` ref's real job is to not resurrect a
    // modal onto a screen the user has already left, which no assertion
    // available here can observe directly.
    let release: (v: string | null) => void = () => {};
    mockGetItemImpl = () =>
      new Promise<string | null>((resolve) => {
        release = resolve;
      });

    const { result, unmount } = renderHook(() => useUpsellCadence(UID));
    act(() => result.current.show("board"));
    unmount();

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      release(null);
      await Promise.resolve();
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("show() never rejects, so a gate hit can't surface as an unhandled rejection", async () => {
    mockGetItemImpl = () => Promise.reject(new Error("storage unavailable"));
    const { result } = renderHook(() => useUpsellCadence(UID));
    expect(() => act(() => result.current.show("board"))).not.toThrow();
    await waitFor(() => expect(result.current.resource).toBe("board"));
  });

  it("keeps a stable identity for show/dismiss across renders, so callers can pass them into memoised children", () => {
    const { result, rerender } = renderHook(() => useUpsellCadence(UID));
    const firstShow = result.current.show;
    const firstDismiss = result.current.dismiss;
    rerender({});
    expect(result.current.show).toBe(firstShow);
    expect(result.current.dismiss).toBe(firstDismiss);
  });
});
