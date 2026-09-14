import { resolveViewportSource } from "../presenter";

const c = (uid: string, extra: object = {}) => ({ userId: uid, displayName: uid, x: 0, y: 0, tool: "pen", updatedAt: 0, ...extra });

describe("resolveViewportSource", () => {
  it("returns null when nobody presents and nobody is followed", () => {
    expect(resolveViewportSource([c("a"), c("b")], "a", null)).toBeNull();
  });

  it("follows the chosen user when there is no presenter", () => {
    expect(resolveViewportSource([c("a"), c("b")], "a", "b")).toBe("b");
  });

  it("lets an active presenter override an individual follow choice", () => {
    expect(resolveViewportSource([c("a"), c("b"), c("p", { presenting: true })], "a", "b")).toBe("p");
  });

  it("releases viewports when the presenter pauses", () => {
    const cursors = [c("a"), c("b"), c("p", { presenting: true, presenterPaused: true })];
    expect(resolveViewportSource(cursors, "a", "b")).toBe("b");
  });

  it("never makes the presenter follow themselves", () => {
    expect(resolveViewportSource([c("p", { presenting: true })], "p", null)).toBeNull();
  });

  it("ignores a stale presenter cursor", () => {
    // A cursor not refreshed within CURSOR_STALE_MS is already filtered by the
    // subscriber, so an empty list must not resurrect a presenter.
    expect(resolveViewportSource([], "a", "b")).toBeNull();
  });
});
