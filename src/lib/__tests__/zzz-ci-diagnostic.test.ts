/* TEMPORARY CI DIAGNOSTIC — not part of the suite's contract. Removed before merge. */
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

const OPTS = {
  global: true,
  hasIndices: true,
  lazyCompileLength: 3e3,
  rules: {
    allowOrphanBackrefs: true,
    asciiWordBoundaries: true,
    captureGroup: true,
    recursionLimit: 5,
    singleline: true,
  },
  target: "auto" as const,
};

const SAMPLE = "SELECT id FROM users WHERE id = 1;";

describe("ci diagnostic", () => {
  it("dumps sql grammar pattern behaviour", () => {
    log("platform", `${process.platform} node ${process.version} v8 ${process.versions.v8}`);

    // 1. Order-dependence: sql alone, then sql after another grammar.
    log("sqlFirst", probe(() => tokenizeCode(SAMPLE, "sql").map((l) => l.length)));
    log("tsThen", probe(() => tokenizeCode("const total: number = 1;", "ts").map((l) => l.length)));
    log("sqlAfterTs", probe(() => tokenizeCode(SAMPLE, "sql").map((l) => l.length)));
    log("sqlTokensNow", probe(() => tokenizeCode(SAMPLE, "sql")));

    // 2. Walk every pattern in the grammar; convert each exactly as the engine does.
    const grammars = (Array.isArray(sqlLang) ? sqlLang : [sqlLang]) as unknown as Array<Record<string, unknown>>;
    const g = grammars[0] ?? {};
    const pats: string[] = [];
    const walk = (o: unknown): void => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if ((k === "match" || k === "begin" || k === "end" || k === "while") && typeof v === "string") pats.push(v);
        else walk(v);
      }
    };
    walk(g);
    log("patternCount", pats.length);

    let lazy = 0;
    const failures: Array<{ len: number; err: string }> = [];
    for (const p of pats) {
      try {
        const re = toRegExp(p, OPTS);
        if (re.source.length >= 3000) lazy++;
      } catch (e) {
        failures.push({ len: p.length, err: (e as Error).message.slice(0, 140) });
      }
    }
    log("lazyCount", lazy);
    log("convertFailures", failures);

    // 3. The keyword pattern that should colour SELECT.
    const kw = pats.find((p) => p.includes("select") && p.includes("from"));
    log("kwRawLen", kw ? kw.length : "NOT FOUND");
    if (kw) {
      log("kw", probe(() => {
        const re = toRegExp(kw, OPTS);
        re.lastIndex = 0;
        const m = re.exec(SAMPLE);
        return { srcLen: re.source.length, flags: re.flags, match: m?.[0] ?? null, index: m?.index ?? null };
      }));
    }

    // 4. The single lazily-compiled pattern — does it match, and what?
    const big = pats.slice().sort((a, b) => b.length - a.length)[0];
    log("bigRawLen", big?.length);
    log("big", probe(() => {
      const re = toRegExp(big, OPTS);
      re.lastIndex = 0;
      const m = re.exec(SAMPLE);
      return { srcLen: re.source.length, flags: re.flags, match: m?.[0] ?? null, index: m?.index ?? null };
    }));

    expect(true).toBe(true);
  });
});
