import * as fs from "fs";
import * as path from "path";

/**
 * Wiring guard: every production `UpsellModal` goes through `useUpsellCadence`.
 *
 * ROADMAP.md:608 (item 14) asks for restraint on a user's FIRST encounter with
 * a plan gate. That is a per-call-site property, not a per-component one — the
 * modal cannot enforce it, because a caller that supplies no `variant` gets the
 * `"hard"` default and the restraint silently disappears. Four of the six
 * production renderers were in exactly that state for a while: cadence-aware
 * hook, cadence-unaware call sites, and no test anywhere that could see it.
 *
 * A SOURCE SCAN rather than a render test, and the limits of that are worth
 * stating. Four of the six renderers are expo-router screens with a dozen
 * service dependencies each; standing those up would buy a weaker version of
 * what `WorkspaceSwitcher.test.tsx` and `useUpsellCadence.test.ts` already
 * assert behaviourally (that `variant` is wired, and that the variant it
 * carries is soft-then-hard). What no behavioural test covers is the SET of
 * call sites — that a seventh gate added tomorrow does not quietly take the
 * default. That is what this file is for, and it is the same scanning pattern
 * `UpsellModal.test.tsx` and `pricingCopy.test.ts` already use for the
 * store-compliance invariant.
 */

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCANNED_DIRS = ["app", "src"];
const CODE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** Every production source file under `app/` and `src/` — tests excluded, since
 *  a test is allowed to render the modal however it likes. */
function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!CODE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  for (const dir of SCANNED_DIRS) walk(path.join(ROOT, dir));
  return out;
}

/** Repo-relative, forward-slashed, so the expectations below read the same on
 *  every platform. */
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** Files containing a `<UpsellModal` JSX element, excluding the component's own
 *  two platform files (which declare it rather than render it). */
function renderersOfUpsellModal(): string[] {
  return productionFiles()
    .filter((f) => !/components[\\/]UpsellModal(\.native)?\.tsx$/.test(f))
    .filter((f) => /<UpsellModal[\s/>]/.test(fs.readFileSync(f, "utf8")))
    .map(rel)
    .sort();
}

/** The `<UpsellModal ... />` element bodies in one file. */
function upsellElements(relPath: string): string[] {
  const source = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  return [...source.matchAll(/<UpsellModal\b([\s\S]*?)\/>/g)].map((m) => m[1]);
}

/**
 * Every production renderer, and what supplies its `variant`.
 *
 * `BoardModals.tsx` is the one that does not call the hook itself: it is a
 * presentational fan-out of the board screen's modals and receives
 * `upsellVariant` as a prop, which `app/board/[id].tsx` fills from its own
 * `useUpsellCadence`. Listed explicitly so that exception stays deliberate.
 */
const EXPECTED_RENDERERS = {
  "app/(tabs)/index.tsx": "hook",
  "app/(tabs)/schedule.tsx": "hook",
  "app/session/[id].tsx": "hook",
  "app/session/create.tsx": "hook",
  "src/components/WorkspaceSwitcher.tsx": "hook",
  "src/components/board/BoardModals.tsx": "prop-from-board-screen",
} as const;

describe("upsell cadence — every production gate goes through the hook", () => {
  it("renders the upsell from exactly the call sites this file knows about", () => {
    // A new renderer has to be added here, which is the moment someone is asked
    // whether it supplies a variant. Without this, the checks below would
    // simply not see a seventh gate.
    expect(renderersOfUpsellModal()).toEqual(Object.keys(EXPECTED_RENDERERS).sort());
  });

  it.each(Object.keys(EXPECTED_RENDERERS))("%s supplies a variant to every UpsellModal it renders", (file) => {
    const elements = upsellElements(file);
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) {
      expect(element).toMatch(/\bvariant=\{/);
    }
  });

  it.each(
    Object.entries(EXPECTED_RENDERERS)
      .filter(([, source]) => source === "hook")
      .map(([file]) => file)
  )("%s resolves that variant from useUpsellCadence, not from a literal", (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    expect(source).toMatch(/useUpsellCadence\s*\(/);
    for (const element of upsellElements(file)) {
      // `variant="hard"` would satisfy the previous test while reinstating the
      // exact behaviour the cadence exists to replace.
      expect(element).not.toMatch(/\bvariant="/);
    }
  });

  it("BoardModals takes its variant as a prop, and the board screen fills it from the hook", () => {
    const boardModals = fs.readFileSync(
      path.join(ROOT, "src/components/board/BoardModals.tsx"),
      "utf8"
    );
    // The documented exception: presentational, so it must NOT own a cadence.
    expect(boardModals).not.toMatch(/useUpsellCadence\s*\(/);
    const boardScreen = fs.readFileSync(path.join(ROOT, "app/board/[id].tsx"), "utf8");
    expect(boardScreen).toMatch(/useUpsellCadence\s*\(/);
    expect(boardScreen).toMatch(/upsellVariant=\{upsell\.variant\}/);
  });

  it("the scanner actually finds elements and props — the control for the checks above", () => {
    // Every assertion here is of the form "the source matches X". A broken
    // regex or a wrong root would make the file lists empty and every `it.each`
    // above vacuous, so pin that the scan really resolves something.
    const renderers = renderersOfUpsellModal();
    expect(renderers.length).toBe(6);
    expect(upsellElements("src/components/WorkspaceSwitcher.tsx")).toHaveLength(1);
    // And that the element-body regex captures props rather than an empty
    // string: `resource` is on every one of them.
    for (const file of renderers) {
      for (const element of upsellElements(file)) {
        expect(element).toMatch(/\bresource=/);
      }
    }
  });
});
