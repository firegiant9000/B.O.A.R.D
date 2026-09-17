import * as fs from "fs";
import * as path from "path";

/**
 * Import-graph guard for the code-element module split.
 *
 * `lib/codeRender.ts` statically imports `shiki/core`, nine `@shikijs/langs/*`
 * grammars and a theme, and `shiki/core` is a pre-built file that also carries
 * Shiki's HTML/HAST serialization stack — roughly two dozen packages that come
 * along whether or not a caller tokenizes. Three modules used to pay that for
 * nothing: `CodeComposer` (a language dropdown), `codeService` (persisting a
 * snippet and its box) and `useBoardElements` (a resize re-layout). The
 * measured symptom was `CodeComposerHost`/`MathComposerHost` timing out on a
 * cold-cache `jest --coverage` run; the same load lands on an Android cold
 * start.
 *
 * `lib/codeLayout.ts` is the dependency-free leaf they import instead. A
 * comment cannot keep that true — one `import { tokenizeCode } from
 * "./codeRender"` added anywhere in their subgraph silently restores the cost,
 * and nothing about the app's behaviour would change. So it is asserted.
 *
 * A STATIC walk, not a runtime `require`: the point is what the BUNDLER pulls
 * in, which is decided by static import syntax. A runtime probe would also be
 * at the mercy of Jest's module registry and of whatever the mocks in a given
 * suite happen to replace.
 */

const SRC = path.resolve(__dirname, "..", "..");
const ROOT = path.resolve(SRC, "..");
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** Every specifier in `source`, from static `import`/`export ... from` forms.
 *  `import type` is included rather than filtered out: it erases at build
 *  time, so counting it can only make this guard STRICTER than the bundle
 *  really is — a false alarm, never a false pass. */
function specifiersIn(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.push(m[1]);
  // Bare side-effect imports (`import "./x";`) carry the same cost.
  const bare = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = bare.exec(source))) out.push(m[1]);
  return out;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => path.join(base, "index" + e))]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Bare (non-relative) specifiers reachable from `entry` through first-party
 *  files only. Third-party packages are recorded, never walked — their own
 *  dependencies are not what this guard is about. */
function externalDepsFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [path.resolve(ROOT, entry)];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const spec of specifiersIn(source)) {
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(file, spec);
        // An unresolvable relative import would silently shrink the graph and
        // make this whole guard vacuous, so it fails loudly instead.
        if (!resolved) throw new Error(`Unresolvable import "${spec}" from ${file}`);
        queue.push(resolved);
      } else {
        external.add(spec);
      }
    }
  }
  return external;
}

const isShiki = (spec: string) => spec === "shiki" || spec.startsWith("shiki/") || spec.startsWith("@shikijs/");

describe("code elements — the tokenizer stays out of the modules that never tokenize", () => {
  it.each([
    ["src/components/board/CodeComposer.tsx"],
    ["src/services/codeService.ts"],
    ["src/hooks/useBoardElements.ts"],
    ["src/lib/codeLayout.ts"],
  ])("%s reaches no shiki package", (entry) => {
    const offenders = [...externalDepsFrom(entry)].filter(isShiki);
    expect(offenders).toEqual([]);
  });

  it("positive control — the walker DOES find shiki from the renderer that really imports it", () => {
    // Without this, a walker that resolved nothing (a broken regex, a wrong
    // root) would report every entry above as clean and the guard would be
    // worthless.
    const offenders = [...externalDepsFrom("src/lib/codeRender.ts")].filter(isShiki);
    expect(offenders).toContain("shiki/core");
    expect(offenders.length).toBeGreaterThan(1);
  });

  it("positive control — the walker crosses first-party files, not just the entry", () => {
    // `codeService.ts` imports firebase/firestore only via its own first line,
    // but `useBoardElements.ts` reaches react-native through several hops.
    // Seeing a dependency that only exists deeper in the graph proves the walk
    // is transitive rather than one level deep.
    expect(externalDepsFrom("src/services/codeService.ts")).toContain("firebase/firestore");
    expect(externalDepsFrom("src/components/board/CodeComposer.tsx").size).toBeGreaterThan(1);
  });

  it("codeLayout imports nothing but a type, which is what makes it a leaf", () => {
    const deps = externalDepsFrom("src/lib/codeLayout.ts");
    // `src/types` pulls in `lib/viewport` and `lib/laser`, both pure — so the
    // whole subgraph has no runtime package behind it at all.
    expect([...deps]).toEqual([]);
  });
});
