import { createHash } from "crypto";
import { sha256Hex } from "../sha256";

/** Node's own sha256 as the independent oracle — this suite exists precisely
 *  because sha256Hex is a from-spec reimplementation (no platform offers a
 *  synchronous digest; see sha256.ts's header), so it is verified against a
 *  trusted implementation rather than against its own expected output. */
function oracle(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("sha256Hex", () => {
  it("matches the well-known published SHA-256 test vectors for the empty string and 'abc'", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it.each([
    "",
    "abc",
    "ws-secret-id",
    "student@university.edu",
    "a".repeat(55), // pads within the same 64-byte block
    "a".repeat(56), // exactly at the boundary — needs a second block
    "a".repeat(63),
    "a".repeat(64),
    "a".repeat(1000),
    "unicode-éè中文", // multi-byte UTF-8, no surrogate pairs
    "emoji-😀-emoji", // surrogate pair (outside the BMP)
  ])("matches Node's crypto for %j", (input) => {
    expect(sha256Hex(input)).toBe(oracle(input));
  });

  it("is deterministic", () => {
    expect(sha256Hex("ws-secret-id")).toBe(sha256Hex("ws-secret-id"));
  });

  it("returns a 64-char lowercase hex string", () => {
    expect(sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different output for different input (not a constant)", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
