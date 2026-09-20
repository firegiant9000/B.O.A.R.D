// useBoardTools imports shapeRecognitionService, which imports
// firebase/firestore — the same ESM-transform issue every other test that
// transitively touches Firebase works around (see e.g. workspaceService.test.ts).
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));

// useBoardTools -> useShortcuts -> hardwareKeys(.native) -> react-native-key-command,
// which calls a native-module getConstants() at its own module scope — a real
// crash outside a device, regardless of `enabled` (the effect that would
// actually CALL registerHardwareKeys never runs with `enabled: false` below,
// but just importing the module already throws before that guard is reached).
jest.mock("../../lib/hardwareKeys", () => ({
  registerHardwareKeys: jest.fn(() => () => undefined),
}));

import { renderHook, act } from "@testing-library/react-native";
import { useBoardTools } from "../useBoardTools";

/**
 * useBoardTools.test.ts — Month 5 (ROADMAP item 12), fix round 1, item 8.
 *
 * `enabled: false` and `userId: undefined` keep this a pure state-machine
 * test: `useShortcuts` no-ops both its web (DOM) and native (hardware-key)
 * effects when `enabled` is false, and the auto-perfect mode load
 * (`shapeRecognitionService.getShapeRecognitionMode`) only fires when a
 * `userId` is given — neither needs mocking for what this file actually
 * exercises.
 */

function makeOpts() {
  return {
    userId: undefined,
    enabled: false,
    editingTextId: null,
    onModifiers: jest.fn(),
    onCommand: jest.fn(),
  };
}

describe("eyedropper arming disarms on any tool switch (fix round 1, item 8)", () => {
  it("armEyedropper sets the flag, and setActiveTool clears it again", () => {
    const { result } = renderHook(() => useBoardTools(makeOpts()));

    act(() => result.current.armEyedropper());
    expect(result.current.eyedropperArmed).toBe(true);

    act(() => result.current.setActiveTool("select"));
    expect(result.current.eyedropperArmed).toBe(false);
  });

  it("switching tools while NOT armed is a harmless no-op on the flag", () => {
    const { result } = renderHook(() => useBoardTools(makeOpts()));

    expect(result.current.eyedropperArmed).toBe(false);
    act(() => result.current.setActiveTool("eraser"));
    expect(result.current.eyedropperArmed).toBe(false);
  });

  it("activateSelect (used by several non-tool-button call sites) also disarms", () => {
    const { result } = renderHook(() => useBoardTools(makeOpts()));

    act(() => result.current.armEyedropper());
    act(() => result.current.activateSelect());
    expect(result.current.eyedropperArmed).toBe(false);
    expect(result.current.activeTool).toBe("select");
  });

  it("toggleEyedropper flips the flag both ways", () => {
    const { result } = renderHook(() => useBoardTools(makeOpts()));

    act(() => result.current.toggleEyedropper());
    expect(result.current.eyedropperArmed).toBe(true);
    act(() => result.current.toggleEyedropper());
    expect(result.current.eyedropperArmed).toBe(false);
  });
});

describe("chooseColor (fix round 1, item 7 — the one entry point every colour choice goes through)", () => {
  it("sets the active colour and records it as the most recent", () => {
    const { result } = renderHook(() => useBoardTools(makeOpts()));

    act(() => result.current.chooseColor("#ff0000"));
    expect(result.current.activeColor).toBe("#ff0000");
    expect(result.current.recentColors).toEqual(["#ff0000"]);
  });

  it("re-choosing an existing recent colour moves it to the front instead of duplicating", () => {
    const { result } = renderHook(() => useBoardTools(makeOpts()));

    act(() => result.current.chooseColor("#ff0000"));
    act(() => result.current.chooseColor("#00ff00"));
    act(() => result.current.chooseColor("#ff0000"));

    expect(result.current.recentColors).toEqual(["#ff0000", "#00ff00"]);
  });
});
