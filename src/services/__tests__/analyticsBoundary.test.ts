import fs from "fs";
import path from "path";

// Converts onboardingService.ts's "STRUCTURAL guarantee" from a comment nobody
// can enforce into a build failure.
//
// WHAT IS GUARANTEED. `onboardingService.seedSampleWorkspace` gives every brand
// new account a demo board and a finished demo session by calling the shared
// service primitives directly — `boardService.createBoard`,
// `sessionService.createSession`, `endSession`, `updateSessionSummary`. The
// user asked for none of it. If any of those primitives emitted a funnel event
// internally, every single signup would report a `board_created`, a
// `session_scheduled` and a `session_completed` for work nobody did, and the
// clean pre-launch baseline ROADMAP.md:750 makes a launch gate would be
// corrupted by exactly the thing it is meant to measure — signups.
//
// That is why the funnel is instrumented at the point of USER INTENT (the
// screen or component where a person pressed the button) rather than in the
// shared primitive underneath, which is the convention the pre-existing
// `track("board_created")` in templateService.createBoardFromTemplate already
// set. This file pins the negative half of that convention, which is the half
// a comment cannot defend: these modules emit nothing.
//
// A SOURCE SCAN, not an import-graph walk or a runtime spy — the same tool
// src/lib/__tests__/pricingCopy.test.ts already uses for its own structural
// invariant, and for the same reason: the regression this guards against is
// someone ADDING a line to one of these files, and reading the file as text
// catches that whatever the line is wrapped in (a callback, a `.then`, a
// dynamic import) and whether or not any test happens to exercise the path.
//
// `onboardingService.ts` itself is on the list, not just the primitives it
// calls: moving the emit up into the seed would inflate the counters just as
// thoroughly as leaving it in `createBoard`.
const MUST_NOT_EMIT: Array<[label: string, relPath: string]> = [
  ["boardService.ts", "../boardService.ts"],
  ["sessionService.ts", "../sessionService.ts"],
  ["workspaceService.ts", "../workspaceService.ts"],
  ["onboardingService.ts", "../onboardingService.ts"],
];

const readRaw = (relPath: string) => fs.readFileSync(path.join(__dirname, relPath), "utf8");

/**
 * Source text with block and line comments blanked out.
 *
 * Needed because onboardingService.ts's header *documents* this very guarantee
 * by naming `track("board_created", …)` in prose, and the whole point of that
 * comment is to be read by the next person to touch the seed. A scan that
 * couldn't tell the documentation apart from an emit would force the comment to
 * be deleted to stay green — which would trade the thing being protected for
 * the protection.
 *
 * Deliberately naive: it does not parse strings or regex literals, so a `//`
 * inside a string literal (a URL, say) blanks the rest of that line. The only
 * way that could hide a real emit is a `track(` call sitting after a URL string
 * on one physical line, which is not a shape this codebase writes; and the
 * import scan below is unaffected by comment stripping either way, so it stays
 * a second, independent net.
 */
const read = (relPath: string) =>
  readRaw(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

describe("analytics boundary — the seeded sample workspace can never inflate the funnel", () => {
  it.each(MUST_NOT_EMIT)(
    "%s contains no track( call — the funnel is instrumented at the point of user intent, never in the shared primitive",
    (_label, relPath) => {
      const source = read(relPath);
      // Tolerates whitespace between the name and the paren, and ignores a
      // longer identifier ending in "track" (e.g. `backtrack(`), which is not
      // this seam.
      expect(source).not.toMatch(/(^|[^A-Za-z0-9_$.])track\s*\(/);
    }
  );

  it.each(MUST_NOT_EMIT)(
    "%s does not import the analytics seam at all, so it cannot emit under a renamed local binding either",
    (_label, relPath) => {
      // Belt and braces with the scan above, and strictly stronger against the
      // one way that scan can be defeated without anyone intending to defeat
      // it: `import { track as record } from "./analyticsService"` passes a
      // literal `track(` search and emits anyway.
      const source = read(relPath);
      expect(source).not.toMatch(/from\s+["'][^"']*analyticsService["']/);
      expect(source).not.toMatch(/from\s+["'][^"']*sessionAnalytics["']/);
    }
  );

  // Falsifiability. Every assertion above is a `not.toMatch`, which passes
  // trivially if the paths are wrong, the files move, or a rename leaves this
  // suite reading four empty strings. This proves the scanner and the paths are
  // real by pointing the SAME regex at a file that genuinely does emit.
  it("actually detects a track( call — proving the scan above is not passing on unread or empty files", () => {
    const emitter = read("../templateService.ts");
    expect(emitter).toMatch(/(^|[^A-Za-z0-9_$.])track\s*\(/);
    expect(emitter).toMatch(/from\s+["'][^"']*analyticsService["']/);
    for (const [, relPath] of MUST_NOT_EMIT) {
      expect(read(relPath).length).toBeGreaterThan(0);
    }
  });

  // The comment stripper is itself load-bearing (it is what lets the seed keep
  // documenting this guarantee in prose), so it gets its own check rather than
  // being trusted silently: the raw text of onboardingService.ts DOES mention
  // the call, and the stripped text used above does not.
  it("strips comments rather than deleting the seed's own documentation of this guarantee", () => {
    expect(readRaw("../onboardingService.ts")).toMatch(/track\("board_created"/);
    expect(read("../onboardingService.ts")).not.toMatch(/track\("board_created"/);
  });
});
