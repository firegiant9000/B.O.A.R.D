import fs from "fs";
import path from "path";

/**
 * Month 6 — the template library's validity gate.
 *
 * This starts from the template-library task brief's literal test and
 * strengthens it in four ways the literal version couldn't catch:
 *
 *  1. `files.length` is asserted EXACTLY (21), not `toBeGreaterThanOrEqual(15)`.
 *     A floor alone lets a file silently go missing (or an extra stray file
 *     appear) without ever failing.
 *  2. Every template asserts a minimum element count. `elements: []` satisfies
 *     `Array.isArray` and iterates zero times — the brief's per-element loop
 *     would pass on an empty stub without ever exercising its own assertion.
 *  3. Every element is checked against its OWN required fields (a shape needs
 *     a real `shape` kind, a text/note needs non-empty text/content), not just
 *     a valid `type` string — a `{ type: "text", text: "" }` stub would pass
 *     the brief's loop untouched.
 *  4. The unknown-kind branch explains WHY a kind is rejected instead of
 *     failing with an opaque `toContain` mismatch — see
 *     `assertKnownElementKind` below. `path`/`shape`/`text`/`note`/`image` are
 *     every element kind this app renders today (useBoardElements.ts's
 *     section map); poll/math/code are scheduled for later tasks and are
 *     deliberately NOT in this list until useBoardElements.ts and its
 *     writer/reader services actually support them.
 */

const TEMPLATES_DIR = path.join(__dirname, "../../templates");

// The template library's four groups (study, CS/engineering, classroom,
// meeting) — asserted by exact per-category count so a template silently
// landing in the wrong group (or a group losing a member) fails here rather
// than only being caught by a human recount.
const EXPECTED_CATEGORY_COUNTS: Record<string, number> = {
  study: 6,
  cs: 6,
  classroom: 5,
  meeting: 4,
};
const EXPECTED_TOTAL = Object.values(EXPECTED_CATEGORY_COUNTS).reduce((a, b) => a + b, 0);

const LIVE_ELEMENT_KINDS = ["path", "shape", "text", "note", "image"] as const;
const SHAPE_KINDS = ["rect", "ellipse", "line", "arrow", "triangle"];

function assertKnownElementKind(type: unknown, file: string): void {
  if (!LIVE_ELEMENT_KINDS.includes(type as (typeof LIVE_ELEMENT_KINDS)[number])) {
    throw new Error(
      `${file}: element type ${JSON.stringify(type)} is not one of the board element ` +
        `kinds this app renders today (${LIVE_ELEMENT_KINDS.join(", ")} — see ` +
        `useBoardElements.ts's section map). If this is a newer kind such as poll/math/` +
        `code, a template can't use it until useBoardElements.ts and its writer/reader ` +
        `services support it — extend this allowlist only after that lands, not before.`
    );
  }
}

describe("template library files", () => {
  const files = fs.existsSync(TEMPLATES_DIR)
    ? fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"))
    : [];

  it(`ships exactly ${EXPECTED_TOTAL} template files`, () => {
    expect(files.length).toBe(EXPECTED_TOTAL);
  });

  it("every template parses into a valid board with real content", () => {
    // Falsifiable even if the directory is empty: the assertion above already
    // fails the suite before this one would vacuously pass over zero files.
    const seenIds = new Set<string>();
    const categoryCounts: Record<string, number> = {};

    for (const f of files) {
      const t = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf8"));

      expect(t.schemaVersion).toBe(1);
      expect(typeof t.title).toBe("string");
      expect(t.title.trim().length).toBeGreaterThan(0);

      expect(typeof t.id).toBe("string");
      expect(t.id.length).toBeGreaterThan(0);
      // The filename IS the stable identifier — this is what a caller
      // (the gallery, analytics) passes around, so a mismatch here would
      // mean the file on disk isn't reachable by its own declared id.
      expect(f).toBe(`${t.id}.json`);
      expect(seenIds.has(t.id)).toBe(false);
      seenIds.add(t.id);

      expect(EXPECTED_CATEGORY_COUNTS[t.category]).toBeDefined();
      categoryCounts[t.category] = (categoryCounts[t.category] ?? 0) + 1;

      expect(Array.isArray(t.elements)).toBe(true);
      // A template with no content is not a template — this is the floor the
      // brief's own `elements: []` loophole needed.
      expect(t.elements.length).toBeGreaterThanOrEqual(4);

      for (const el of t.elements) {
        assertKnownElementKind(el.type, f);
        switch (el.type) {
          case "shape":
            expect(SHAPE_KINDS).toContain(el.shape);
            expect(Number.isFinite(el.x)).toBe(true);
            expect(Number.isFinite(el.y)).toBe(true);
            expect(Number.isFinite(el.width)).toBe(true);
            expect(Number.isFinite(el.height)).toBe(true);
            break;
          case "text":
            expect(typeof el.text).toBe("string");
            expect(el.text.trim().length).toBeGreaterThan(0);
            break;
          case "note":
            expect(typeof el.content).toBe("string");
            expect(el.content.trim().length).toBeGreaterThan(0);
            break;
          // "path" and "image" are valid live kinds (see LIVE_ELEMENT_KINDS)
          // but no template in this library uses either today — nothing
          // further to assert per-field for a kind that never appears.
        }
      }
    }

    // Every file actually landed in one of the four groups, in the exact
    // counts the task established — not merely "some 21 files exist".
    expect(categoryCounts).toEqual(EXPECTED_CATEGORY_COUNTS);
  });
});
