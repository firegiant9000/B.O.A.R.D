// react-native-svg's real native `Path` host component processes/normalizes
// its props (colors become opaque native colour objects, and an unrecognized
// prop like `style` is dropped entirely before it ever reaches a rendered
// tree's `toJSON()`) — that processing happens regardless of this test's own
// runtime `Platform.OS`, since Jest resolves react-native-svg's NATIVE
// implementation file for this whole test run (platform-extension
// resolution is a module-resolution-time decision, not a `Platform.OS`
// runtime branch — see UpsellModal.test.tsx's header for the same
// distinction applied to this project's own `.native.tsx` files). So this
// mocks only `Path` (keeping every other react-native-svg export real) to
// capture EXACTLY what props `StrokeSvg`/`multiplyBlendStyle` decided to
// pass, independent of react-native-svg's own prop pipeline — which is
// exactly what this test needs to verify (this file's own code, not
// react-native-svg's internals, which were verified by reading its source —
// see DrawingCanvas.tsx#multiplyBlendStyle's own comment).
let capturedPathProps: any = null;
jest.mock("react-native-svg", () => {
  const actual = jest.requireActual("react-native-svg");
  return {
    ...actual,
    Path: (props: any) => {
      capturedPathProps = props;
      return null;
    },
  };
});

import React from "react";
import { Platform } from "react-native";
import { render } from "@testing-library/react-native";
import { StrokeSvg, StrokeVisual } from "../DrawingCanvas";

/**
 * DrawingCanvas.test.tsx — Month 5 (ROADMAP item 12), fix round 1, item 10.
 *
 * `DrawingCanvas` itself has no test file: it needs `react-native-gesture-
 * handler`'s real `GestureDetector`/`Gesture.Pan()` wiring and a viewport,
 * which every other canvas-adjacent test in this repo avoids by mocking the
 * whole component (see `BoardCanvas.test.tsx`). `StrokeSvg` is exported
 * SOLELY so this one behaviour — `multiplyBlendStyle` turning `multiplyBlend`
 * into a real `style` prop on web and into nothing on native, the one piece
 * of this task resting on an undeclared third-party (`react-native-svg`)
 * prop — has a render-level check instead of only `penStyles.test.ts`'s
 * check that the FLAG comes out of `renderParamsFor` correctly.
 */

function makeVisual(multiplyBlend: boolean): StrokeVisual {
  return {
    d: "M0 0 L10 10",
    fillMode: false,
    paintColor: "#ffcc00",
    paintOpacity: 0.35,
    strokeWidth: 8,
    linecap: "round",
    linejoin: "round",
    multiplyBlend,
  };
}

describe("StrokeSvg — multiply-blend style reaches the Path element (fix round 1, item 10)", () => {
  const originalOS = Platform.OS;
  beforeEach(() => {
    capturedPathProps = null;
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  it("web + multiplyBlend: passes a mix-blend-mode style to Path", () => {
    Platform.OS = "web";
    render(<StrokeSvg visual={makeVisual(true)} />);
    expect(capturedPathProps.style).toEqual({ mixBlendMode: "multiply" });
  });

  it("web + no multiplyBlend (e.g. plain pen/marker): no style prop at all", () => {
    Platform.OS = "web";
    render(<StrokeSvg visual={makeVisual(false)} />);
    expect(capturedPathProps.style).toBeUndefined();
  });

  it("native (ios) + multiplyBlend: no style prop — RNSVG's native backend has no CSS pipeline to forward it into", () => {
    Platform.OS = "ios";
    render(<StrokeSvg visual={makeVisual(true)} />);
    expect(capturedPathProps.style).toBeUndefined();
  });

  it("native (android) + multiplyBlend: same — the flag never reaches a native prop", () => {
    Platform.OS = "android";
    render(<StrokeSvg visual={makeVisual(true)} />);
    expect(capturedPathProps.style).toBeUndefined();
  });

  it("the rest of the stroke's paint is passed identically regardless of platform", () => {
    Platform.OS = "web";
    render(<StrokeSvg visual={makeVisual(true)} />);
    const web = capturedPathProps;
    Platform.OS = "ios";
    render(<StrokeSvg visual={makeVisual(true)} />);
    const native = capturedPathProps;

    expect(web.stroke).toBe(native.stroke);
    expect(web.strokeOpacity).toBe(native.strokeOpacity);
    expect(web.d).toBe(native.d);
  });
});
