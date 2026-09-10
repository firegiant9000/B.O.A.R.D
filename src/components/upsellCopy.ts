import { limitFor, UNLIMITED } from "../lib/planLimits";
import { RESOURCE_TO_LIMIT, type QuotaResource } from "../services/quotaService";
import type { Plan } from "../types";

// Shared, figure-free copy for the plan-limit upsell — imported by both
// UpsellModal.tsx (web) and UpsellModal.native.tsx (iOS/Android) so the
// native variant never needs to duplicate limit-naming logic, and never
// needs to import anything that could carry a cost figure or an off-app
// link. Nothing in this file may name a currency amount or a URL — guarded
// by this component's test file, which scans this file's source text the
// same way it scans UpsellModal.native.tsx's.

/**
 * The one props contract BOTH platform variants implement. `tsc` has no
 * platform-extension resolution of its own — every production import and
 * every test import type-checks against whichever file TypeScript happens to
 * resolve (in practice, always the bare `UpsellModal.tsx`, never
 * `UpsellModal.native.tsx`), while Metro/RN loads the actual native file at
 * runtime. Two independently-declared prop interfaces would let the native
 * variant's shape drift (e.g. silently dropping `plan`) without `tsc` ever
 * seeing it — only a device would. Exported from here (not from either
 * component file) specifically because this module has no runtime code the
 * native bundle needs to avoid; a type-only import erases at build time
 * regardless of which file imports it.
 */
export interface UpsellModalProps {
  visible: boolean;
  resource: QuotaResource;
  onDismiss: () => void;
  /** The workspace's actual plan. Determines whether this resource can even
   *  be plan-capped (see `isPlanCapped` below) — falls back to "free" when
   *  omitted. */
  plan?: Plan;
  /** Needed by the web variant to actually place its billing-service calls;
   *  unused by the native variant. Present on both so every call site can
   *  pass the same props to either platform's file without branching. */
  workspaceId?: string;
}

export const RESOURCE_LABEL: Record<QuotaResource, string> = {
  board: "boards",
  session: "sessions per month",
  aiSummary: "AI calls per month",
  aiCall: "AI calls per month",
};

/**
 * Whether `resource` even CAN be a plan-cap denial on `plan`. The four AI
 * callables throw the same `resource-exhausted` code for two different
 * reasons — the plan's AI-call cap, and a per-workspace request-rate
 * throttle that applies regardless of plan — and the server attaches no
 * `details` to tell them apart (functions/src/ai/usage.ts#checkAiQuota).
 * When `plan` already grants `resource` an unlimited allowance (Pro/Edu, for
 * every resource this modal covers), the denial arithmetically CANNOT be a
 * plan cap (`used < Infinity` is always true) — so it must be the throttle.
 * This is what stops a paying customer who briefly sent requests too fast
 * from being shown a paywall for a plan they already have.
 */
export function isPlanCapped(plan: Plan, resource: QuotaResource): boolean {
  return limitFor(plan, RESOURCE_TO_LIMIT[resource]) !== UNLIMITED;
}

/** Names the plan's limit for `resource` — only meaningful when `isPlanCapped`. */
export function limitMessage(resource: QuotaResource, plan: Plan): string {
  const limit = limitFor(plan, RESOURCE_TO_LIMIT[resource]);
  return `You've reached the ${plan} plan's limit of ${limit} ${RESOURCE_LABEL[resource]}.`;
}

/** Shown instead of the paywall when the denial can't be a plan cap (see
 *  `isPlanCapped`) — a transient request-rate throttle, not a plan limit. */
export const THROTTLE_MESSAGE =
  "You're sending requests a little fast. Wait a few seconds and try again.";
