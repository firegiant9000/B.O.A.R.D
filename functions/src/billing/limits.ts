export type Plan = "free" | "pro" | "edu";

export const UNLIMITED = Number.POSITIVE_INFINITY;

export type LimitedResource =
  | "boards"
  | "sessionsPerPeriod"
  | "aiCallsPerPeriod"
  | "collaboratorsPerBoard"
  | "workspaces"
  | "boardQaPerPeriod"
  | "embeddingsPerPeriod";

export type PlanLimits = Record<LimitedResource, number>;

// Source of truth for every gate. `src/lib/planLimits.ts` mirrors this exactly;
// the mirror test in both suites fails if they drift.
//
// Month 6 — `boardQaPerPeriod` is the first row here that is FINITE on every
// plan, deliberately. Board Q&A is the one feature ROADMAP.md flags as
// "unbounded": a summary fires once per session, a question fires as often as
// someone types. `aiCallsPerPeriod` being UNLIMITED on pro/edu is a recorded
// cost exposure already; copying that shape into the feature most able to
// exploit it would compound it. The numbers come from ROADMAP.md's own cost
// model (Appendix B.6: free 5 AI calls/month, pro "100 calls/month soft-capped
// then $0.05/overage", edu "50 calls/student/month"):
//   - free 3   — strictly BELOW free's own `aiCallsPerPeriod: 5`, so Q&A can
//                never eat a free workspace's whole AI allowance and leave
//                summaries/OCR/explain/diagram with nothing.
//   - pro 200  — B.6's soft-cap-plus-overage does not exist as billing code, so
//                a hard cap is the only mechanism available. 200 questions is
//                ~4x B.6's whole-product Pro allowance for this one feature;
//                at gpt-4o-mini retrieval sizes that is cents per month, so it
//                bounds abuse without a real user ever feeling it.
//   - edu 100  — B.6 is per-STUDENT, and nothing in this codebase counts per
//                student (every counter is per-workspace), so a per-student
//                number cannot be expressed here. 100 per workspace is the
//                conservative reading rather than the generous one.
//
// `embeddingsPerPeriod` is the same idea applied to the write half — the
// element-embedding trigger — and it exists for a different reason from every
// other row. This is AUTOMATED spend: it fires on writes, with nobody present,
// so it has no human pacing it and until now its only ceiling was the shared
// rate bucket (~30 burst refilling 1 per 30s, i.e. roughly 2,880 embeds per
// workspace per DAY). That is a throttle, not a cost bound.
//
// The numbers are deliberately LOOSE, and that direction is the important one.
// An embed denied by this cap is not an error a user sees — the trigger skips
// and logs, and the index silently goes stale, so board Q&A would keep
// answering from content that no longer matches the board. A cap that bites
// during ordinary editing would be worse than no cap. These are sized to stop
// a runaway, not to ration real use:
//   - free 2,000   — a free workspace is capped at 5 boards, so this is ~400
//                    re-embeds per board per month, far past any real editing
//                    session. At ~250 tokens per element and $0.02/1M tokens
//                    (text-embedding-3-small), that ceiling is about $0.01.
//   - pro/edu 20,000 — 10x, since neither is capped on boards. About $0.10 at
//                    the same rates, and still an order of magnitude under what
//                    the rate bucket alone would have permitted.
// (Both dollar figures are UNDERSTATED for a comment-heavy workspace, and
// honestly so: this row counts CALLS, while the ~250-tokens-per-element
// assumption behind those figures is a canvas element's size. A comment thread
// is embedded whole on every reply, so a long discussion's later embeds carry
// far more tokens than a note does — bounded at the top by
// `MAX_EMBEDDING_INPUT_CHARS`, which caps any single embed at ~2,000 tokens,
// i.e. at most ~8x the assumed size. The ceilings stay cents either way, which
// is why this row counts calls rather than tokens; the arithmetic above is a
// floor, not a bound.)
// Finite on every plan for the same reason `boardQaPerPeriod` is: unbounded
// automated spend is exactly the thing with no natural stopping point.
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    boards: 5,
    sessionsPerPeriod: 3,
    aiCallsPerPeriod: 5,
    collaboratorsPerBoard: 4,
    workspaces: 1,
    boardQaPerPeriod: 3,
    embeddingsPerPeriod: 2000,
  },
  pro: {
    boards: UNLIMITED,
    sessionsPerPeriod: UNLIMITED,
    aiCallsPerPeriod: UNLIMITED,
    collaboratorsPerBoard: 25,
    workspaces: UNLIMITED,
    boardQaPerPeriod: 200,
    embeddingsPerPeriod: 20000,
  },
  edu: {
    boards: UNLIMITED,
    sessionsPerPeriod: UNLIMITED,
    aiCallsPerPeriod: UNLIMITED,
    collaboratorsPerBoard: 100,
    workspaces: UNLIMITED,
    boardQaPerPeriod: 100,
    embeddingsPerPeriod: 20000,
  },
};

/** Limit for a plan+resource. An unrecognized plan falls back to `free` so a
 *  corrupt or future plan value fails closed rather than granting everything. */
export function limitFor(plan: Plan, resource: LimitedResource): number {
  return (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free)[resource];
}
