import fs from "fs";
import path from "path";

// Two SEPARATE physical modules, not one module switched by a runtime
// Platform.OS check — mirrors src/components/__tests__/PricingBody.test.tsx's
// own header comment exactly (same haste-platform resolution mechanics, same
// repo):
//
//   - `"../posthogClient"` (no extension) resolves the way a real consumer's
//     import resolves under this repo's Jest config: `haste.platforms` for
//     the bare "jest-expo" preset is `['android', 'ios', 'native']` with
//     `defaultPlatform: 'ios'` — no `.ios.ts` file exists here, so the
//     resolver falls through to `.native.ts`, which does. This is the SAME
//     resolution a native build's bundler performs.
//   - `"../posthogClient.ts"` (explicit extension) bypasses platform-extension
//     resolution entirely to reach the bare (web) file.

const mockInit = jest.fn();
const mockWebCapture = jest.fn();
const mockWebIdentify = jest.fn();
jest.mock("posthog-js", () => ({
  init: mockInit,
  capture: mockWebCapture,
  identify: mockWebIdentify,
}));

const mockRnCapture = jest.fn();
const mockRnIdentify = jest.fn();
const MockPostHog = jest.fn().mockImplementation(() => ({
  capture: mockRnCapture,
  identify: mockRnIdentify,
}));
jest.mock("posthog-react-native", () => ({
  __esModule: true,
  default: MockPostHog,
}));

describe("posthogClient.ts (web, imports posthog-js)", () => {
  let createAnalyticsClient: typeof import("../posthogClient").createAnalyticsClient;

  beforeEach(() => {
    jest.clearAllMocks();
    createAnalyticsClient = require("../posthogClient.ts").createAnalyticsClient;
  });

  it("imports posthog-js, not posthog-react-native", () => {
    // Scoped to actual import/require syntax, not the full source text — the
    // header comment legitimately names the sibling file in prose.
    const source = fs.readFileSync(path.join(__dirname, "../posthogClient.ts"), "utf8");
    expect(source).toMatch(/from ["']posthog-js["']/);
    expect(source).not.toMatch(/from ["']posthog-react-native["']/);
    expect(source).not.toMatch(/require\(["']posthog-react-native["']\)/);
  });

  it("initializes posthog-js with the given key and host", () => {
    createAnalyticsClient("phc_key", "https://custom.host");
    expect(mockInit).toHaveBeenCalledWith(
      "phc_key",
      expect.objectContaining({ api_host: "https://custom.host" })
    );
  });

  it("falls back to the PostHog US cloud host when none is configured", () => {
    createAnalyticsClient("phc_key", undefined);
    expect(mockInit).toHaveBeenCalledWith(
      "phc_key",
      expect.objectContaining({ api_host: expect.stringMatching(/^https:\/\//) })
    );
  });

  it("disables the SDK's own autocapture, pageview, and session recording", () => {
    createAnalyticsClient("phc_key", undefined);
    const config = mockInit.mock.calls[0][1];
    expect(config.autocapture).toBe(false);
    expect(config.capture_pageview).toBe(false);
    expect(config.disable_session_recording).toBe(true);
  });

  it("delegates capture() and identify() to the underlying posthog-js singleton", () => {
    const client = createAnalyticsClient("phc_key", undefined);
    client.capture("signup", { a: 1 });
    client.identify("hash123", { role: "owner" });
    expect(mockWebCapture).toHaveBeenCalledWith("signup", { a: 1 });
    expect(mockWebIdentify).toHaveBeenCalledWith("hash123", { role: "owner" });
  });

  it("passes null (not undefined) to posthog-js when a capture has no properties", () => {
    const client = createAnalyticsClient("phc_key", undefined);
    client.capture("signup");
    expect(mockWebCapture).toHaveBeenCalledWith("signup", null);
  });
});

describe("posthogClient.native.ts (native, imports posthog-react-native)", () => {
  let createAnalyticsClient: typeof import("../posthogClient").createAnalyticsClient;

  beforeEach(() => {
    jest.clearAllMocks();
    // Bare import resolves to the `.native.ts` sibling under this repo's Jest
    // haste-platform config — see this file's header.
    createAnalyticsClient = require("../posthogClient").createAnalyticsClient;
  });

  it("imports posthog-react-native, not posthog-js", () => {
    // Scoped to actual import/require syntax, not the full source text — the
    // header comment legitimately names the sibling file in prose.
    const source = fs.readFileSync(
      path.join(__dirname, "../posthogClient.native.ts"),
      "utf8"
    );
    expect(source).toMatch(/from ["']posthog-react-native["']/);
    expect(source).not.toMatch(/from ["']posthog-js["']/);
    expect(source).not.toMatch(/require\(["']posthog-js["']\)/);
  });

  it("constructs a PostHog client with the given key and host", () => {
    createAnalyticsClient("phc_key", "https://custom.host");
    expect(MockPostHog).toHaveBeenCalledWith(
      "phc_key",
      expect.objectContaining({ host: "https://custom.host" })
    );
  });

  it("falls back to the PostHog US cloud host when none is configured", () => {
    createAnalyticsClient("phc_key", undefined);
    expect(MockPostHog).toHaveBeenCalledWith(
      "phc_key",
      expect.objectContaining({ host: expect.stringMatching(/^https:\/\//) })
    );
  });

  it("disables the SDK's own app-lifecycle and push autocapture", () => {
    createAnalyticsClient("phc_key", undefined);
    const config = MockPostHog.mock.calls[0][1];
    expect(config.captureAppLifecycleEvents).toBe(false);
    expect(config.capturePushNotificationSubscriptions).toBe(false);
    expect(config.capturePushNotificationOpened).toBe(false);
  });

  it("delegates capture() and identify() to the underlying PostHog instance", () => {
    const client = createAnalyticsClient("phc_key", undefined);
    client.capture("signup", { a: 1 });
    client.identify("hash123", { role: "owner" });
    expect(mockRnCapture).toHaveBeenCalledWith("signup", { a: 1 });
    expect(mockRnIdentify).toHaveBeenCalledWith("hash123", { role: "owner" });
  });
});
