import { randomCode } from "../secureRandom";

describe("randomCode", () => {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  it("returns a string of the requested length", () => {
    expect(randomCode(6, ALPHABET)).toHaveLength(6);
    expect(randomCode(1, ALPHABET)).toHaveLength(1);
    expect(randomCode(32, ALPHABET)).toHaveLength(32);
  });

  it("only draws characters from the given alphabet", () => {
    const code = randomCode(200, ALPHABET);
    for (const ch of code) {
      expect(ALPHABET).toContain(ch);
    }
  });

  it("produces varied output (not a constant)", () => {
    const codes = new Set(Array.from({ length: 50 }, () => randomCode(6, ALPHABET)));
    // With 36^6 space, 50 draws colliding into <40 distinct values is effectively impossible.
    expect(codes.size).toBeGreaterThan(40);
  });

  it("rejects alphabets outside the 2-256 range", () => {
    expect(() => randomCode(6, "A")).toThrow();
    expect(() => randomCode(6, "")).toThrow();
  });

  it("works with the ambiguity-free session alphabet", () => {
    const SESSION = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = randomCode(6, SESSION);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(code).not.toMatch(/[IO01]/);
  });
});
