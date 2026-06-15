import { toggleFollow, wouldCreateCycle, resolveFollow } from "../followMode";

describe("toggleFollow", () => {
  it("starts following from idle", () => {
    expect(toggleFollow(null, "b", "me")).toBe("b");
  });

  it("stops when tapping the user already followed", () => {
    expect(toggleFollow("b", "b", "me")).toBeNull();
  });

  it("switches to a different user", () => {
    expect(toggleFollow("b", "c", "me")).toBe("c");
  });

  it("never follows yourself", () => {
    expect(toggleFollow(null, "me", "me")).toBeNull();
    expect(toggleFollow("b", "me", "me")).toBe("b");
  });
});

describe("wouldCreateCycle", () => {
  it("is false for a target who follows nobody", () => {
    expect(wouldCreateCycle({ b: null }, "me", "b")).toBe(false);
  });

  it("is true when the target follows me directly (A↔B)", () => {
    expect(wouldCreateCycle({ b: "me" }, "me", "b")).toBe(true);
  });

  it("is true for a transitive loop back to me", () => {
    expect(wouldCreateCycle({ b: "c", c: "me" }, "me", "b")).toBe(true);
  });

  it("terminates on a pre-existing cycle that excludes me", () => {
    expect(wouldCreateCycle({ b: "c", c: "b" }, "me", "b")).toBe(false);
  });
});

describe("resolveFollow", () => {
  it("allows a non-cyclic follow", () => {
    expect(resolveFollow(null, "b", "me", { b: null })).toBe("b");
  });

  it("refuses a follow that would close a cycle, keeping the current state", () => {
    expect(resolveFollow(null, "b", "me", { b: "me" })).toBeNull();
    expect(resolveFollow("c", "b", "me", { b: "me", c: null })).toBe("c");
  });

  it("still permits unfollowing (toggle off) regardless of the map", () => {
    expect(resolveFollow("b", "b", "me", { b: "me" })).toBeNull();
  });
});
