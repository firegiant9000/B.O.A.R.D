import { sha256Hex } from "../../lib/sha256";

// The single mock capture fn stands in for BOTH vendor methods (capture and
// identify) — analyticsService.ts may route identifyWorkspace through either
// one, and this mock doesn't care which; it only cares what reaches the
// vendor. Mirrors this repo's existing platform-split test convention
// (src/components/__tests__/PricingBody.test.tsx) of testing the seam
// against a mocked collaborator rather than the real vendor package.
// jest's module-factory hoisting only allows referencing out-of-scope
// variables named `mock*` (see src/services/__tests__/authProviders.test.ts's
// mockPromptAsync et al.) — so the mock itself is `mockCapture`/
// `mockCreateAnalyticsClient`, aliased below to the plain names the brief's
// literal tests use (`capture.mock.calls`).
const mockCapture = jest.fn();
const mockCreateAnalyticsClient = jest.fn(() => ({
  capture: mockCapture,
  identify: mockCapture,
}));
jest.mock("../posthogClient", () => ({
  createAnalyticsClient: mockCreateAnalyticsClient,
}));

const capture = mockCapture;
const createAnalyticsClient = mockCreateAnalyticsClient;

const KEY_VAR = "EXPO_PUBLIC_POSTHOG_KEY";
const HOST_VAR = "EXPO_PUBLIC_POSTHOG_HOST";

/** Load analyticsService fresh so its module-load-time env read (the
 *  configured key) re-evaluates — mirrors
 *  src/services/__tests__/authProviders.test.ts's loadProviders(). */
function loadAnalytics(): typeof import("../analyticsService") {
  let mod: typeof import("../analyticsService");
  jest.isolateModules(() => {
    mod = require("../analyticsService");
  });
  return mod!;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[KEY_VAR];
  delete process.env[HOST_VAR];
});

describe("with a configured PostHog key", () => {
  let track: typeof import("../analyticsService").track;
  let identifyWorkspace: typeof import("../analyticsService").identifyWorkspace;

  beforeEach(() => {
    process.env[KEY_VAR] = "phc_test_key";
    ({ track, identifyWorkspace } = loadAnalytics());
  });

  // Brief Step 1, verbatim.
  it("hashes the workspace id rather than sending it raw", () => {
    identifyWorkspace("ws-secret-id", "owner");
    expect(JSON.stringify(capture.mock.calls)).not.toContain("ws-secret-id");
  });

  // Falsifiability: the test above passes trivially if the vendor was never
  // called at all (the default state with no key). This proves the vendor
  // WAS invoked, and with a genuine sha256 hash of the raw id — not merely
  // an omission, truncation, or reversal that would also dodge the
  // `.not.toContain` check above.
  it("actually calls the vendor with a real hash of the workspace id, not merely omitting it", () => {
    identifyWorkspace("ws-secret-id", "owner");
    expect(capture).toHaveBeenCalledTimes(1);
    const [distinctId, properties] = capture.mock.calls[0];
    expect(distinctId).toBe(sha256Hex("ws-secret-id").slice(0, 16));
    expect(distinctId).toMatch(/^[0-9a-f]{16}$/);
    expect(properties).toEqual({ role: "owner" });
  });

  // Brief Step 1, verbatim.
  it("strips anything email-shaped from event properties", () => {
    track("board_created", { who: "student@university.edu" } as never);
    expect(JSON.stringify(capture.mock.calls)).not.toMatch(/@/);
  });

  // Falsifiability: proves the event was actually forwarded with the
  // property redacted, rather than the whole call being dropped (which would
  // also satisfy the `.not.toMatch(/@/)` check above without the scrub doing
  // anything).
  it("forwards the event with the email-shaped property redacted, not silently dropped", () => {
    track("board_created", {
      who: "student@university.edu",
      boardId: "b1",
    } as never);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("board_created", {
      who: "[redacted]",
      boardId: "b1",
    });
  });

  it("redacts an email nested inside an object or array — a shallow, top-level-only scrub would miss both", () => {
    track("board_created", {
      invitees: ["a@b.com", "plain-name"],
      user: { email: "c@d.com", role: "member" },
    } as never);
    expect(capture).toHaveBeenCalledTimes(1);
    const [, properties] = capture.mock.calls[0];
    expect(JSON.stringify(properties)).not.toMatch(/@/);
    expect(properties).toEqual({
      invitees: ["[redacted]", "plain-name"],
      user: { email: "[redacted]", role: "member" },
    });
  });

  // A roster keyed by email is an ordinary shape (student rosters flow
  // through this app — see this file's header) — the scrub must also check
  // the KEY string itself, not only values and key names.
  it("drops an entry whose key itself is email-shaped content, e.g. a roster keyed by email", () => {
    track("board_created", {
      "student@university.edu": true,
      boardId: "b1",
    } as never);
    expect(capture).toHaveBeenCalledTimes(1);
    const [, properties] = capture.mock.calls[0];
    expect(JSON.stringify(properties)).not.toMatch(/@/);
    expect(properties).toEqual({ boardId: "b1" });
  });

  it("drops both entries — never collides them into one — when two keys are email-shaped", () => {
    track("board_created", {
      "a@university.edu": 1,
      "b@university.edu": 2,
      safe: "ok",
    } as never);
    const [, properties] = capture.mock.calls[0];
    expect(JSON.stringify(properties)).not.toMatch(/@/);
    expect(properties).toEqual({ safe: "ok" });
    expect(Object.keys(properties as object)).toEqual(["safe"]);
  });

  it("redacts a value under a key literally named email even without an @ in it, closing the obvious loophole", () => {
    track("board_created", { email: "not-shaped-like-one" } as never);
    const [, properties] = capture.mock.calls[0];
    expect(properties).toEqual({ email: "[redacted]" });
  });

  it("redacts camelCase and snake_case email-token keys the same way, not just the bare word", () => {
    track("board_created", {
      userEmail: "not-shaped-like-one",
      contact_email: "also-not-shaped-like-one",
    } as never);
    const [, properties] = capture.mock.calls[0];
    expect(properties).toEqual({
      userEmail: "[redacted]",
      contact_email: "[redacted]",
    });
  });

  // This app ships voice notes (Month 5) — a naive `/email/i` substring test
  // on the key name would wrongly redact "voicemail" fields. Proves the key
  // heuristic is token-aware, not a substring match.
  it("does not redact a key that merely contains the substring 'email', like voicemailDuration", () => {
    track("board_created", { voicemailDuration: 42 } as never);
    expect(capture).toHaveBeenCalledWith("board_created", {
      voicemailDuration: 42,
    });
  });

  it("redacts rather than recursing forever on pathologically deep input", () => {
    let nested: Record<string, unknown> = { leaf: "a@b.com" };
    for (let i = 0; i < 12; i++) nested = { child: nested };
    expect(() => track("board_created", nested as never)).not.toThrow();
    const [, properties] = capture.mock.calls[0];
    // Whether the leaf email is reached before the depth cap doesn't matter —
    // either way, nothing email-shaped reaches the vendor.
    expect(JSON.stringify(properties)).not.toMatch(/@/);
  });

  it("still throws for an undocumented event even when a key IS configured — the taxonomy guard does not depend on key state", () => {
    expect(() => track("made_up_event" as never)).toThrow();
    expect(capture).not.toHaveBeenCalled();
  });

  it("forwards a documented event with non-PII properties untouched", () => {
    track("session_completed", { durationMinutes: 42 } as never);
    expect(capture).toHaveBeenCalledWith("session_completed", {
      durationMinutes: 42,
    });
  });

  it("forwards a documented event with no properties at all", () => {
    track("signup");
    expect(capture).toHaveBeenCalledWith("signup", undefined);
  });

  // REPLACES "does not yet include an install event for the not-yet-built
  // browser extension", whose premise stopped being true: web/extension/
  // {manifest.json,background.js,sidepanel.js,shared.js,content.js} all ship
  // in this repo, and ROADMAP.md:685 requires an install event per
  // integration surface. The name is `extension_installed`; the old test's
  // `browser_extension_installed` was never the name, so it still throws —
  // asserted below so this reads as a rename of a real event rather than a
  // guess at one.
  it("includes an install event for the browser extension, which does now ship in this repo", () => {
    expect(() => track("extension_installed")).not.toThrow();
    expect(capture).toHaveBeenCalledWith("extension_installed", undefined);
  });

  it("still rejects an install event that is not in the list, however plausible the name", () => {
    expect(() => track("browser_extension_installed" as never)).toThrow();
  });

  it.each([
    "signup",
    "workspace_created",
    "board_created",
    "session_scheduled",
    "session_completed",
    "ai_summary_generated",
    "upgrade_viewed",
    "upgrade_completed",
    "meet_addon_installed",
    "extension_installed",
  ] as const)("accepts the documented event %s without throwing", (event) => {
    expect(() => track(event)).not.toThrow();
  });
});

describe("without a configured PostHog key", () => {
  let track: typeof import("../analyticsService").track;
  let identifyWorkspace: typeof import("../analyticsService").identifyWorkspace;

  beforeEach(() => {
    ({ track, identifyWorkspace } = loadAnalytics());
  });

  // Brief Step 1, verbatim.
  it("no-ops without a configured key rather than throwing", () => {
    expect(() => track("signup")).not.toThrow();
  });

  // Falsifiability: proves the no-op is real (the vendor is never reached),
  // not just that track() happens not to throw for some unrelated reason.
  it("never reaches the vendor when no key is configured", () => {
    track("signup");
    identifyWorkspace("ws-1", "owner");
    expect(capture).not.toHaveBeenCalled();
    expect(createAnalyticsClient).not.toHaveBeenCalled();
  });

  // Brief Step 1, verbatim.
  it("only emits events from the documented taxonomy", () => {
    expect(() => track("made_up_event" as never)).toThrow();
  });

  it("still throws for an undocumented event with no key configured — the two failure modes are independent", () => {
    expect(() => track("made_up_event" as never)).toThrow();
    expect(capture).not.toHaveBeenCalled();
  });

  it("identifyWorkspace also no-ops without a configured key rather than throwing", () => {
    expect(() => identifyWorkspace("ws-1", "owner")).not.toThrow();
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("when the vendor client fails to construct", () => {
  let track: typeof import("../analyticsService").track;

  beforeEach(() => {
    process.env[KEY_VAR] = "phc_test_key";
    mockCreateAnalyticsClient.mockImplementationOnce(() => {
      throw new Error("native module unavailable");
    });
    ({ track } = loadAnalytics());
  });

  it("degrades to a no-op rather than crashing the caller — a key is configured, but the vendor threw on init", () => {
    expect(() => track("signup")).not.toThrow();
    expect(capture).not.toHaveBeenCalled();
  });
});

// The sibling failure to the construction one above, and the one that
// actually matters now that this seam is called from eleven user-critical
// paths (ROADMAP.md:685's funnel instrumentation) rather than one: the client
// constructs fine and then the vendor throws mid-call. Before the funnel work
// this was unguarded, so "analytics never breaks a user action" held only
// because no environment has a PostHog key configured yet (Gate G5) — i.e.
// only because nothing ever reached the vendor at all.
describe("when the vendor client itself throws mid-call", () => {
  let track: typeof import("../analyticsService").track;
  let identifyWorkspace: typeof import("../analyticsService").identifyWorkspace;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env[KEY_VAR] = "phc_test_key";
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockCapture.mockImplementation(() => {
      throw new Error("vendor exploded");
    });
    ({ track, identifyWorkspace } = loadAnalytics());
  });

  afterEach(() => {
    warn.mockRestore();
    mockCapture.mockReset();
  });

  it("never lets a capture failure reach the user action that reported the event", () => {
    expect(() => track("signup")).not.toThrow();
    expect(capture).toHaveBeenCalled(); // premise: the vendor really was reached
  });

  it("never lets an identify failure reach the caller either", () => {
    expect(() => identifyWorkspace("ws-1", "owner")).not.toThrow();
  });

  it("still throws for an undocumented event — a programmer error is not a vendor failure and must stay loud", () => {
    // The guard is deliberately scoped to the vendor call, not wrapped around
    // the taxonomy check: swallowing that too would turn a typo'd event name
    // into silence.
    expect(() => track("made_up_event" as never)).toThrow();
  });
});
