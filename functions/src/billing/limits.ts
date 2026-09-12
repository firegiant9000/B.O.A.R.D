export type Plan = "free" | "pro" | "edu";

export const UNLIMITED = Number.POSITIVE_INFINITY;

export type LimitedResource =
  | "boards"
  | "sessionsPerPeriod"
  | "aiCallsPerPeriod"
  | "collaboratorsPerBoard"
  | "workspaces"
  | "boardQaPerPeriod";

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
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    boards: 5,
    sessionsPerPeriod: 3,
    aiCallsPerPeriod: 5,
    collaboratorsPerBoard: 4,
    workspaces: 1,
    boardQaPerPeriod: 3,
  },
  pro: {
    boards: UNLIMITED,
    sessionsPerPeriod: UNLIMITED,
    aiCallsPerPeriod: UNLIMITED,
    collaboratorsPerBoard: 25,
    workspaces: UNLIMITED,
    boardQaPerPeriod: 200,
  },
  edu: {
    boards: UNLIMITED,
    sessionsPerPeriod: UNLIMITED,
    aiCallsPerPeriod: UNLIMITED,
    collaboratorsPerBoard: 100,
    workspaces: UNLIMITED,
    boardQaPerPeriod: 100,
  },
};

/** Limit for a plan+resource. An unrecognized plan falls back to `free` so a
 *  corrupt or future plan value fails closed rather than granting everything. */
export function limitFor(plan: Plan, resource: LimitedResource): number {
  return (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free)[resource];
}
