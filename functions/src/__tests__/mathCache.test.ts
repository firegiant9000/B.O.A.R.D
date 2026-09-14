// Month 6 — math elements. The content-hash cache: key construction and the
// fail-closed read. Firestore is a hand-rolled stub (one `doc()` returning a
// canned snapshot) — these are about what the module does with what it reads
// back, which is where the corrupt-document hazard lives.

import type { Firestore } from "firebase-admin/firestore";
import { mathCacheKey, getCachedMath, putCachedMath } from "../math/mathCache";
import { RENDER_VERSION } from "../math/mathRender";

function fakeDb(stored: unknown, opts: { exists?: boolean } = {}) {
  const sets: { path: string; value: unknown }[] = [];
  const db = {
    doc: (path: string) => ({
      get: async () => ({ exists: opts.exists ?? stored !== undefined, data: () => stored }),
      set: async (value: unknown) => {
        sets.push({ path, value });
      },
    }),
  } as unknown as Firestore;
  return { db, sets };
}

const GOOD = { svgPath: "M 0 0 L 1 1", width: 12, height: 8, createdAt: 5 };

describe("mathCacheKey (Month 6)", () => {
  it("is stable for identical input", () => {
    expect(mathCacheKey("x^2", true)).toBe(mathCacheKey("x^2", true));
  });

  it("separates different expressions and different typesetting modes", () => {
    expect(mathCacheKey("x^2", true)).not.toBe(mathCacheKey("x^3", true));
    // Display and inline genuinely render differently (limits above a sum vs
    // beside it), so one must never be served for the other.
    expect(mathCacheKey("x^2", true)).not.toBe(mathCacheKey("x^2", false));
  });

  it("mixes in RENDER_VERSION so a renderer change invalidates every entry", () => {
    // This is the one thing that differs from ocrCache/flashcardCache, which
    // key on their INPUTS' identity. This cache stores OUR OWN rendering, and
    // `svgPath` is then copied onto the element — so serving a stale entry
    // after the em size or rounding changes would persist indefinitely.
    // Recomputing the documented key here is the check: if the version were
    // dropped from the hash, these two would stop differing.
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const withCurrent = createHash("sha1").update(`${RENDER_VERSION} display x^2`).digest("hex");
    const withNext = createHash("sha1").update(`${RENDER_VERSION + 1} display x^2`).digest("hex");
    expect(mathCacheKey("x^2", true)).toBe(withCurrent);
    expect(withCurrent).not.toBe(withNext);
  });
});

describe("getCachedMath — fail closed on a corrupt entry (Month 6)", () => {
  it("returns a well-formed entry", async () => {
    const { db } = fakeDb(GOOD);
    await expect(getCachedMath(db, "b1", "k")).resolves.toEqual(GOOD);
  });

  it("misses when the document does not exist", async () => {
    const { db } = fakeDb(undefined, { exists: false });
    await expect(getCachedMath(db, "b1", "k")).resolves.toBeNull();
  });

  it.each([
    ["a NaN width", { ...GOOD, width: NaN }],
    ["a NaN height", { ...GOOD, height: NaN }],
    ["an Infinity width", { ...GOOD, width: Infinity }],
    ["a zero width", { ...GOOD, width: 0 }],
    ["a negative height", { ...GOOD, height: -3 }],
    ["a string width", { ...GOOD, width: "12" }],
    ["a missing width", { svgPath: "M 0 0", height: 8, createdAt: 0 }],
    ["an empty svgPath", { ...GOOD, svgPath: "" }],
    ["a non-string svgPath", { ...GOOD, svgPath: 42 }],
  ])("treats %s as a MISS rather than serving it", async (_label, stored) => {
    // `typeof NaN === "number"`, so a bare typeof check would let the first
    // three straight through to the client as a NaN-sized element. Re-
    // rendering costs ~1ms; trusting a corrupt entry costs a broken element
    // that stays broken, because the client copies `svgPath` onto the doc.
    const { db } = fakeDb(stored);
    await expect(getCachedMath(db, "b1", "k")).resolves.toBeNull();
  });

  it("tolerates a missing createdAt rather than failing the read", async () => {
    // Unlike the geometry, createdAt is not load-bearing for rendering.
    const { db } = fakeDb({ svgPath: "M 0 0", width: 1, height: 1 });
    await expect(getCachedMath(db, "b1", "k")).resolves.toMatchObject({ createdAt: 0 });
  });
});

describe("putCachedMath (Month 6)", () => {
  it("writes under the board's own mathCache subcollection", async () => {
    const { db, sets } = fakeDb(undefined);
    await putCachedMath(db, "board-9", "hash-1", GOOD);
    expect(sets).toEqual([{ path: "boards/board-9/mathCache/hash-1", value: GOOD }]);
  });
});
