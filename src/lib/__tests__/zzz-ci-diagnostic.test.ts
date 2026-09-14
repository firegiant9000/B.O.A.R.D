/* TEMPORARY CI DIAGNOSTIC — not part of the suite's contract.
 * Dumps the shiki/oniguruma-to-es environment and the SQL grammar's actual
 * tokenization so the Linux-only failure can be diagnosed. Removed before merge. */
import { toRegExp } from "oniguruma-to-es";
import sqlLang from "@shikijs/langs/sql";
import { tokenizeCode } from "../codeRender";

const log = (k: string, v: unknown) => console.error(`DIAGSQL|${k}|${JSON.stringify(v)}`);
const probe = (fn: () => unknown) => {
  try {
    return fn();
  } catch (e) {
    return "THREW: " + (e as Error).message;
  }
};

describe("ci diagnostic", () => {
  it("dumps sql tokenization environment", () => {
    log("node", process.version);
    log("v8", process.versions.v8);
    log("icu", (process.versions as Record<string, string>).unicode ?? "n/a");
    log("platform", `${process.platform}/${process.arch}`);

    log("flagGroups", probe(() => { new RegExp("(?i:)"); return true; }));
    log("unicodeSets", probe(() => { new RegExp("[[]]", "v"); return true; }));
    log("bugNestedClassIgnoresNegation", probe(() => new RegExp("[[^a]]", "v").test("a")));
    log("bugFlagVLiteralHyphenIsRange", probe(() => { new RegExp(String.raw`[\d\-a]`, "v"); return false; }));

    for (const p of ["shiki", "@shikijs/langs", "@shikijs/engine-javascript", "oniguruma-to-es", "oniguruma-parser", "regex"]) {
      log(
        "ver:" + p,
        probe(() => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const fs = require("fs");
          return JSON.parse(fs.readFileSync(`${process.cwd()}/node_modules/${p}/package.json`, "utf8")).version;
        })
      );
    }

    // What the real code produces.
    const toks = probe(() => tokenizeCode("SELECT id FROM users WHERE id = 1;", "sql"));
    log("tokens", toks);

    // The grammar's own keyword pattern, straight from the installed grammar.
    const grammars = (Array.isArray(sqlLang) ? sqlLang : [sqlLang]) as unknown as Array<Record<string, unknown>>;
    const g = grammars[0] ?? {};
    log("grammar.name", g.name);
    log("grammar.scopeName", g.scopeName);
    const raw = JSON.stringify(g);
    const found = raw.match(/\(\?i:\\\\b\(select[^"]{0,200}/);
    log("grammar.selectPattern", found ? found[0] : "NOT FOUND");

    // Convert the select keyword pattern exactly as the engine would.
    const PAT = String.raw`(?i:\b(select(\s+(all|distinct))?|insert\s+(ignore\s+)?into|update|delete|from)\b)`;
    log("convert", probe(() => {
      const re = toRegExp(PAT, {
        global: true,
        hasIndices: true,
        lazyCompileLength: 3e3,
        rules: { allowOrphanBackrefs: true, asciiWordBoundaries: true, captureGroup: true, recursionLimit: 5, singleline: true },
        target: "auto",
      });
      return { source: re.source, flags: re.flags, matchesUpper: re.test("SELECT id"), matchesLower: /x/.test("x") && new RegExp(re.source, re.flags).test("select id") };
    }));

    // Does a hand-built equivalent behave?
    log("nativeVI", probe(() => new RegExp(String.raw`\b(select|from)\b`, "dgiv").test("SELECT")));
    log("nativeUI", probe(() => new RegExp(String.raw`\b(select|from)\b`, "dgiu").test("SELECT")));
    log("nativePspaceVI", probe(() => new RegExp(String.raw`select\p{space}+id`, "dgiv").test("SELECT ID")));

    expect(true).toBe(true);
  });
});
