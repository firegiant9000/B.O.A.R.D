/**
 * Connectivity store (Phase 6). Each case re-imports the module so the
 * module-level state starts clean; Platform.OS is set per describe block.
 */

function loadModule() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../connectivity") as typeof import("../connectivity");
}

describe("connectivity store (native)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
  });

  afterEach(() => {
    jest.dontMock("react-native");
  });

  it("starts online with no pending writes", () => {
    const c = loadModule();
    expect(c.getConnectivity()).toEqual({ online: true, pendingWrites: false });
  });

  it("notifies subscribers and reflects pending writes", () => {
    const c = loadModule();
    const listener = jest.fn();
    c.subscribeConnectivity(listener);

    c.reportSyncState({ fromCache: false, hasPendingWrites: true });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(c.getConnectivity().pendingWrites).toBe(true);
  });

  it("does not flip offline from cache until the server has synced once", () => {
    const c = loadModule();
    // Cold load served from cache before any server round-trip — stay online.
    c.reportSyncState({ fromCache: true, hasPendingWrites: false });
    expect(c.getConnectivity().online).toBe(true);

    // Reach the server once...
    c.reportSyncState({ fromCache: false, hasPendingWrites: false });
    expect(c.getConnectivity().online).toBe(true);

    // ...then a later cache-only snapshot means we lost the connection.
    c.reportSyncState({ fromCache: true, hasPendingWrites: false });
    expect(c.getConnectivity().online).toBe(false);
  });

  it("coalesces no-op updates (no extra notifications)", () => {
    const c = loadModule();
    const listener = jest.fn();
    c.subscribeConnectivity(listener);

    c.reportSyncState({ fromCache: false, hasPendingWrites: false });
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const c = loadModule();
    const listener = jest.fn();
    const unsub = c.subscribeConnectivity(listener);
    unsub();

    c.reportSyncState({ fromCache: false, hasPendingWrites: true });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("connectivity store (web)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("react-native", () => ({ Platform: { OS: "web" } }));
  });

  afterEach(() => {
    jest.dontMock("react-native");
  });

  it("trusts navigator.onLine for online, not fromCache", () => {
    const c = loadModule();
    // On web the OS signal owns `online`; a cache-only snapshot must not flip it.
    c.reportSyncState({ fromCache: true, hasPendingWrites: true });
    expect(c.getConnectivity().online).toBe(true);
    expect(c.getConnectivity().pendingWrites).toBe(true);
  });
});
