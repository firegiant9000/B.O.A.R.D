import * as fs from "fs";
import * as path from "path";
import { PLAN_LIMITS, limitFor, UNLIMITED, type Plan } from "../billing/limits";
import { DEFAULT_BUCKET } from "../ai/rateLimit";

describe("plan limits", () => {
  it("caps the free tier per the spec", () => {
    expect(limitFor("free", "boards")).toBe(5);
    expect(limitFor("free", "sessionsPerPeriod")).toBe(3);
    expect(limitFor("free", "aiCallsPerPeriod")).toBe(5);
    expect(limitFor("free", "collaboratorsPerBoard")).toBe(4);
    expect(limitFor("free", "workspaces")).toBe(1);
  });

  it("gives pro unlimited boards, sessions and AI but a seat cap", () => {
    expect(limitFor("pro", "boards")).toBe(UNLIMITED);
    expect(limitFor("pro", "sessionsPerPeriod")).toBe(UNLIMITED);
    expect(limitFor("pro", "aiCallsPerPeriod")).toBe(UNLIMITED);
    expect(limitFor("pro", "collaboratorsPerBoard")).toBe(25);
  });

  it("treats an unknown plan as free (fail closed)", () => {
    expect(limitFor("nonsense" as never, "boards")).toBe(5);
  });

  it("defines every resource for every plan", () => {
    for (const plan of ["free", "pro", "edu"] as const) {
      for (const r of [
        "boards",
        "sessionsPerPeriod",
        "aiCallsPerPeriod",
        "collaboratorsPerBoard",
        "workspaces",
        "boardQaPerPeriod",
        "embeddingsPerPeriod",
      ] as const) {
        expect(typeof PLAN_LIMITS[plan][r]).toBe("number");
      }
    }
  });
});

// Month 6 — board Q&A's own plan line. The retrieval callable
// (functions/src/callable/askBoard.ts) gates on this INSTEAD of leaning only
// on `aiCallsPerPeriod`, because chat fires as often as someone types while a
// summary fires once per session.
describe("board Q&A plan limit", () => {
  it("caps board Q&A on EVERY plan, including the two with unlimited AI", () => {
    // The property worth pinning is not the three numbers — it is that none of
    // them is UNLIMITED. `aiCallsPerPeriod` is unlimited on pro and edu, so a
    // future edit that "helpfully" made this row match its neighbours would
    // re-open exactly the unbounded-spend hole this row exists to close, and
    // would do it silently.
    for (const plan of ["free", "pro", "edu"] as const) {
      const limit = limitFor(plan, "boardQaPerPeriod");
      expect(Number.isFinite(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
  });

  it("keeps the free tier's Q&A cap strictly under its whole AI allowance", () => {
    // Q&A must not be able to consume a free workspace's entire monthly AI
    // budget: summaries, OCR, explain and diagram have to keep some of it.
    expect(limitFor("free", "boardQaPerPeriod")).toBeLessThan(
      limitFor("free", "aiCallsPerPeriod")
    );
  });

  it("treats an unknown plan's Q&A cap as the free one (fail closed)", () => {
    expect(limitFor("nonsense" as never, "boardQaPerPeriod")).toBe(
      limitFor("free", "boardQaPerPeriod")
    );
  });
});

// Month 6 — the write half's own plan line. The element-embedding trigger is
// AUTOMATED spend: it fires on writes with nobody present, so until this row
// existed its only ceiling was the shared rate bucket (~2,880 embeds per
// workspace per day), which is a throttle rather than a cost bound.
describe("embeddings plan limit", () => {
  it("caps automated embedding spend on EVERY plan", () => {
    for (const plan of ["free", "pro", "edu"] as const) {
      const limit = limitFor(plan, "embeddingsPerPeriod");
      expect(Number.isFinite(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
  });

  it("is far looser than the interactive caps — a denial here is SILENT", () => {
    // An embed denied by this cap is not an error anyone sees: the trigger
    // skips and logs, and the index goes stale while board Q&A keeps answering
    // from content that no longer matches the board. A cap that bit during
    // ordinary editing would be worse than no cap, so this row must stay orders
    // of magnitude above the per-question one, not merely above it.
    for (const plan of ["free", "pro", "edu"] as const) {
      expect(limitFor(plan, "embeddingsPerPeriod")).toBeGreaterThan(
        limitFor(plan, "boardQaPerPeriod") * 50
      );
    }
  });

  it("stays BELOW what the shared rate bucket alone already permits", () => {
    // Without a ceiling the looseness test above passes at 10,000,000, at which
    // point this row is not a cost bound at all — it is a number that never
    // fires, and the only real limit is the bucket it was added to improve on.
    // Derived from DEFAULT_BUCKET rather than hardcoded, so it tracks the
    // bucket instead of quietly going stale if the bucket is ever retuned.
    const bucketPerMonth = DEFAULT_BUCKET.refillPerSec * 60 * 60 * 24 * 30;
    expect(bucketPerMonth).toBeGreaterThan(0); // guard: a real derived figure
    for (const plan of ["free", "pro", "edu"] as const) {
      expect(limitFor(plan, "embeddingsPerPeriod")).toBeLessThan(bucketPerMonth);
    }
  });

  it("gives the paid plans more headroom than free, which is board-capped anyway", () => {
    expect(limitFor("pro", "embeddingsPerPeriod")).toBeGreaterThan(
      limitFor("free", "embeddingsPerPeriod")
    );
    expect(limitFor("edu", "embeddingsPerPeriod")).toBeGreaterThan(
      limitFor("free", "embeddingsPerPeriod")
    );
  });

  it("treats an unknown plan's embedding cap as the free one (fail closed)", () => {
    expect(limitFor("nonsense" as never, "embeddingsPerPeriod")).toBe(
      limitFor("free", "embeddingsPerPeriod")
    );
  });
});

// The collaborator cap is enforced in firestore.rules (the invite-code self-join
// path is a client `update`, so a callable could not gate it) and rules cannot
// import TypeScript. That leaves the three numbers duplicated in `seatCaps()`
// there, and this test is the only thing keeping the two honest. Same technique
// as src/lib/__tests__/planLimits.test.ts: parse the other file as text and
// compare in BOTH directions, with a guard that fails if the parse matched
// nothing — a drift test whose parse silently matches nothing passes forever.
describe("firestore.rules seat-cap mirror", () => {
  it("keeps seatCaps() in firestore.rules in sync with collaboratorsPerBoard", () => {
    const rulesPath = path.join(__dirname, "../../../firestore.rules");
    const rules = fs.readFileSync(rulesPath, "utf8");

    // Isolate the seatCaps() body so a number elsewhere in the file can't satisfy
    // the comparison by accident.
    const fnStart = rules.indexOf("function seatCaps()");
    expect(fnStart).toBeGreaterThanOrEqual(0); // guard: the helper must still exist
    const fnEnd = rules.indexOf("}", rules.indexOf("return", fnStart));
    expect(fnEnd).toBeGreaterThan(fnStart); // guard: we actually captured a body
    const body = rules.slice(fnStart, fnEnd);

    // Parse the `'plan': number` map entries out of the rules source.
    const parsed: Record<string, number> = {};
    for (const m of body.matchAll(/'(\w+)'\s*:\s*(\d+)/g)) {
      parsed[m[1]] = Number(m[2]);
    }

    // Guard + first direction: every plan in the limits table appears in the
    // rules, and the rules define no plan the table doesn't. An empty parse
    // fails here rather than passing vacuously.
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(PLAN_LIMITS).sort());

    // Second direction: the numbers agree, plan by plan.
    for (const plan of Object.keys(parsed) as Plan[]) {
      expect(parsed[plan]).toBe(PLAN_LIMITS[plan].collaboratorsPerBoard);
    }
  });
});
