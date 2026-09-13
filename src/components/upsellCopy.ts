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
 * Every subject this modal can explain a denial for. `QuotaResource`
 * (board/session/aiSummary/aiCall) are the countable quotas mirrored in
 * `src/lib/planLimits.ts` (itself byte-mirrored against
 * `functions/src/billing/limits.ts`, guarded by planLimits.test.ts).
 * `"customPalette"` (Month 5, ROADMAP items 12 + 14) is deliberately NOT one
 * of those: it's a boolean Pro feature-gate (the per-workspace custom colour
 * swatch palette — see `workspaceService.ts#canUseCustomPalette`), not a
 * countable quota, and nothing server-side enforces it at all. Adding it to
 * `LimitedResource`/`PLAN_LIMITS` instead of here would force a matching
 * (and equally fictitious) entry into the FUNCTIONS-side table just to keep
 * that mirror test green — corrupting a real enforcement mirror for a
 * feature with no server enforcement at all. Handled here instead, as a
 * sibling type `isPlanCapped`/`limitMessage` special-case before ever
 * touching `RESOURCE_TO_LIMIT`/`limitFor`.
 *
 * `"boardQa"` (Month 6) is a sibling for a different reason. It IS a countable
 * quota with a real mirrored row (`boardQaPerPeriod`) and a real server-side
 * gate — but it is not a `QuotaResource`, because that type is the set of
 * resources `quotaService`'s ADVISORY PRE-FLIGHT can predict, and this one it
 * cannot: the count lives in the period usage doc's `byFeature` map, which most
 * board members cannot read. There is no pre-flight for board Q&A at all; the
 * panel simply asks and handles the server's answer. It also breaks the
 * assumption `unlockPhrase` is built on — `boardQaPerPeriod` is FINITE on every
 * plan, so "unlimited" would be a false claim about what upgrading buys.
 *
 * `"presenter"` (Fix Wave F2) is `"customPalette"`'s exact shape: a boolean
 * Pro feature-gate (`workspaceService.ts#canUsePresenter`) with no server-side
 * enforcement at all, not a countable quota — ROADMAP.md:615's third named
 * Pro affordance, gated here the same way the other two already were.
 */
export type UpsellResource = QuotaResource | "customPalette" | "boardQa" | "presenter";

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
  resource: UpsellResource;
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

export const RESOURCE_LABEL: Record<UpsellResource, string> = {
  board: "boards",
  session: "sessions per month",
  aiSummary: "AI calls per month",
  aiCall: "AI calls per month",
  customPalette: "custom colour swatches",
  boardQa: "board questions per month",
  presenter: "presenter mode",
};

/** The plan row board Q&A is capped by. Named here rather than inlined at the
 *  three use sites below so the copy and the gate cannot drift onto different
 *  rows — the functions-side callable reads this same key. */
const BOARD_QA_LIMIT = "boardQaPerPeriod" as const;

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
 *
 * `"customPalette"` special-cases ahead of the `RESOURCE_TO_LIMIT` lookup
 * (which has no entry for it — see `UpsellResource`'s own header): it's
 * "capped" on free (there IS a real Pro feature to sell) and never capped on
 * pro/edu (nothing to upsell to a plan that already has it), the same
 * free-vs-not shape `canUseCustomPalette` uses. `"presenter"` (Fix Wave F2)
 * is the identical shape, mirroring `canUsePresenter`.
 */
export function isPlanCapped(plan: Plan, resource: UpsellResource): boolean {
  if (resource === "customPalette" || resource === "presenter") return plan === "free";
  // Board Q&A is capped on EVERY plan (the one row in the limits table that is
  // finite everywhere), so this is always true for it — but it is read from the
  // table rather than hardcoded `true`, so a future decision to uncap a tier
  // changes the copy along with the limit instead of leaving a paywall claim
  // standing for a plan that no longer has a cap.
  if (resource === "boardQa") return limitFor(plan, BOARD_QA_LIMIT) !== UNLIMITED;
  return limitFor(plan, RESOURCE_TO_LIMIT[resource]) !== UNLIMITED;
}

/** Names the plan's limit for `resource` — only meaningful when `isPlanCapped`. */
export function limitMessage(resource: UpsellResource, plan: Plan): string {
  if (resource === "customPalette") {
    return "Custom colour swatches are a Pro feature.";
  }
  if (resource === "presenter") {
    return "Presenter mode is a Pro feature.";
  }
  if (resource === "boardQa") {
    return `You've reached the ${plan} plan's limit of ${limitFor(
      plan,
      BOARD_QA_LIMIT
    )} ${RESOURCE_LABEL.boardQa}.`;
  }
  const limit = limitFor(plan, RESOURCE_TO_LIMIT[resource]);
  return `You've reached the ${plan} plan's limit of ${limit} ${RESOURCE_LABEL[resource]}.`;
}

/** Shown instead of the paywall when the denial can't be a plan cap (see
 *  `isPlanCapped`) — a transient request-rate throttle, not a plan limit. */
export const THROTTLE_MESSAGE =
  "You're sending requests a little fast. Wait a few seconds and try again.";

/**
 * The web-only "upgrading unlocks ___" line (UpsellModal.tsx, next to the
 * figure that module imports separately — never named here; see this
 * file's own header on why nothing in this module may name a cost figure).
 * For a genuine `QuotaResource`, Pro/Edu really do grant an unlimited allowance
 * (see `isPlanCapped`'s own header), so "unlimited {label}" is a true claim.
 * `"customPalette"` is NOT unlimited on Pro — `workspaceService.ts`'s
 * `MAX_WORKSPACE_SWATCHES` caps the swatch row the same way on every plan;
 * what Pro actually unlocks is being able to add to it at all. Saying
 * "unlocks unlimited custom colour swatches" here would overstate that, so
 * this resource gets its own accurate phrase instead of the generic template.
 */
export function unlockPhrase(resource: UpsellResource): string {
  if (resource === "customPalette") return "the custom colour swatch palette";
  if (resource === "presenter") return "presenter mode";
  // `"boardQa"` is capped on Pro too — generously, but really — so the generic
  // "unlimited …" template would be a false claim about what upgrading buys.
  // Upgrading buys a much bigger allowance, and that is what this says.
  if (resource === "boardQa") return `a far larger monthly allowance of ${RESOURCE_LABEL.boardQa}`;
  return `unlimited ${RESOURCE_LABEL[resource]}`;
}
