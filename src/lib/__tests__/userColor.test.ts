import { userColor } from "../userColor";

const PALETTE = ["#7c3aed", "#db2777", "#059669", "#d97706", "#dc2626"];

describe("userColor", () => {
  it("is deterministic for the same uid", () => {
    expect(userColor("user-123")).toBe(userColor("user-123"));
  });

  it("always returns a color from the palette", () => {
    for (const uid of ["a", "alice", "z9", "long-uid-0000", ""]) {
      expect(PALETTE).toContain(userColor(uid));
    }
  });

  it("spreads different uids across more than one color", () => {
    const seen = new Set(
      ["alice", "bob", "carol", "dave", "frank", "grace"].map(userColor)
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});
