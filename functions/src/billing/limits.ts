export type Plan = "free" | "pro" | "edu";

export const UNLIMITED = Number.POSITIVE_INFINITY;

export type LimitedResource =
  | "boards"
  | "sessionsPerPeriod"
  | "aiCallsPerPeriod"
  | "collaboratorsPerBoard"
  | "workspaces";

export type PlanLimits = Record<LimitedResource, number>;

// Source of truth for every gate. `src/lib/planLimits.ts` mirrors this exactly;
// the mirror test in both suites fails if they drift.
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    boards: 5,
    sessionsPerPeriod: 3,
    aiCallsPerPeriod: 5,
    collaboratorsPerBoard: 4,
    workspaces: 1,
  },
  pro: {
    boards: UNLIMITED,
    sessionsPerPeriod: UNLIMITED,
    aiCallsPerPeriod: UNLIMITED,
    collaboratorsPerBoard: 25,
    workspaces: UNLIMITED,
  },
  edu: {
    boards: UNLIMITED,
    sessionsPerPeriod: UNLIMITED,
    aiCallsPerPeriod: UNLIMITED,
    collaboratorsPerBoard: 100,
    workspaces: UNLIMITED,
  },
};

/** Limit for a plan+resource. An unrecognized plan falls back to `free` so a
 *  corrupt or future plan value fails closed rather than granting everything. */
export function limitFor(plan: Plan, resource: LimitedResource): number {
  return (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free)[resource];
}
