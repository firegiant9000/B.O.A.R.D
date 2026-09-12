// Client mirror of functions/src/billing/limits.ts. Display + advisory pre-flight ONLY — never the enforcement point (see Global Constraints).

import { Plan } from "../types";

export const UNLIMITED = Number.POSITIVE_INFINITY;

export type LimitedResource =
  | "boards"
  | "sessionsPerPeriod"
  | "aiCallsPerPeriod"
  | "collaboratorsPerBoard"
  | "workspaces"
  | "boardQaPerPeriod";

export type PlanLimits = Record<LimitedResource, number>;

// Month 6 — `boardQaPerPeriod` is finite on every plan (unlike every other row
// here, where pro/edu are UNLIMITED). The reasoning for each number lives in
// functions/src/billing/limits.ts, the source of truth this file mirrors; it is
// deliberately NOT duplicated here, because a rationale that drifts is worse
// than one that lives in one place. This side is display + advisory copy only.
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
