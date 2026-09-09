# Months 5–6: Monetization + Growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the product from "code-complete but unmonetized" to "charges money, is measured, and has launched" — by making plan limits enforceable server-side, wiring Stripe, and shipping the growth surfaces that produce an attributable go/no-go number.

**Architecture:** Everything that gates value moves behind Cloud Functions and Firestore rules; the client keeps only advisory pre-flight checks. New AI features ride the existing M4 gateway (provider adapter → rate-limit bucket → quota gate → `recordAiUsage`) rather than adding infrastructure. New canvas element kinds render as native `react-native-svg` nodes — never WebViews — so they inherit selection, transform, export and print for free.

**Tech Stack:** Expo SDK 55 / React Native 0.83 / React 19.2, `expo-router`, `react-native-svg` 15.15.3, Firebase (Firestore, Auth, Storage), Cloud Functions v2 (Node 20, TypeScript), Jest (`jest-expo`) + `@firebase/rules-unit-testing`, Stripe.

**Spec:** [`ROADMAP.md`](../../../ROADMAP.md) § Month 5 and § Month 6 (as revised 2026-09-01), with the investigation and rationale in [`docs/month-5-phases.md`](../../month-5-phases.md) and [`docs/month-6-phases.md`](../../month-6-phases.md). **Those three documents are the binding authority; this plan is their executable form.** Where this plan and the spec disagree, the spec wins and the controller records a ruling.

---

## Global Constraints

Every task's requirements implicitly include this section. Copy it verbatim into every reviewer dispatch.

**Platform / versions**
- Expo SDK `~55.0.8`, React `19.2.0`, React Native `0.83.2`, `react-native-svg` `15.15.3`. Cloud Functions v2, Node 20, region `us-central1`, `maxInstances: 10`.
- `expo-av` does **not** exist in SDK 55. Audio uses `expo-audio`.

**Security — non-negotiable**
- **A limit that only the client checks is not enforced.** Every plan limit must be denied by `firestore.rules` or by a Cloud Function. UI checks are advisory only and must be commented as such.
- Secrets live only in the Functions runtime via `defineSecret`. **Anything named `EXPO_PUBLIC_*` is inlined into the client bundle and is public** — never put a secret there.
- Client writes to metering, billing and embedding collections are always `allow write: if false`. Functions write them via the Admin SDK, which bypasses rules.
- Never log or transmit user identifiers into analytics. Hashed workspace id + role only.

**Data model**
- Every **new** element type carries `schemaVersion: 1`. Precedent: `EMBED_TOKEN_VERSION` in `functions/src/embed/token.ts` with its explicit `bad-version` rejection path.
- Readers tolerate missing fields (`data?.field ?? default`) so a partially-written or older-shape doc never throws. Precedent: `mapUsageDoc` in `src/services/aiUsageService.ts`.
- Monthly buckets are UTC year-month (`"2026-09"`) and **must** come from the single existing implementation, `currentPeriod()` in `functions/src/ai/usage.ts`. Never reimplement it.

**Architecture**
- UI components call a service in `src/services/`; they never call Firestore, Storage, `fetch`, or a callable directly.
- Cloud Function handlers split into a pure, injectable `handleX(req, deps, now)` plus a thin `onCall` binding. Precedent: `handleGenerateSummary` / `generateSummary` in `functions/src/callable/generateSummary.ts`. **Every new callable follows this shape** so it unit-tests without the Functions runtime.
- New canvas content renders as `react-native-svg` nodes. **No WebViews on the canvas.**

**Testing**
- App: Jest with the `jest-expo` preset, `@testing-library/react-native`. Functions: Jest with `ts-jest`. Rules: `@firebase/rules-unit-testing` under `firestore-tests/`.
- Coverage gate: 60% global lines/statements over `src/services/**` (`npm run test:coverage`). Do not lower it.
- **Baseline that must never regress:** `npx tsc --noEmit` clean; app 44 suites / 512 tests; `functions` 10 suites / 109 tests; `test:rules` 2 suites / 83 tests. Every task adds to these numbers and breaks none of them.
- Never write a test that asserts nothing. Never assert on a mock's own return value as if it were behaviour.

**Dependencies** — these are the *only* new packages approved by this plan. Anything else requires asking first:
`stripe` (functions only), `expo-audio`, `posthog-js`, `posthog-react-native`, `mathjax-full` (functions only), `shiki`.

**Style / process**
- 2-space indent for TS/JS/JSON. Follow the surrounding file's conventions.
- Commit per task with a conventional-commit subject. **Never add Claude attribution** — no `Co-Authored-By: Claude` trailer, no "Generated with Claude Code" line.
- Do not regenerate `package-lock.json` beyond what installing an approved dependency does.

---

## Human Gates — work no subagent can do

These are **out-of-band prerequisites**. A subagent cannot enable billing, create a Stripe account, submit to a marketplace, or hold a phone. The controller must confirm each gate before dispatching the tasks it blocks, and should **park the blocked task and continue with unblocked tracks** rather than stalling the run.

| Gate | What the human must do | Blocks |
|---|---|---|
| **G1 — Month 4 closed** | Blaze enabled with spend caps set; `functions/` deployed; the four `EXPO_PUBLIC_AI_*` flags flipped and verified; legacy client OpenAI key path removed. | Everything. This plan assumes a deployed `functions/`. |
| **G2 — M3 migration cut over** | Run `npm run migrate:workspaces` on staging, soak one week, cut over prod. | Task 7 (removing the legacy no-`workspaceId` rules fallback is safer after this; the task tolerates it either way). |
| **G3 — Stripe account** | Create the account, create the Pro product + monthly price, note the price ID, set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` via `firebase functions:secrets:set`, register the webhook endpoint after first deploy. | Tasks 8–10 |
| **G4 — Pricing confirmed** | Confirm $5/user/month against real measured AI cost-per-session from the M4 meter. The number in this plan is a placeholder for a decision, not a decision. | Task 2's `PRO` limits are structural and unblocked; only the displayed price in Task 13 waits. |
| **G5 — PostHog project** | Create the project, note the public API key, set `EXPO_PUBLIC_POSTHOG_KEY` and `EXPO_PUBLIC_POSTHOG_HOST`. | Task 21 |
| **G6 — Marketplace submissions** | Google Workspace Marketplace (Meet add-on) and Chrome Web Store developer account ($5). **Submit in week 1** — review queues run days to weeks. | Ship of Tasks 20 and 33; not their implementation. |
| **G7 — Android device** | A real mid-range Android on the desk for the parity + perf gates. | Final verification, not any single task. |
| **G8 — Non-code launch work** | Instructor outreach, three blog posts, launch-day coordination. | Nothing in this plan. Tracked in the spec, deliberately out of scope here. |

**Explicitly not in this plan** (spec items with no code deliverable): ROADMAP M6 A5 outreach, A7 content and launch, and the M6 decision itself.

---

## File Structure

**New — Cloud Functions**
| File | Responsibility |
|---|---|
| `functions/src/billing/limits.ts` | The plan-limits table. Mirrored by `src/lib/planLimits.ts`; one is generated from the other's shape by test, never by hand-sync. |
| `functions/src/billing/usage.ts` | Session-count bucket + board `count()`; pure math split out. |
| `functions/src/billing/stripe.ts` | Stripe client construction + event handlers, provider-free and unit-testable. |
| `functions/src/callable/createBoard.ts` | Board create, quota-gated, transactional. |
| `functions/src/callable/createSession.ts` | Session create, quota-gated, transactional with the counter. |
| `functions/src/callable/createCheckoutSession.ts` | Stripe Checkout session mint. |
| `functions/src/callable/createPortalSession.ts` | Stripe Customer Portal session mint. |
| `functions/src/http/stripeWebhook.ts` | Raw-body HTTPS endpoint; idempotent on `event.id`. |
| `functions/src/callable/renderMath.ts` | LaTeX → SVG path data via `mathjax-full`, cached by hash. |
| `functions/src/callable/generateFlashcards.ts` | Selection → front/back pairs, cached by hash. |
| `functions/src/ai/embeddings.ts` | Per-element embedding write path. |
| `functions/src/callable/askBoard.ts` | `findNearest` retrieval + chat answer. |

**New — client**
| File | Responsibility |
|---|---|
| `src/lib/planLimits.ts` | Client-side mirror of the limits table (display + pre-flight only). |
| `src/services/billingService.ts` | Checkout / portal callable wrappers; subscription read. |
| `src/services/analyticsService.ts` | The single PostHog seam — vendor is one file. |
| `src/services/templateService.ts` | Template catalogue load + instantiate-to-board. |
| `src/services/pollService.ts`, `src/services/reactionService.ts` | Poll and reaction persistence. |
| `src/services/flashcardService.ts`, `src/services/boardQaService.ts` | M6b AI surfaces. |
| `src/lib/sm2.ts` | SuperMemo SM-2 scheduling — pure, no I/O. |
| `src/lib/svgExport.ts` | Element union → SVG document string. Pure. |
| `src/lib/pdfTiling.ts` | Board bounds → page grid. Pure. |
| `src/components/UpsellModal.tsx` | Two platform variants (see Global Constraints). |
| `src/templates/*.json` | 20 template board exports. Data, not code. |

**Modified (hot spots)**
- `app/board/[id].tsx` — **decomposed in Task 1 before anything else touches it.**
- `firestore.rules` — Tasks 3, 7, 19, 25, 26, 31.
- `src/services/quotaService.ts` — demoted to advisory in Task 4.
- `app/ai-usage.tsx` — extended in Task 12.

---

## Task Map

**Dependency-ordered. `∥` marks tasks that can be dispatched in any order relative to each other** once their dependencies are met — but never dispatch two implementers simultaneously (file conflicts).

| # | Task | Depends on | Model tier | Gate |
|---|---|---|---|---|
| 1 | Board screen decomposition | — | **most capable** | |
| 2 | Plan limits table | — | cheap | |
| 3 | Usage counters + rules lock | 2 | standard | |
| 4 | Real `checkQuota` (AI + advisory client) | 2, 3 | standard | |
| 5 | `createBoard` callable | 2, 3 | standard | |
| 6 | `createSession` callable | 2, 3 | standard | |
| 7 | Rules: deny client creates + seat cap | 5, 6 | **most capable** | G2 |
| 8 | Stripe checkout callable | 2 | standard | G3 |
| 9 | Stripe webhook (idempotent) | 8 | **most capable** | G3 |
| 10 | Stripe portal + `billingService` | 9 | standard | G3 |
| 11 | Upsell surfaces (2 platform variants) | 2, 10 | standard | |
| 12 | Usage dashboard | 3, 10 | cheap | |
| 13 | Pricing page (web) | 10 | cheap | G4 |
| 14 ∥ | Presenter mode | 1 | standard | |
| 15 ∥ | Laser pointer | 14 | cheap | |
| 16 ∥ | Voice notes | 1 | standard | |
| 17 ∥ | Colour/stroke polish + eyedropper | 1 | standard | |
| 18 ∥ | Onboarding tutorial + empty states | 1 | standard | |
| 19 | Editable embed token (v2 + identity) | — | **most capable** | |
| 20 | Google Meet add-on shell | 19 | standard | G6 |
| 21 | Analytics seam + taxonomy | — | standard | G5 |
| 22 ∥ | Template library + gallery | 1 | standard | |
| 23 ∥ | SVG export serializer | — | standard | |
| 24 ∥ | PNG/PDF export + tiling | 23 | standard | |
| 25 ∥ | Reactions | 1 | standard | |
| 26 ∥ | Polls + quiz mode | 25 | standard | |
| 27 | Education: invite-based enrollment + grid | 7 | standard | |
| 28 | Sample workspace seeding | 22 | cheap | |
| 29 | SM-2 scheduling library | — | cheap | |
| 30 | Flashcard generation + review surface | 29 | standard | |
| 31 | Board Q&A: embedding write path | — | standard | |
| 32 | Board Q&A: retrieval + chat | 31, 4 | **most capable** | |
| 33 | Browser extension | 19 | standard | G6 |
| 34 | Camera capture + OCR | 1 | cheap | |
| 35 | Math elements (MathJax → SVG) | 1 | **most capable** | |
| 36 | Code elements (Shiki tokenizer) | 1 | standard | |
| 37 | Sticky-note polish | 1 | cheap | |

**Critical path:** 1 → 2 → 3 → {5, 6} → 7, and 8 → 9 → 10 → 11. Task 1 gates every task that touches the board screen (14–18, 22, 25, 34–37), so it goes first and merges before anything branches off it. Tasks 19, 21, 23, 29, 31 have **no dependencies** and are the natural fillers whenever a human gate parks the monetization spine.

**Batching note for the controller:** Tasks 22 (20 template JSON files) and 37 are same-shape mechanical work. Compose one dispatch each rather than splitting further.

---

# TRACK 0 — Foundation

### Task 1: Board screen decomposition

**Files:**
- Modify: `app/board/[id].tsx` (3,894 lines → target < 600)
- Create: `src/hooks/useBoardElements.ts`
- Create: `src/hooks/useBoardTools.ts`
- Create: `src/hooks/useBoardCollab.ts`
- Create: `src/hooks/useBoardAI.ts`
- Create: `src/hooks/useBoardComments.ts`
- Create: `src/components/board/` (extracted overlay layers)

**Interfaces:**
- Consumes: nothing.
- Produces: five hooks that Tasks 14–18, 22, 25, 26, 34–37 extend rather than re-open the screen file. Each returns a plain object; **no hook takes another hook's return value as a parameter** — the screen composes them.

**This is a pure refactor. Behaviour must not change.** The gate is mechanical: the existing 512 tests must pass **with zero edits to any test file**. If a test needs changing, the extraction changed behaviour — revert that seam and redo it.

- [ ] **Step 1: Record the baseline**

Run and save the output:
```bash
npx tsc --noEmit
npx jest --ci --silent
git rev-parse HEAD
```
Expected: tsc clean, `44 passed, 44 total` / `512 passed, 512 total`.

- [ ] **Step 2: Extract `useBoardElements`**

Move the element subscription, culling and spatial-index state out of the screen. The hook owns everything currently derived from `pathService.subscribeToBoardPaths`, `shapeService`, `imageService`, the culling call, and the `rbush` index.

```ts
// src/hooks/useBoardElements.ts
export interface BoardElements {
  paths: DrawPath[];
  shapes: ShapeElement[];
  texts: TextElement[];
  notes: TextNote[];
  images: ImageElement[];
  /** Viewport-culled subsets the canvas actually renders. */
  visible: {
    paths: DrawPath[];
    shapes: ShapeElement[];
    texts: TextElement[];
    notes: TextNote[];
    images: ImageElement[];
  };
  loading: boolean;
}

export function useBoardElements(boardId: string, viewport: Viewport): BoardElements {
  // Move the existing subscription + culling bodies here verbatim.
}
```

- [ ] **Step 3: Run the suite after the first extraction**

Run: `npx jest --ci --silent`
Expected: `512 passed`. **Zero test files modified** (`git status` shows no `__tests__` changes).

- [ ] **Step 4: Extract the remaining four hooks, running the suite after each**

Same pattern, one at a time, suite green between each:
- `useBoardTools(boardId)` → active tool, tool options, `useShortcuts` wiring.
- `useBoardCollab(boardId, user)` → presence, cursors, follow mode. Task 14 extends this one.
- `useBoardAI(boardId)` → the four flag-gated affordances (`AI_GATEWAY_ENABLED`, `OCR_ENABLED`, `EXPLAIN_ENABLED`, `DIAGRAM_ENABLED` from `src/lib/featureFlags.ts`).
- `useBoardComments(boardId)` → comment pins + thread panel state.

- [ ] **Step 5: Extract inlined overlay layers into `src/components/board/`**

Any JSX block in the screen longer than ~40 lines that renders a distinct layer becomes its own component file. Props only — no new context.

- [ ] **Step 6: Verify the gate**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx jest --ci --silent`
Expected: `44 passed, 44 total` / `512 passed, 512 total`.

Run: `git diff --stat -- "*__tests__*"`
Expected: **empty output.** Any output here fails the task.

Run: `node -e "console.log(require('fs').readFileSync('app/board/[id].tsx','utf8').split('\n').length)"`
Expected: a number under 600.

- [ ] **Step 7: Commit**

```bash
git add app/board src/hooks src/components/board
git commit -m "refactor(board): decompose board screen into focused hooks and layers"
```

---

# TRACK A — The monetization spine

### Task 2: Plan limits table

**Files:**
- Create: `functions/src/billing/limits.ts`
- Create: `src/lib/planLimits.ts`
- Create: `functions/src/__tests__/limits.test.ts`
- Create: `src/lib/__tests__/planLimits.test.ts`

**Interfaces:**
- Consumes: `Plan` from `src/types/index.ts` (`"free" | "pro" | "edu"`).
- Produces: `PLAN_LIMITS: Record<Plan, PlanLimits>` and `limitFor(plan, resource)`. **Tasks 3, 4, 5, 6, 7, 11, 12, 13, 32 all read these.** The two copies must stay identical; Step 3 is the test that enforces it.

`UNLIMITED` is `Number.POSITIVE_INFINITY` so every call site is a plain `<` comparison with no null-checking branch.

- [ ] **Step 1: Write the failing test (functions side)**

```ts
// functions/src/__tests__/limits.test.ts
import { PLAN_LIMITS, limitFor, UNLIMITED } from "../billing/limits";

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
      for (const r of ["boards", "sessionsPerPeriod", "aiCallsPerPeriod", "collaboratorsPerBoard", "workspaces"] as const) {
        expect(typeof PLAN_LIMITS[plan][r]).toBe("number");
      }
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm --prefix functions test -- limits.test.ts`
Expected: FAIL — `Cannot find module '../billing/limits'`.

- [ ] **Step 3: Implement the table**

```ts
// functions/src/billing/limits.ts
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
```

Create `src/lib/planLimits.ts` with **byte-identical** `PLAN_LIMITS`, `UNLIMITED`, `limitFor`, `LimitedResource` and `PlanLimits`, importing `Plan` from `../types` instead of redeclaring it. Add the header comment: `// Client mirror of functions/src/billing/limits.ts. Display + advisory pre-flight ONLY — never the enforcement point (see Global Constraints).`

- [ ] **Step 4: Add the anti-drift test on the client side**

```ts
// src/lib/__tests__/planLimits.test.ts
import * as fs from "fs";
import * as path from "path";
import { PLAN_LIMITS } from "../planLimits";

// The two tables are physically separate (one ships in the bundle, one in the
// function runtime) so this test is what keeps them honest.
describe("planLimits mirror", () => {
  it("matches the functions-side table value for value", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../../functions/src/billing/limits.ts"),
      "utf8"
    );
    for (const [plan, limits] of Object.entries(PLAN_LIMITS)) {
      for (const [resource, value] of Object.entries(limits)) {
        const expected = value === Number.POSITIVE_INFINITY ? "UNLIMITED" : String(value);
        const block = src.slice(src.indexOf(`${plan}: {`));
        const line = block.slice(0, block.indexOf("}")).split("\n")
          .find((l) => l.trim().startsWith(`${resource}:`));
        expect(line, `${plan}.${resource} missing in functions table`).toBeDefined();
        expect(line).toContain(expected);
      }
    }
  });
});
```

- [ ] **Step 5: Run both suites**

Run: `npm --prefix functions test -- limits.test.ts`
Expected: PASS, 4 tests.

Run: `npx jest src/lib/__tests__/planLimits.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add functions/src/billing/limits.ts src/lib/planLimits.ts functions/src/__tests__/limits.test.ts src/lib/__tests__/planLimits.test.ts
git commit -m "feat(billing): add plan limits table with anti-drift mirror test"
```

---

### Task 3: Usage counters + rules lock

**Files:**
- Create: `functions/src/billing/usage.ts`
- Create: `functions/src/__tests__/billingUsage.test.ts`
- Modify: `firestore.rules` (add the `usage` and `billing` subcollection rules)
- Modify: `firestore-tests/firestore.rules.test.js`

**Interfaces:**
- Consumes: `currentPeriod` from `functions/src/ai/usage.ts` — **import it, never reimplement** (Global Constraints).
- Produces: `countBoards(db, workspaceId)`, `readSessionCount(db, workspaceId, now)`, `incrementSessionCount(tx, db, workspaceId, now)`, `applySessionUsage(state, now)`. Tasks 5, 6 and 12 consume these.

**Design note the implementer must respect:** boards are a **stock** (5 alive at once, freed by deletion) so they use a live `count()` aggregation and have **no stored counter**. Sessions are a **flow** (3 per month) so they use a stored monthly bucket that only ever increments. Do not "simplify" these into the same mechanism — a stored board counter drifts on every delete.

- [ ] **Step 1: Write the failing test**

```ts
// functions/src/__tests__/billingUsage.test.ts
import { applySessionUsage, type SessionUsageDoc } from "../billing/usage";
import { currentPeriod } from "../ai/usage";

const T = Date.UTC(2026, 8, 9, 12, 0, 0); // 2026-09-09

describe("applySessionUsage", () => {
  it("starts a fresh period at one", () => {
    const next = applySessionUsage(undefined, T);
    expect(next.sessions).toBe(1);
    expect(next.updatedAt).toBe(T);
  });

  it("increments an existing period", () => {
    const prev: SessionUsageDoc = { sessions: 2, updatedAt: T - 1000 };
    expect(applySessionUsage(prev, T).sessions).toBe(3);
  });

  it("tolerates a malformed counter without throwing", () => {
    const prev = { sessions: "oops", updatedAt: 0 } as unknown as SessionUsageDoc;
    expect(applySessionUsage(prev, T).sessions).toBe(1);
  });
});

describe("period agreement", () => {
  it("uses the same bucket as the AI meter", () => {
    // The AI meter and the session meter must never disagree about when a
    // month starts, or a user's two quotas reset on different days.
    expect(currentPeriod(T)).toBe("2026-09");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm --prefix functions test -- billingUsage.test.ts`
Expected: FAIL — `Cannot find module '../billing/usage'`.

- [ ] **Step 3: Implement**

```ts
// functions/src/billing/usage.ts
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { currentPeriod } from "../ai/usage";

/** Persisted at `workspaces/{id}/usage/{period}`. Functions-only writes. */
export interface SessionUsageDoc {
  sessions: number;
  updatedAt: number;
}

/** Pure increment, split out so it unit-tests without Firestore — mirrors the
 *  `applyUsage` split in ai/usage.ts. A non-numeric stored value resets to 0
 *  rather than producing NaN and silently disabling the gate. */
export function applySessionUsage(
  prev: SessionUsageDoc | undefined,
  now: number
): SessionUsageDoc {
  const current = typeof prev?.sessions === "number" && Number.isFinite(prev.sessions)
    ? prev.sessions
    : 0;
  return { sessions: current + 1, updatedAt: now };
}

function usageRef(db: Firestore, workspaceId: string, now: number) {
  return db.doc(`workspaces/${workspaceId}/usage/${currentPeriod(now)}`);
}

/** Boards are a STOCK: live aggregation, so deleting a board frees a slot with
 *  no decrement path to get wrong. */
export async function countBoards(db: Firestore, workspaceId: string): Promise<number> {
  const snap = await db
    .collection("boards")
    .where("workspaceId", "==", workspaceId)
    .count()
    .get();
  return snap.data().count;
}

/** Sessions are a FLOW: monthly bucket, increment-only. */
export async function readSessionCount(
  db: Firestore,
  workspaceId: string,
  now: number
): Promise<number> {
  const snap = await usageRef(db, workspaceId, now).get();
  const data = snap.exists ? (snap.data() as SessionUsageDoc) : undefined;
  return typeof data?.sessions === "number" ? data.sessions : 0;
}

/** Must run inside the same transaction as the session create so the count can
 *  never drift from the documents it counts. */
export function incrementSessionCount(
  tx: Transaction,
  db: Firestore,
  workspaceId: string,
  now: number,
  prev: SessionUsageDoc | undefined
): void {
  tx.set(usageRef(db, workspaceId, now), applySessionUsage(prev, now));
}
```

- [ ] **Step 4: Lock the collections in rules**

Add inside `match /workspaces/{workspaceId}`, directly after the existing `aiRate` block, matching its comment style:

```
      // Plan metering (M5). Written ONLY by Cloud Functions via the Admin SDK,
      // exactly like aiUsage/aiLog above. Owner/admin read it for the usage page.
      match /usage/{period} {
        allow read:  if isSignedIn() &&
                       get(/databases/$(database)/documents/workspaces/$(workspaceId)).data.members[request.auth.uid] in ['owner', 'admin'];
        allow write: if false;
      }
      // Stripe subscription state (M5). The webhook is the only writer; a client
      // that could write here could grant itself Pro.
      match /billing/{docId} {
        allow read:  if isSignedIn() &&
                       get(/databases/$(database)/documents/workspaces/$(workspaceId)).data.members[request.auth.uid] in ['owner', 'admin'];
        allow write: if false;
      }
```

- [ ] **Step 5: Add the rules tests**

Append to `firestore-tests/firestore.rules.test.js`, following the file's existing helper style:

```js
describe("M5 metering collections", () => {
  it("denies a client write to usage", async () => {
    const ctx = testEnv.authenticatedContext("owner1");
    await assertFails(
      ctx.firestore().doc("workspaces/ws1/usage/2026-09").set({ sessions: 0 })
    );
  });

  it("denies a client write to billing", async () => {
    const ctx = testEnv.authenticatedContext("owner1");
    await assertFails(
      ctx.firestore().doc("workspaces/ws1/billing/subscription").set({ plan: "pro" })
    );
  });

  it("lets a workspace owner read usage", async () => {
    const ctx = testEnv.authenticatedContext("owner1");
    await assertSucceeds(ctx.firestore().doc("workspaces/ws1/usage/2026-09").get());
  });

  it("denies a plain member reading usage", async () => {
    const ctx = testEnv.authenticatedContext("member1");
    await assertFails(ctx.firestore().doc("workspaces/ws1/usage/2026-09").get());
  });
});
```

- [ ] **Step 6: Run both suites**

Run: `npm --prefix functions test -- billingUsage.test.ts`
Expected: PASS, 4 tests.

Run: `npm run test:rules`
Expected: PASS, previous count + 4.

- [ ] **Step 7: Commit**

```bash
git add functions/src/billing/usage.ts functions/src/__tests__/billingUsage.test.ts firestore.rules firestore-tests/firestore.rules.test.js
git commit -m "feat(billing): add server-side usage counters and lock metering collections"
```

---

### Task 4: Real `checkQuota` — AI gate live, client demoted to advisory

**Files:**
- Modify: `functions/src/ai/usage.ts:172-182` (`checkAiQuota` — the existing body is a documented M5 stub)
- Modify: `src/services/quotaService.ts`
- Create: `functions/src/__tests__/aiQuota.test.ts`
- Modify: `src/services/__tests__/quotaService.test.ts`

**Interfaces:**
- Consumes: `limitFor` (Task 2), `currentPeriod` (existing).
- Produces: a live `checkAiQuota(db, workspaceId, now)`. **The four M4 callables already call it** (`generateSummary.ts:79` and siblings) — this task changes only the body, never those call sites.

The existing stub already carries the instruction: *"M5: compare snap usage against workspace.plan limits and return false past cap."* Do exactly that.

- [ ] **Step 1: Write the failing test**

```ts
// functions/src/__tests__/aiQuota.test.ts
import { isWithinAiQuota } from "../ai/usage";

describe("isWithinAiQuota", () => {
  it("allows a free workspace under the cap", () => {
    expect(isWithinAiQuota("free", 4)).toBe(true);
  });

  it("blocks a free workspace at the cap", () => {
    expect(isWithinAiQuota("free", 5)).toBe(false);
  });

  it("never blocks pro", () => {
    expect(isWithinAiQuota("pro", 100000)).toBe(true);
  });

  it("treats a missing plan as free (fail closed)", () => {
    expect(isWithinAiQuota(undefined, 5)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm --prefix functions test -- aiQuota.test.ts`
Expected: FAIL — `isWithinAiQuota is not a function`.

- [ ] **Step 3: Implement**

Replace the `checkAiQuota` body in `functions/src/ai/usage.ts` and add the pure helper beside it:

```ts
import { limitFor, type Plan } from "../billing/limits";

/** Pure quota comparison, split out for unit testing. A missing/unknown plan
 *  falls back to `free` via limitFor, so a corrupt workspace doc fails closed. */
export function isWithinAiQuota(plan: Plan | undefined, callsThisPeriod: number): boolean {
  return callsThisPeriod < limitFor((plan ?? "free") as Plan, "aiCallsPerPeriod");
}

export async function checkAiQuota(
  db: Firestore,
  workspaceId: string,
  now: number
): Promise<boolean> {
  const period = currentPeriod(now);
  const [usageSnap, wsSnap] = await Promise.all([
    db.doc(`workspaces/${workspaceId}/aiUsage/${period}`).get(),
    db.doc(`workspaces/${workspaceId}`).get(),
  ]);
  const calls = usageSnap.exists ? ((usageSnap.data()?.calls as number) ?? 0) : 0;
  const plan = wsSnap.exists ? (wsSnap.data()?.plan as Plan | undefined) : undefined;
  return isWithinAiQuota(plan, calls);
}
```

- [ ] **Step 4: Demote the client `checkQuota` to advisory**

In `src/services/quotaService.ts`, keep the exported signatures **exactly as they are** (call sites depend on them) and rewrite the doc comments so nobody mistakes it for the gate again. Replace the header comment block with:

```ts
// ⚠️ ADVISORY ONLY — NOT AN ENFORCEMENT POINT.
//
// This module exists so the UI can warn a user *before* a create fails. The real
// gate lives server-side: board/session creates go through Cloud Function
// callables (functions/src/callable/createBoard.ts, createSession.ts) and
// firestore.rules denies direct client creates. AI is gated in
// functions/src/ai/usage.ts#checkAiQuota.
//
// Never add a limit here and consider it enforced. A patched bundle skips this
// file entirely; that is exactly why the M5 enforcement moved.
```

Then make `checkQuota` read the client mirror so the pre-flight is at least accurate:

```ts
import { limitFor } from "../lib/planLimits";
import type { Plan } from "../types";

/** Advisory pre-flight (see the module header). Returns the UI's best guess;
 *  the server decides. `plan` is passed in by the caller from the active
 *  workspace so this stays a pure, synchronous-ish check with no extra read. */
export async function checkQuota(
  workspaceId: string,
  resource: QuotaResource,
  plan: Plan = "free",
  currentCount = 0
): Promise<boolean> {
  void workspaceId;
  const mapped: Record<QuotaResource, Parameters<typeof limitFor>[1]> = {
    board: "boards",
    session: "sessionsPerPeriod",
    aiSummary: "aiCallsPerPeriod",
    aiCall: "aiCallsPerPeriod",
  };
  return currentCount < limitFor(plan, mapped[resource]);
}
```

Keep `assertQuota` and `QuotaExceededError` unchanged in shape; `assertQuota` now forwards the two new optional arguments.

- [ ] **Step 5: Update the client test**

Add to `src/services/__tests__/quotaService.test.ts`:

```ts
it("is advisory: allows when under the mirrored limit", async () => {
  await expect(checkQuota("ws1", "board", "free", 4)).resolves.toBe(true);
});

it("is advisory: warns when at the mirrored limit", async () => {
  await expect(checkQuota("ws1", "board", "free", 5)).resolves.toBe(false);
});

it("defaults to free when no plan is supplied", async () => {
  await expect(checkQuota("ws1", "board", undefined, 5)).resolves.toBe(false);
});
```

- [ ] **Step 6: Run everything**

Run: `npm --prefix functions test`
Expected: all suites pass, including the 4 existing AI callable suites that call `checkAiQuota`.

Run: `npx jest src/services/__tests__/quotaService.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add functions/src/ai/usage.ts functions/src/__tests__/aiQuota.test.ts src/services/quotaService.ts src/services/__tests__/quotaService.test.ts
git commit -m "feat(billing): enforce AI quota server-side, demote client checkQuota to advisory"
```

---

### Task 5: `createBoard` callable

**Files:**
- Create: `functions/src/callable/createBoard.ts`
- Create: `functions/src/__tests__/createBoard.test.ts`
- Modify: `functions/src/index.ts` (export)
- Modify: `src/services/boardService.ts:110-127` (`createBoard` becomes a callable wrapper)

**Interfaces:**
- Consumes: `countBoards` (Task 3), `limitFor` (Task 2), the `handleX`/`onCall` split from `functions/src/callable/generateSummary.ts`.
- Produces: callable `createBoard({ workspaceId, title }) → { boardId, inviteCode }`. **The client signature `createBoard(title, ownerId, workspaceId): Promise<string>` must not change** — every call site keeps working.

**Invite-code generation moves server-side.** It currently uses `secureRandom` on the client; the function must generate it so a client cannot choose its own code. Reuse the same 36-char alphabet and length.

- [ ] **Step 1: Write the failing test**

```ts
// functions/src/__tests__/createBoard.test.ts
import { HttpsError } from "firebase-functions/v2/https";
import { handleCreateBoard, generateInviteCode } from "../callable/createBoard";

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

const deps = (opts: { plan?: string; boardCount?: number; isMember?: boolean }) => ({
  getWorkspace: jest.fn(async () => (opts.isMember === false
    ? { plan: opts.plan ?? "free", members: {} }
    : { plan: opts.plan ?? "free", members: { u1: "member" } })),
  countBoards: jest.fn(async () => opts.boardCount ?? 0),
  writeBoard: jest.fn(async () => "board123"),
});

describe("handleCreateBoard", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(handleCreateBoard(reqFor(undefined, { workspaceId: "ws1", title: "T" }), deps({}), 0))
      .rejects.toBeInstanceOf(HttpsError);
  });

  it("rejects a non-member of the workspace", async () => {
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), deps({ isMember: false }), 0))
      .rejects.toThrow(/not a member/i);
  });

  it("creates a board when under the free limit", async () => {
    const d = deps({ boardCount: 4 });
    const res = await handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), d, 0);
    expect(res.boardId).toBe("board123");
    expect(res.inviteCode).toHaveLength(6);
    expect(d.writeBoard).toHaveBeenCalled();
  });

  it("blocks the 6th board on the free plan", async () => {
    const d = deps({ boardCount: 5 });
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), d, 0))
      .rejects.toThrow(/limit/i);
    expect(d.writeBoard).not.toHaveBeenCalled();
  });

  it("allows the 6th board on pro", async () => {
    const d = deps({ plan: "pro", boardCount: 5 });
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "T" }), d, 0))
      .resolves.toMatchObject({ boardId: "board123" });
  });

  it("rejects a blank title", async () => {
    await expect(handleCreateBoard(reqFor("u1", { workspaceId: "ws1", title: "   " }), deps({}), 0))
      .rejects.toThrow(/title/i);
  });
});

describe("generateInviteCode", () => {
  it("returns six characters from the expected alphabet", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateInviteCode()).toMatch(/^[A-Z0-9]{6}$/);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm --prefix functions test -- createBoard.test.ts`
Expected: FAIL — `Cannot find module '../callable/createBoard'`.

- [ ] **Step 3: Implement the callable**

```ts
// functions/src/callable/createBoard.ts
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { randomInt } from "crypto";
import { countBoards } from "../billing/usage";
import { limitFor, type Plan } from "../billing/limits";

const INVITE_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const INVITE_CODE_LENGTH = 6;

/** Server-side invite codes: a client must not be able to choose its own code. */
export function generateInviteCode(): string {
  let out = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    out += INVITE_CODE_CHARS[randomInt(INVITE_CODE_CHARS.length)];
  }
  return out;
}

export interface CreateBoardRequest {
  workspaceId: string;
  title: string;
}

export interface CreateBoardResponse {
  boardId: string;
  inviteCode: string;
}

/** Injected so the handler unit-tests without Firestore, matching the
 *  handleGenerateSummary pattern. */
export interface CreateBoardDeps {
  getWorkspace(workspaceId: string): Promise<{ plan?: string; members?: Record<string, string> } | null>;
  countBoards(workspaceId: string): Promise<number>;
  writeBoard(doc: Record<string, unknown>): Promise<string>;
}

export async function handleCreateBoard(
  req: CallableRequest<CreateBoardRequest>,
  deps: CreateBoardDeps,
  now: number
): Promise<CreateBoardResponse> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to create a board.");

  const { workspaceId, title } = req.data ?? ({} as CreateBoardRequest);
  if (!workspaceId) throw new HttpsError("invalid-argument", "workspaceId is required.");
  if (!title || !title.trim()) throw new HttpsError("invalid-argument", "A board title is required.");

  const ws = await deps.getWorkspace(workspaceId);
  if (!ws) throw new HttpsError("not-found", "Workspace not found.");
  if (!ws.members || !(uid in ws.members)) {
    throw new HttpsError("permission-denied", "You are not a member of this workspace.");
  }

  const plan = (ws.plan ?? "free") as Plan;
  const used = await deps.countBoards(workspaceId);
  if (used >= limitFor(plan, "boards")) {
    throw new HttpsError(
      "resource-exhausted",
      `Your plan allows ${limitFor(plan, "boards")} boards. Upgrade for more.`
    );
  }

  const inviteCode = generateInviteCode();
  const boardId = await deps.writeBoard({
    workspaceId,
    title: title.trim(),
    ownerId: uid,
    adminId: uid,
    collaboratorIds: [],
    inviteCode,
    members: [uid],
    roles: {},
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdAtMs: now,
  });

  return { boardId, inviteCode };
}

export const createBoard = onCall((req: CallableRequest<CreateBoardRequest>) => {
  const db = getFirestore();
  return handleCreateBoard(
    req,
    {
      getWorkspace: async (id) => {
        const s = await db.doc(`workspaces/${id}`).get();
        return s.exists ? (s.data() as { plan?: string; members?: Record<string, string> }) : null;
      },
      countBoards: (id) => countBoards(db, id),
      writeBoard: async (doc) => (await db.collection("boards").add(doc)).id,
    },
    Date.now()
  );
});
```

- [ ] **Step 4: Export it**

Add to `functions/src/index.ts`, matching the file's comment style:

```ts
// Month 5 — plan enforcement. Board creation moved server-side so the free-tier
// board cap cannot be bypassed by a patched client (firestore.rules denies
// direct client creates; see Task 7).
export { createBoard } from "./callable/createBoard";
```

- [ ] **Step 5: Rewire the client, keeping its signature**

In `src/services/boardService.ts`, replace the `createBoard` body. Keep the exported signature identical.

```ts
import { getFunctions, httpsCallable } from "firebase/functions";

/** Server-enforced since M5: the callable owns the quota check and the invite
 *  code. The client signature is unchanged so call sites did not move. */
export async function createBoard(
  title: string,
  ownerId: string,
  workspaceId: string
): Promise<string> {
  void ownerId; // the function derives the owner from the auth token, not the client
  const fn = httpsCallable<{ workspaceId: string; title: string }, { boardId: string; inviteCode: string }>(
    getFunctions(undefined, "us-central1"),
    "createBoard"
  );
  const res = await fn({ workspaceId, title });
  return res.data.boardId;
}
```

Remove the now-dead local `generateInviteCode` **only if** nothing else in the file uses it; `joinBoardByCode` reads codes but does not generate them — verify with a grep before deleting.

- [ ] **Step 6: Run the suites**

Run: `npm --prefix functions test -- createBoard.test.ts`
Expected: PASS, 7 tests.

Run: `npx jest src/services/__tests__/boardService.test.ts`
Expected: PASS. If existing tests asserted on `addDoc`, update them to assert the callable was invoked — that is a real behaviour change, not a test-fudge.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add functions/src/callable/createBoard.ts functions/src/__tests__/createBoard.test.ts functions/src/index.ts src/services/boardService.ts src/services/__tests__/boardService.test.ts
git commit -m "feat(billing): move board creation server-side behind the plan gate"
```

---

### Task 6: `createSession` callable

**Files:**
- Create: `functions/src/callable/createSession.ts`
- Create: `functions/src/__tests__/createSession.test.ts`
- Modify: `functions/src/index.ts`
- Modify: `src/services/sessionService.ts:61-82`

**Interfaces:**
- Consumes: `readSessionCount`, `incrementSessionCount`, `applySessionUsage` (Task 3); `limitFor` (Task 2).
- Produces: callable `createSession(payload) → { sessionId, joinCode }`. Client signature `createSession(data): Promise<string>` unchanged.

**The counter increment and the session write must be in one transaction.** That is the whole reason sessions use a stored counter — if they can diverge, the gate is decorative.

- [ ] **Step 1: Write the failing test**

```ts
// functions/src/__tests__/createSession.test.ts
import { HttpsError } from "firebase-functions/v2/https";
import { handleCreateSession } from "../callable/createSession";

const base = { workspaceId: "ws1", boardId: "b1", title: "Study", scheduledAtMs: 1_760_000_000_000, durationMinutes: 60 };

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

const deps = (opts: { plan?: string; sessions?: number; member?: boolean }) => ({
  getWorkspace: jest.fn(async () => ({
    plan: opts.plan ?? "free",
    members: opts.member === false ? {} : { u1: "member" },
  })),
  runCreate: jest.fn(async () => ({ sessionId: "s1", joinCode: "ABC123" })),
  readSessionCount: jest.fn(async () => opts.sessions ?? 0),
});

describe("handleCreateSession", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(handleCreateSession(reqFor(undefined, base), deps({}), 0))
      .rejects.toBeInstanceOf(HttpsError);
  });

  it("rejects a non-member", async () => {
    await expect(handleCreateSession(reqFor("u1", base), deps({ member: false }), 0))
      .rejects.toThrow(/not a member/i);
  });

  it("creates when under the monthly cap", async () => {
    const d = deps({ sessions: 2 });
    await expect(handleCreateSession(reqFor("u1", base), d, 0))
      .resolves.toMatchObject({ sessionId: "s1" });
    expect(d.runCreate).toHaveBeenCalled();
  });

  it("blocks the 4th session in a period on free", async () => {
    const d = deps({ sessions: 3 });
    await expect(handleCreateSession(reqFor("u1", base), d, 0)).rejects.toThrow(/limit/i);
    expect(d.runCreate).not.toHaveBeenCalled();
  });

  it("allows the 4th session on pro", async () => {
    const d = deps({ plan: "pro", sessions: 3 });
    await expect(handleCreateSession(reqFor("u1", base), d, 0)).resolves.toMatchObject({ sessionId: "s1" });
  });

  it("requires a boardId", async () => {
    await expect(handleCreateSession(reqFor("u1", { ...base, boardId: "" }), deps({}), 0))
      .rejects.toThrow(/boardId/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm --prefix functions test -- createSession.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Follow the Task 5 shape exactly. The `runCreate` dep wraps a `db.runTransaction` that (a) re-reads the usage doc inside the transaction, (b) re-checks the limit against that fresh read, (c) writes the session document, and (d) calls `incrementSessionCount` with the value it read. The re-check inside the transaction is what makes two concurrent creates at the boundary safe — the pre-flight read outside it is only there to fail fast.

```ts
// functions/src/callable/createSession.ts — the transactional core
const runCreate: CreateSessionDeps["runCreate"] = async (workspaceId, sessionDoc, now, plan) =>
  db.runTransaction(async (tx) => {
    const ref = db.doc(`workspaces/${workspaceId}/usage/${currentPeriod(now)}`);
    const snap = await tx.get(ref);
    const prev = snap.exists ? (snap.data() as SessionUsageDoc) : undefined;
    const used = typeof prev?.sessions === "number" ? prev.sessions : 0;
    if (used >= limitFor(plan, "sessionsPerPeriod")) {
      throw new HttpsError("resource-exhausted", "Session limit reached for this period.");
    }
    const sessionRef = db.collection("sessions").doc();
    const joinCode = generateInviteCode();
    tx.set(sessionRef, { ...sessionDoc, joinCode });
    incrementSessionCount(tx, db, workspaceId, now, prev);
    return { sessionId: sessionRef.id, joinCode };
  });
```

Import `generateInviteCode` from `./createBoard` rather than duplicating it.

- [ ] **Step 4: Export and rewire the client**

Export from `functions/src/index.ts`. In `src/services/sessionService.ts`, replace the `createSession` body with a callable wrapper, keeping `createSession(data: Omit<Session, "id" | "createdAt">): Promise<string>`. Convert `scheduledAt` to `scheduledAtMs` on the way out (a `Date` does not survive the callable boundary) and let the function rebuild the `Timestamp`.

- [ ] **Step 5: Run the suites**

Run: `npm --prefix functions test -- createSession.test.ts`
Expected: PASS, 6 tests.

Run: `npx jest src/services/__tests__/sessionService.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add functions/src/callable/createSession.ts functions/src/__tests__/createSession.test.ts functions/src/index.ts src/services/sessionService.ts src/services/__tests__/sessionService.test.ts
git commit -m "feat(billing): move session creation server-side with a transactional monthly gate"
```

---

### Task 7: Rules — deny client creates, cap collaborators

**Files:**
- Modify: `firestore.rules` (board `create`, session `create`, board `update` seat cap)
- Modify: `firestore-tests/firestore.rules.test.js`

**Interfaces:**
- Consumes: the callables from Tasks 5 and 6 must already be deployed-or-emulated, because this task removes the client's ability to create.
- Produces: the actual enforcement boundary. **This is the task the whole spine exists for.**

**Ship this as its own commit** so it can be reverted alone if a client path was missed.

The seat cap must be a rules predicate rather than a callable, because the invite-code self-join path is a client `update` to `members`, not a create — a callable would leave that door open. The existing self-join rule is at `firestore.rules:267-273`.

- [ ] **Step 1: Write the failing rules tests**

```js
describe("M5 create enforcement", () => {
  it("denies a direct client board create", async () => {
    const ctx = testEnv.authenticatedContext("owner1");
    await assertFails(
      ctx.firestore().collection("boards").add({
        workspaceId: "ws1", title: "sneaky", ownerId: "owner1", members: ["owner1"],
      })
    );
  });

  it("denies a direct client session create", async () => {
    const ctx = testEnv.authenticatedContext("owner1");
    await assertFails(
      ctx.firestore().collection("sessions").add({ workspaceId: "ws1", boardId: "b1", title: "x" })
    );
  });

  it("denies a self-join that would exceed the free seat cap", async () => {
    // b_full is seeded with 4 members on a free workspace.
    const ctx = testEnv.authenticatedContext("outsider");
    await assertFails(
      ctx.firestore().doc("boards/b_full").update({
        members: FieldValue.arrayUnion("outsider"),
        updatedAt: FieldValue.serverTimestamp(),
      })
    );
  });

  it("allows a self-join under the seat cap", async () => {
    // b_small is seeded with 2 members on a free workspace.
    const ctx = testEnv.authenticatedContext("outsider");
    await assertSucceeds(
      ctx.firestore().doc("boards/b_small").update({
        members: FieldValue.arrayUnion("outsider"),
        updatedAt: FieldValue.serverTimestamp(),
      })
    );
  });
});
```

Seed `b_full` (4 members) and `b_small` (2 members), both with `workspaceId: "ws1"` and `inviteCode` set, in the existing `beforeEach` seeding block.

- [ ] **Step 2: Run to confirm they fail**

Run: `npm run test:rules`
Expected: the four new tests FAIL (creates currently succeed; the cap does not exist).

- [ ] **Step 3: Implement the rules changes**

Replace the board `create` rule (currently `firestore.rules:253-256`):

```
      // M5: creates are Cloud-Function-only (functions/src/callable/createBoard.ts)
      // so the plan's board cap cannot be bypassed. The Admin SDK bypasses rules.
      allow create: if false;
```

Add the same for `match /sessions/{sessionId}` (currently line ~367).

Add the seat-cap helper beside the other helpers at the top of the file:

```
    // M5 seat cap. Board membership growth is gated by the workspace plan. Kept
    // as a rules predicate rather than a callable because the invite-code
    // self-join path is a client `update` to `members`, not a create.
    function planSeatLimit(wsId) {
      let plan = wsId != null && wsId != '' &&
        exists(/databases/$(database)/documents/workspaces/$(wsId)) ?
        get(/databases/$(database)/documents/workspaces/$(wsId)).data.get('plan', 'free') : 'free';
      return plan == 'pro' ? 25 : (plan == 'edu' ? 100 : 4);
    }

    function withinSeatCap(board, next) {
      return next.members.size() <= planSeatLimit(board.get('workspaceId', null)) ||
        next.members.size() <= board.members.size();
    }
```

The second clause lets a member **leave** a board that is already over cap (e.g. after a downgrade) — without it, an over-cap board becomes permanently frozen.

Then add `withinSeatCap(resource.data, request.resource.data) &&` to each `allow update` arm that can change `members` (the editor arm, the member arm, and the invite-code self-join arm).

> **Note the duplicated numbers.** The seat limits appear both here and in `functions/src/billing/limits.ts`. Firestore rules cannot import TypeScript, so this is unavoidable. Add a comment in **both** files pointing at the other, and add an assertion to `functions/src/__tests__/limits.test.ts` that reads `firestore.rules`, extracts the three numbers from `planSeatLimit`, and compares them to `PLAN_LIMITS[*].collaboratorsPerBoard`.

- [ ] **Step 4: Run the rules suite**

Run: `npm run test:rules`
Expected: PASS. Previous count + 4, and **every pre-existing test still green** — especially the M3 isolation tests and the M4 embed-token tests.

- [ ] **Step 5: Add the limits-drift assertion**

```ts
// append to functions/src/__tests__/limits.test.ts
import * as fs from "fs";
import * as path from "path";

it("keeps firestore.rules seat caps in sync with the limits table", () => {
  const rules = fs.readFileSync(path.join(__dirname, "../../../firestore.rules"), "utf8");
  const fn = rules.slice(rules.indexOf("function planSeatLimit"));
  const body = fn.slice(0, fn.indexOf("}"));
  expect(body).toContain(String(PLAN_LIMITS.pro.collaboratorsPerBoard));
  expect(body).toContain(String(PLAN_LIMITS.edu.collaboratorsPerBoard));
  expect(body).toContain(String(PLAN_LIMITS.free.collaboratorsPerBoard));
});
```

- [ ] **Step 6: Run everything and commit**

Run: `npm --prefix functions test`
Expected: PASS.

Run: `npm run test:rules`
Expected: PASS.

```bash
git add firestore.rules firestore-tests/firestore.rules.test.js functions/src/__tests__/limits.test.ts
git commit -m "feat(billing): deny client-side creates and enforce the collaborator cap in rules"
```

---

### Task 8: Stripe Checkout callable

**Gate: G3.** If the Stripe account does not exist yet, park this task and continue with an unblocked track. The implementation and its tests do not need a live account; only running it against Stripe does.

**Files:**
- Create: `functions/src/billing/stripe.ts`
- Create: `functions/src/callable/createCheckoutSession.ts`
- Create: `functions/src/__tests__/stripeCheckout.test.ts`
- Modify: `functions/src/config.ts`, `functions/src/index.ts`
- Modify: `functions/package.json` (add `stripe`)

**Interfaces:**
- Produces: callable `createCheckoutSession({ workspaceId }) → { url }`. Task 11 calls it via `billingService`.

**The price ID is resolved server-side from config and never accepted from the client** — a client-supplied price ID lets anyone check out at a price of their choosing.

- [ ] **Step 1: Add the secrets**

Append to `functions/src/config.ts`, matching the existing comment style:

```ts
// Stripe (Month 5). Secret key + webhook signing secret live only in the function
// runtime. Set before first deploy:
//   firebase functions:secrets:set STRIPE_SECRET_KEY
//   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
export const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
export const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
// The Pro price ID. Not a secret, but server-resolved so a client can never
// choose the price it checks out at.
export const STRIPE_PRO_PRICE_ID = defineSecret("STRIPE_PRO_PRICE_ID");
```

- [ ] **Step 2: Write the failing test**

```ts
// functions/src/__tests__/stripeCheckout.test.ts
import { handleCreateCheckoutSession } from "../callable/createCheckoutSession";

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

const deps = (opts: { role?: string } = {}) => ({
  getWorkspace: jest.fn(async () => ({ plan: "free", members: { u1: opts.role ?? "owner" } })),
  createSession: jest.fn(async () => ({ url: "https://checkout.stripe.test/s/1" })),
});

describe("handleCreateCheckoutSession", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(handleCreateCheckoutSession(reqFor(undefined, { workspaceId: "ws1" }), deps()))
      .rejects.toThrow();
  });

  it("rejects a non-owner", async () => {
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), deps({ role: "member" })))
      .rejects.toThrow(/owner/i);
  });

  it("returns a checkout url for the owner", async () => {
    const d = deps();
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .resolves.toEqual({ url: "https://checkout.stripe.test/s/1" });
  });

  it("stamps the workspace id as client_reference_id", async () => {
    const d = deps();
    await handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d);
    expect(d.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws1", uid: "u1" })
    );
  });

  it("ignores a client-supplied priceId", async () => {
    const d = deps();
    await handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1", priceId: "price_cheap" } as never), d);
    expect(JSON.stringify(d.createSession.mock.calls[0])).not.toContain("price_cheap");
  });
});
```

- [ ] **Step 3: Run to confirm it fails, then implement**

Run: `npm --prefix functions test -- stripeCheckout.test.ts` → FAIL.

Only the workspace **owner** may start a checkout. The handler validates auth, resolves the workspace, checks `members[uid] === "owner"`, and delegates to `deps.createSession({ workspaceId, uid })`. The `onCall` binding constructs the real Stripe client from `STRIPE_SECRET_KEY.value()` and passes `client_reference_id: workspaceId`, `metadata: { workspaceId, uid }`, `mode: "subscription"`, and the server-resolved price.

- [ ] **Step 4: Install the dependency**

Run: `npm --prefix functions install stripe`

- [ ] **Step 5: Run, then commit**

Run: `npm --prefix functions test -- stripeCheckout.test.ts`
Expected: PASS, 5 tests.

```bash
git add functions/src/billing/stripe.ts functions/src/callable/createCheckoutSession.ts functions/src/__tests__/stripeCheckout.test.ts functions/src/config.ts functions/src/index.ts functions/package.json functions/package-lock.json
git commit -m "feat(billing): add Stripe Checkout session callable"
```

---

### Task 9: Stripe webhook — idempotent subscription sync

**Gate: G3.**

**Files:**
- Create: `functions/src/http/stripeWebhook.ts`
- Create: `functions/src/__tests__/stripeWebhook.test.ts`
- Create: `functions/src/__tests__/fixtures/stripe-events.ts`
- Modify: `functions/src/index.ts`

**Interfaces:**
- Produces: `POST /stripeWebhook`. Writes `workspaces/{id}/billing/subscription` and `workspaces/{id}.plan`. **This is the only writer of `plan` after signup.**

**Two things make or break this task:**
1. **Raw body.** Firebase Functions v2 parses request bodies by default; Stripe signature verification needs the unparsed bytes (`req.rawBody`). Verifying against a parsed-and-restringified body fails intermittently and looks like a Stripe bug.
2. **Idempotency.** Stripe retries deliveries. A replayed `checkout.session.completed` must not double-apply. Record `event.id` and short-circuit on a repeat.

- [ ] **Step 1: Write the fixtures**

`functions/src/__tests__/fixtures/stripe-events.ts` exports minimal but shape-accurate objects for `checkout.session.completed`, `customer.subscription.updated` (status `active` and `past_due`), `customer.subscription.deleted`, and `invoice.payment_failed`. Each carries `id`, `type`, and `data.object` with `client_reference_id` / `metadata.workspaceId`, `customer`, `subscription`, `status`, and `current_period_end`.

- [ ] **Step 2: Write the failing test**

```ts
// functions/src/__tests__/stripeWebhook.test.ts
import { applyStripeEvent } from "../http/stripeWebhook";
import * as fx from "./fixtures/stripe-events";

const store = () => {
  const seen = new Set<string>();
  return {
    seen,
    alreadyProcessed: jest.fn(async (id: string) => seen.has(id)),
    markProcessed: jest.fn(async (id: string) => { seen.add(id); }),
    setPlan: jest.fn(async () => {}),
    setSubscription: jest.fn(async () => {}),
  };
};

describe("applyStripeEvent", () => {
  it("upgrades the workspace on checkout completion", async () => {
    const s = store();
    await applyStripeEvent(fx.checkoutCompleted, s, 0);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "pro");
  });

  it("is idempotent on a replayed event", async () => {
    const s = store();
    await applyStripeEvent(fx.checkoutCompleted, s, 0);
    await applyStripeEvent(fx.checkoutCompleted, s, 0);
    expect(s.setPlan).toHaveBeenCalledTimes(1);
  });

  it("downgrades on subscription deletion", async () => {
    const s = store();
    await applyStripeEvent(fx.subscriptionDeleted, s, 0);
    expect(s.setPlan).toHaveBeenCalledWith("ws1", "free");
  });

  it("keeps pro while past_due (grace, not instant downgrade)", async () => {
    const s = store();
    await applyStripeEvent(fx.subscriptionPastDue, s, 0);
    expect(s.setPlan).not.toHaveBeenCalledWith("ws1", "free");
    expect(s.setSubscription).toHaveBeenCalledWith("ws1", expect.objectContaining({ status: "past_due" }));
  });

  it("ignores an event type it does not handle", async () => {
    const s = store();
    await applyStripeEvent({ id: "evt_x", type: "customer.created", data: { object: {} } } as never, s, 0);
    expect(s.setPlan).not.toHaveBeenCalled();
  });

  it("throws when the event carries no workspace id", async () => {
    const s = store();
    const bad = { ...fx.checkoutCompleted, id: "evt_bad", data: { object: { } } } as never;
    await expect(applyStripeEvent(bad, s, 0)).rejects.toThrow(/workspace/i);
  });
});
```

- [ ] **Step 3: Run to confirm it fails, then implement**

Run: `npm --prefix functions test -- stripeWebhook.test.ts` → FAIL.

`applyStripeEvent(event, store, now)` is pure over the injected store: check `alreadyProcessed(event.id)` and return early; resolve the workspace id from `client_reference_id` or `metadata.workspaceId` and throw if absent; switch on `event.type`; write subscription state; set `plan` only for the transitions above; then `markProcessed(event.id)`.

The `onRequest` binding does signature verification and nothing else:

```ts
export const stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event: Stripe.Event;
    try {
      // req.rawBody — NOT req.body. The parsed body will not verify.
      event = stripeClient().webhooks.constructEvent(
        req.rawBody, sig as string, STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      logger.warn("stripe signature verification failed", { err });
      res.status(400).send("invalid signature");
      return;
    }
    await applyStripeEvent(event, firestoreStore(getFirestore()), Date.now());
    res.status(200).send("ok");
  }
);
```

- [ ] **Step 4: Run and commit**

Run: `npm --prefix functions test -- stripeWebhook.test.ts`
Expected: PASS, 6 tests.

```bash
git add functions/src/http/stripeWebhook.ts functions/src/__tests__/stripeWebhook.test.ts functions/src/__tests__/fixtures/stripe-events.ts functions/src/index.ts
git commit -m "feat(billing): add idempotent Stripe webhook syncing workspace plan"
```

---

### Task 10: Customer Portal + `billingService`

**Gate: G3.**

**Files:**
- Create: `functions/src/callable/createPortalSession.ts`
- Create: `src/services/billingService.ts`
- Create: `src/services/__tests__/billingService.test.ts`
- Modify: `functions/src/index.ts`

**Interfaces:**
- Produces: `startCheckout(workspaceId): Promise<string>` (returns a URL), `openBillingPortal(workspaceId): Promise<string>`, `getSubscription(workspaceId): Promise<Subscription | null>`. Tasks 11, 12 and 13 consume these.

The Customer Portal handles cancellation and payment-method changes, so **no cancellation UI is written anywhere in this plan.**

- [ ] **Step 1: Add the `Subscription` type**

```ts
// src/types/index.ts
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "incomplete";

/** Mirror of workspaces/{id}/billing/subscription, written only by the Stripe
 *  webhook. Readers tolerate missing fields (Global Constraints). */
export interface Subscription {
  schemaVersion: 1;
  status: SubscriptionStatus;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  currentPeriodEndMs: number;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/services/__tests__/billingService.test.ts
import { mapSubscriptionDoc, isEntitledToPro } from "../billingService";

describe("mapSubscriptionDoc", () => {
  it("returns null for a missing doc", () => {
    expect(mapSubscriptionDoc(undefined)).toBeNull();
  });

  it("tolerates a partial doc", () => {
    const s = mapSubscriptionDoc({ status: "active" });
    expect(s?.status).toBe("active");
    expect(s?.stripeCustomerId).toBe("");
    expect(s?.currentPeriodEndMs).toBe(0);
  });
});

describe("isEntitledToPro", () => {
  it("entitles an active subscription", () => {
    expect(isEntitledToPro({ status: "active" } as never, 0)).toBe(true);
  });

  it("entitles past_due until the period ends (grace)", () => {
    expect(isEntitledToPro({ status: "past_due", currentPeriodEndMs: 1000 } as never, 500)).toBe(true);
    expect(isEntitledToPro({ status: "past_due", currentPeriodEndMs: 1000 } as never, 1500)).toBe(false);
  });

  it("does not entitle a canceled subscription", () => {
    expect(isEntitledToPro({ status: "canceled" } as never, 0)).toBe(false);
  });

  it("does not entitle a null subscription", () => {
    expect(isEntitledToPro(null, 0)).toBe(false);
  });
});
```

- [ ] **Step 3: Run to confirm it fails, then implement**

Run: `npx jest src/services/__tests__/billingService.test.ts` → FAIL.

Implement the two pure functions plus the three callable wrappers (`httpsCallable` against region `us-central1`, same as Task 5) and a `getSubscription` that reads `workspaces/{id}/billing/subscription` through the service layer.

- [ ] **Step 4: Run and commit**

Run: `npx jest src/services/__tests__/billingService.test.ts`
Expected: PASS, 7 tests.

Run: `npx tsc --noEmit` → clean.

```bash
git add functions/src/callable/createPortalSession.ts src/services/billingService.ts src/services/__tests__/billingService.test.ts src/types/index.ts functions/src/index.ts
git commit -m "feat(billing): add customer portal callable and client billing service"
```

---

### Task 11: Upsell surfaces — two platform variants

**Files:**
- Create: `src/components/UpsellModal.tsx`
- Create: `src/components/__tests__/UpsellModal.test.tsx`
- Modify: the create/AI call sites that can now throw `resource-exhausted`

**Interfaces:**
- Consumes: `limitFor` (Task 2), `startCheckout` (Task 10).
- Produces: `<UpsellModal visible resource onDismiss />`.

**This is the task with a real external consequence.** A price or a checkout link inside the iOS/Android binary is what gets the app rejected. Build **two renders**, not one render with a conditional link — the conditional is what eventually leaks.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/__tests__/UpsellModal.test.tsx
import { render } from "@testing-library/react-native";
import { Platform } from "react-native";
import UpsellModal from "../UpsellModal";

describe("UpsellModal", () => {
  afterEach(() => { Platform.OS = "web"; });

  it("shows the price and an upgrade action on web", () => {
    Platform.OS = "web";
    const { getByText } = render(<UpsellModal visible resource="board" onDismiss={() => {}} />);
    expect(getByText(/\$5/)).toBeTruthy();
    expect(getByText(/upgrade/i)).toBeTruthy();
  });

  it("names the limit that was hit", () => {
    Platform.OS = "web";
    const { getByText } = render(<UpsellModal visible resource="board" onDismiss={() => {}} />);
    expect(getByText(/5 boards/i)).toBeTruthy();
  });

  // The store-compliance guard. If this test ever fails, the binary is at risk.
  it("renders NO price and NO link on native", () => {
    Platform.OS = "ios";
    const { toJSON } = render(<UpsellModal visible resource="board" onDismiss={() => {}} />);
    const tree = JSON.stringify(toJSON());
    expect(tree).not.toMatch(/\$\d/);
    expect(tree).not.toMatch(/https?:\/\//);
    expect(tree).not.toMatch(/upgrade/i);
    expect(tree).not.toMatch(/subscri/i);
  });

  it("still explains the limit on native", () => {
    Platform.OS = "ios";
    const { getByText } = render(<UpsellModal visible resource="board" onDismiss={() => {}} />);
    expect(getByText(/5 boards/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to confirm it fails, then implement**

Run: `npx jest src/components/__tests__/UpsellModal.test.tsx` → FAIL.

```tsx
// src/components/UpsellModal.tsx — the structural requirement
export default function UpsellModal({ visible, resource, onDismiss }: Props) {
  // Two separate renders. Do NOT collapse these into one tree with conditional
  // children: a price or checkout link inside the mobile binary violates App
  // Store / Play policy on external payment. See ROADMAP.md § Month 5 item 14.
  return Platform.OS === "web"
    ? <WebUpsell resource={resource} visible={visible} onDismiss={onDismiss} />
    : <NativeLimitNotice resource={resource} visible={visible} onDismiss={onDismiss} />;
}
```

`NativeLimitNotice` states the limit and offers only a dismiss action. It must not import `billingService`.

- [ ] **Step 3: Wire the call sites**

Where `createBoard`, `createSession`, or an AI callable can now reject with `resource-exhausted`, catch that specific code and show the modal. Do not catch broadly — a network error must not read as "upgrade."

- [ ] **Step 4: Run and commit**

Run: `npx jest src/components/__tests__/UpsellModal.test.tsx`
Expected: PASS, 5 tests.

```bash
git add src/components/UpsellModal.tsx src/components/__tests__/UpsellModal.test.tsx
git commit -m "feat(billing): add plan-limit upsell with store-compliant native variant"
```

---

### Task 12: Usage dashboard

**Files:**
- Modify: `app/ai-usage.tsx`
- Create: `src/services/usageService.ts`
- Create: `src/services/__tests__/usageService.test.ts`

**Interfaces:**
- Consumes: `getAiUsage` / `periodFor` / `formatUsd` / `canViewUsage` (all existing in `src/services/aiUsageService.ts`), `limitFor` (Task 2), `getSubscription` (Task 10).
- Produces: `getWorkspaceUsage(workspaceId, plan)` returning all four resources with their limits.

The page already reads the M4 AI meter and already gates on owner/admin. This task adds boards, sessions and headroom beside what is there.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/usageService.test.ts
import { toHeadroom } from "../usageService";

describe("toHeadroom", () => {
  it("reports remaining and a fraction for a capped resource", () => {
    expect(toHeadroom(3, 5)).toEqual({ used: 3, limit: 5, remaining: 2, fraction: 0.6, unlimited: false });
  });

  it("clamps an over-limit resource to zero remaining", () => {
    expect(toHeadroom(8, 5)).toMatchObject({ remaining: 0, fraction: 1 });
  });

  it("marks an unlimited resource", () => {
    const h = toHeadroom(999, Number.POSITIVE_INFINITY);
    expect(h.unlimited).toBe(true);
    expect(h.fraction).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm it fails, implement, render**

Run: `npx jest src/services/__tests__/usageService.test.ts` → FAIL, then implement.

Add four rows to `app/ai-usage.tsx` — boards, sessions this period, AI calls this period, collaborators — each showing used / limit and a bar. Add a "Manage billing" button **on web only** that calls `openBillingPortal`.

- [ ] **Step 3: Run and commit**

Run: `npx jest src/services/__tests__/usageService.test.ts` → PASS, 3 tests.

```bash
git add app/ai-usage.tsx src/services/usageService.ts src/services/__tests__/usageService.test.ts
git commit -m "feat(billing): show all plan resources and headroom on the usage page"
```

---

### Task 13: Pricing page (web)

**Gate: G4** — the displayed price is a business decision, not an engineering one.

**Files:**
- Create: `app/pricing.tsx`
- Create: `src/lib/pricingCopy.ts`

**Interfaces:**
- Consumes: `PLAN_LIMITS` (Task 2), `startCheckout` (Task 10).

Free tier shown first, honest copy, limits rendered **from `PLAN_LIMITS`** rather than retyped — a pricing page that disagrees with the enforced limits is worse than no pricing page.

- [ ] **Step 1: Write the test**

```tsx
it("renders every free-tier limit from the shared table", () => {
  const { getByText } = render(<Pricing />);
  expect(getByText(new RegExp(`${PLAN_LIMITS.free.boards} boards`, "i"))).toBeTruthy();
  expect(getByText(new RegExp(`${PLAN_LIMITS.free.sessionsPerPeriod} sessions`, "i"))).toBeTruthy();
});

it("lists the free tier before pro", () => {
  const { getAllByTestId } = render(<Pricing />);
  expect(getAllByTestId("plan-card").map((c) => c.props.accessibilityLabel))
    .toEqual(["Free", "Pro", "Edu"]);
});
```

- [ ] **Step 2: Implement, run, commit**

```bash
git add app/pricing.tsx src/lib/pricingCopy.ts src/lib/__tests__/pricingCopy.test.ts
git commit -m "feat(billing): add pricing page driven by the shared limits table"
```

---

# TRACK B — Product surfaces (all depend on Task 1)

### Task 14: Presenter mode

**Files:**
- Modify: `src/services/cursorService.ts` (extend `CursorPayload`)
- Modify: `src/hooks/useBoardCollab.ts` (Task 1)
- Create: `src/lib/presenter.ts`
- Create: `src/lib/__tests__/presenter.test.ts`
- Create: `src/components/board/PresentingBanner.tsx`

**Interfaces:**
- Consumes: `CursorPayload` (`{ displayName, x, y, tool, viewport?, following? }`), `toggleFollow` / `wouldCreateCycle` from `src/lib/followMode.ts`.
- Produces: `resolveViewportSource(cursors, selfUid, followingUid)` — the single precedence function Task 15 and the canvas both read.

Presenter is an **additional field on the existing ephemeral payload**, not a new channel. Add `presenting?: boolean` and `presenterPaused?: boolean`.

**Precedence rule to encode:** an active presenter overrides every individual follow choice; a paused presenter releases viewports but keeps the banner; with no presenter, individual follow applies; `wouldCreateCycle` still guards manual follow.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/presenter.test.ts
import { resolveViewportSource } from "../presenter";

const c = (uid: string, extra: object = {}) => ({ userId: uid, displayName: uid, x: 0, y: 0, tool: "pen", updatedAt: 0, ...extra });

describe("resolveViewportSource", () => {
  it("returns null when nobody presents and nobody is followed", () => {
    expect(resolveViewportSource([c("a"), c("b")], "a", null)).toBeNull();
  });

  it("follows the chosen user when there is no presenter", () => {
    expect(resolveViewportSource([c("a"), c("b")], "a", "b")).toBe("b");
  });

  it("lets an active presenter override an individual follow choice", () => {
    expect(resolveViewportSource([c("a"), c("b"), c("p", { presenting: true })], "a", "b")).toBe("p");
  });

  it("releases viewports when the presenter pauses", () => {
    const cursors = [c("a"), c("b"), c("p", { presenting: true, presenterPaused: true })];
    expect(resolveViewportSource(cursors, "a", "b")).toBe("b");
  });

  it("never makes the presenter follow themselves", () => {
    expect(resolveViewportSource([c("p", { presenting: true })], "p", null)).toBeNull();
  });

  it("ignores a stale presenter cursor", () => {
    // A cursor not refreshed within CURSOR_STALE_MS is already filtered by the
    // subscriber, so an empty list must not resurrect a presenter.
    expect(resolveViewportSource([], "a", "b")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm it fails, implement, then wire the UI**

Run: `npx jest src/lib/__tests__/presenter.test.ts` → FAIL.

Then: presenter toggle in the session header (host/owner only), non-presenter drawing disabled while an unpaused presenter is active, `<PresentingBanner />` for the audience, pause/resume.

- [ ] **Step 3: Verify write volume did not regress**

Adding two optional booleans must not change the 20 Hz write ceiling. Confirm `CURSOR_WRITE_INTERVAL_MS` is untouched and the fields are omitted when false (Firestore rejects `undefined`; the existing payload spreads conditionally — follow that pattern exactly).

- [ ] **Step 4: Run and commit**

Run: `npx jest src/lib src/services/__tests__/cursorService.test.ts` → PASS.

```bash
git add src/services/cursorService.ts src/lib/presenter.ts src/lib/__tests__/presenter.test.ts src/hooks/useBoardCollab.ts src/components/board/PresentingBanner.tsx
git commit -m "feat(collab): add presenter mode on the ephemeral cursor channel"
```

---

### Task 15: Laser pointer

**Files:**
- Modify: `src/services/cursorService.ts` (add `ping`)
- Create: `src/lib/laser.ts`, `src/lib/__tests__/laser.test.ts`
- Modify: `src/components/CursorLayer.tsx`, `src/lib/shortcuts.ts` (hotkey `L`)

**Interfaces:**
- Consumes: `CursorPayload` (Task 14 shape).
- Produces: `activeTrail(pings, now)` → the points still within the fade window.

**The laser must never persist.** It writes only to the cursor channel and never touches the path collection. A test asserts this.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/laser.test.ts
import { activeTrail, LASER_FADE_MS } from "../laser";

describe("activeTrail", () => {
  it("keeps points inside the fade window", () => {
    const pings = [{ x: 1, y: 1, t: 900 }, { x: 2, y: 2, t: 1000 }];
    expect(activeTrail(pings, 1000)).toHaveLength(2);
  });

  it("drops points past the fade window", () => {
    const pings = [{ x: 1, y: 1, t: 0 }, { x: 2, y: 2, t: 1000 }];
    expect(activeTrail(pings, 1000 + LASER_FADE_MS + 1)).toHaveLength(0);
  });

  it("fades opacity from 1 to 0 across the window", () => {
    const [p] = activeTrail([{ x: 0, y: 0, t: 1000 }], 1000);
    expect(p.opacity).toBeCloseTo(1, 2);
    const [q] = activeTrail([{ x: 0, y: 0, t: 1000 }], 1000 + LASER_FADE_MS / 2);
    expect(q.opacity).toBeCloseTo(0.5, 1);
  });

  it("returns an empty trail for no pings", () => {
    expect(activeTrail([], 0)).toEqual([]);
  });
});
```

`LASER_FADE_MS = 2000` per the spec ("fades after 2 seconds").

- [ ] **Step 2: Implement, then assert non-persistence**

```ts
// add to src/services/__tests__/cursorService.test.ts
it("never writes a laser ping to the path collection", async () => {
  const { addDoc } = require("firebase/firestore");
  publishCursor("b1", "u1", { displayName: "U", x: 0, y: 0, tool: "laser", ping: { x: 0, y: 0, t: 0 } });
  expect(addDoc).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run and commit**

```bash
git add src/lib/laser.ts src/lib/__tests__/laser.test.ts src/services/cursorService.ts src/components/CursorLayer.tsx src/lib/shortcuts.ts
git commit -m "feat(collab): add ephemeral laser pointer on the cursor channel"
```

---

### Task 16: Voice notes

**Files:**
- Create: `src/services/audioService.ts`, `src/services/__tests__/audioService.test.ts`
- Modify: `src/types/index.ts` (`AudioElement`), `package.json` (`expo-audio`)
- Create: `src/components/board/AudioAffordance.tsx`

**Interfaces:**
- Produces: `AudioElement` (`schemaVersion: 1`, `anchorElementId`, `storagePath`, `downloadUrl`, `durationMs`, `x`, `y`).

**`expo-av` does not exist in SDK 55** — use `expo-audio`'s `useAudioRecorder`. 60s cap, AAC/m4a.

**⚠️ Known defect this task must confront:** the M2 carry-forward *"Storage objects orphaned on group-delete/clear-board"* is already real, and audio makes it louder and costlier. **Either fix the orphan path here or record an explicit written decision to defer it** — do not inherit it silently. Recommendation: fix it, because audio is the first Storage object a user will notice paying for.

- [ ] **Step 1: Write the failing test** — cover the 60s cap, the storage path shape, and **deletion of the Storage object when the element is deleted**.

```ts
it("rejects a recording longer than the cap", async () => {
  await expect(saveVoiceNote({ boardId: "b1", anchorElementId: "e1", uri: "file://x", durationMs: 61_000 }))
    .rejects.toThrow(/60/);
});

it("deletes the storage object when the element is deleted", async () => {
  await deleteVoiceNote("b1", "audio1");
  expect(deleteObject).toHaveBeenCalled();
});
```

- [ ] **Step 2: Install, implement, run, commit**

Run: `npx expo install expo-audio`

```bash
git add src/services/audioService.ts src/services/__tests__/audioService.test.ts src/types/index.ts src/components/board/AudioAffordance.tsx package.json package-lock.json
git commit -m "feat(canvas): add voice notes anchored to elements"
```

---

### Task 17: Colour + stroke polish, eyedropper

**Files:** `src/components/PenOptionsBar.tsx`, `src/components/ShapeOptionsBar.tsx`, `src/lib/color.ts` (+ tests), `src/services/workspaceService.ts` (swatch palette).

Hex + alpha picker, recent-colours row, per-workspace swatches, 6 stroke widths + continuous slider, eyedropper (samples via hit-test — reuse `src/lib/hitTest.ts`, do not add a new picking path), highlighter (multiply blend), marker, calligraphy.

- [ ] **Step 1: Test the colour model round-trip**

```ts
it("round-trips hex+alpha", () => {
  expect(toHex8(fromHex8("#3366ffcc"))).toBe("#3366ffcc");
});
it("clamps alpha out of range", () => {
  expect(fromHex8("#3366ff").a).toBe(1);
});
it("rejects malformed input without throwing", () => {
  expect(fromHex8("nonsense")).toBeNull();
});
```

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat(canvas): custom colour picker, stroke widths, eyedropper and pen variants"
```

---

### Task 18: Onboarding tutorial + empty states

**Files:** `src/components/onboarding/` (+ tests), `app/(tabs)/index.tsx`.

**Build the tutorial once, here.** ROADMAP M6 A6 re-specifies the same 90-second walkthrough; that task is reduced to seeding (Task 28). Steps: draw → shape → invite → schedule session → end session → see AI summary. Empty-state CTAs point at value ("Schedule your first study session →", never "you have 0 boards").

- [ ] **Step 1: Test that the tutorial is shown once and is skippable**

```ts
it("shows on first run and not after completion", async () => { /* AsyncStorage flag */ });
it("is skippable at every step", () => { /* each step exposes a skip control */ });
```

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat(onboarding): add first-run tutorial and value-oriented empty states"
```

---

# TRACK C — Embeds and the meeting integration

### Task 19: Editable embed token (v2 + host-asserted identity)

**Files:**
- Modify: `functions/src/embed/token.ts`, `functions/src/callable/mintEmbedToken.ts`, `functions/src/callable/exchangeEmbedToken.ts`
- Modify: `functions/src/__tests__/embedToken.test.ts`
- Modify: `firestore.rules`, `firestore-tests/firestore.rules.test.js`

**Interfaces:**
- Consumes: `EmbedTokenPayload` = `{ v, boardId, scope, iat, exp }`, `EMBED_TOKEN_VERSION = 1`, `EMBED_TOKEN_TTL_SECONDS = 3600`, and the existing `bad-version` rejection path.
- Produces: `EmbedTokenPayload` v2 with `sub` (host-asserted subject) and `iss` (issuing host). Tasks 20 and 33 both depend on this.

**This is a security boundary, not plumbing.** Today's payload carries **no user identity** — fine for read-only, fatal for editable: every write from inside a host panel would be unattributable, presence anonymous, comments and activity author-less.

Bump `EMBED_TOKEN_VERSION` to `2`. **v1 tokens must still verify for `scope: "view"`** so existing embeds do not break; a v1 token requesting `edit` is rejected.

- [ ] **Step 1: Write the failing tests — every forgery case**

```ts
describe("embed token v2", () => {
  it("mints an edit token carrying the subject", () => {
    const { token } = mintEmbedToken({ boardId: "b1", scope: "edit", sub: "host:u9", iss: "meet", secret: S, nowMs: T });
    expect(verifyEmbedToken(token, S, T).payload).toMatchObject({ v: 2, sub: "host:u9", iss: "meet" });
  });

  it("still accepts a v1 view token", () => {
    expect(verifyEmbedToken(v1ViewToken, S, T).ok).toBe(true);
  });

  it("rejects a v1 token that requests edit", () => {
    expect(verifyEmbedToken(v1EditToken, S, T).error).toBe("bad-version");
  });

  it("rejects an edit token with no subject", () => {
    expect(verifyEmbedToken(editTokenNoSub, S, T).error).toBe("bad-payload");
  });

  it("rejects a token signed with the wrong secret", () => {
    expect(verifyEmbedToken(token, "wrong-secret", T).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    expect(verifyEmbedToken(token, S, T + EMBED_TOKEN_TTL_SECONDS * 1000 + 1).error).toBe("expired");
  });

  it("rejects a token whose boardId was tampered with", () => {
    expect(verifyEmbedToken(tamperedBoardId, S, T).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Rules tests for the edit identity**

```js
it("lets an edit-scoped embed identity write to its own board", async () => { /* assertSucceeds */ });
it("denies an edit-scoped embed identity writing to a different board", async () => { /* assertFails */ });
it("denies a view-scoped embed identity writing at all", async () => { /* assertFails */ });
```

- [ ] **Step 3: Implement, run both suites, commit**

The exchange maps `sub` → a stable B.O.A.R.D uid so writes attribute correctly in presence, comments and the activity feed.

Run: `npm --prefix functions test -- embedToken.test.ts` and `npm run test:rules` → PASS.

```bash
git commit -m "feat(embed): add editable embed scope with host-asserted identity"
```

---

### Task 20: Google Meet add-on shell

**Gate: G6** for submission; implementation is unblocked.

**Files:** `web/meet-addon/` (manifest + side-panel HTML), `app/embed/b/[id].tsx` (accept `scope=edit`).

Thin iframe shell around the Task 19 editable embed. **Submit to the Workspace Marketplace in week 1** — the queue, not the code, is the long pole. Ship an unlisted manual-install build in parallel so launch never gates on approval.

- [ ] Implement, verify a second user can edit from inside a Meet panel with correct attribution, commit.

---

# TRACK D — M6a: instrument, sharpen, launch

### Task 21: Analytics seam + event taxonomy

**Gate: G5.**

**Files:** `src/services/analyticsService.ts` (+ tests), `app/_layout.tsx`, `package.json`.

**Interfaces:**
- Produces: `track(event, props?)`, `identifyWorkspace(workspaceId, role)`. **Every call site goes through this seam** — same discipline as `src/lib/errorReporting.ts`, so the vendor is one file.

**This task ships before every other M6 task.** Instrumentation added after the features it measures leaves the launch with no baseline, and the month exists to produce an attributable number.

Events: `signup`, `workspace_created`, `board_created`, `session_scheduled`, `session_completed`, `ai_summary_generated`, `upgrade_viewed`, `upgrade_completed`, plus one install event per integration surface.

- [ ] **Step 1: Write the failing test — including the no-PII guard**

```ts
it("hashes the workspace id rather than sending it raw", () => {
  identifyWorkspace("ws-secret-id", "owner");
  expect(JSON.stringify(capture.mock.calls)).not.toContain("ws-secret-id");
});

// The compliance guard. Student rosters flow through this app (Task 27).
it("strips anything email-shaped from event properties", () => {
  track("board_created", { who: "student@university.edu" } as never);
  expect(JSON.stringify(capture.mock.calls)).not.toMatch(/@/);
});

it("no-ops without a configured key rather than throwing", () => {
  expect(() => track("signup")).not.toThrow();
});

it("only emits events from the documented taxonomy", () => {
  expect(() => track("made_up_event" as never)).toThrow();
});
```

- [ ] **Step 2: Install, implement, run, commit**

Run: `npx expo install posthog-react-native` and `npm install posthog-js`

```bash
git commit -m "feat(analytics): add PostHog seam with hashed identifiers and event taxonomy"
```

---

### Task 22: Template library + gallery

**Files:** `src/templates/*.json` (20 files), `src/services/templateService.ts` (+ tests), new-board gallery UI.

**Batch this as one dispatch** — the 20 JSON files are same-shape mechanical work.

Groups per spec: **Study** (Cornell notes, flashcard deck, mind-map, spaced-repetition planner, exam-review grid, study-streak tracker); **CS/engineering** (sprint planner, code-review checklist, system-design canvas, design-doc structure, sequence-diagram canvas, ERD canvas); **Classroom** (lab-report, lecture-notes, group-brainstorm zones, peer-review, weekly Kanban); **Meeting** (retro, 1:1 agenda, standup, decision log).

Each file carries `schemaVersion: 1`.

- [ ] **Step 1: The test that stops silent rot**

```ts
it("every template parses into a valid board", () => {
  const dir = path.join(__dirname, "../../templates");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThanOrEqual(15);
  for (const f of files) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    expect(t.schemaVersion).toBe(1);
    expect(typeof t.title).toBe("string");
    expect(Array.isArray(t.elements)).toBe(true);
    for (const el of t.elements) {
      expect(["path", "shape", "text", "note", "image"]).toContain(el.type);
    }
  }
});
```

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat(templates): add template library with gallery and validity test"
```

---

### Task 23: SVG export serializer

**Files:** `src/lib/svgExport.ts` (+ tests).

**The cheapest item in the month** — the board *is* an SVG tree, so this is a pure serializer over the element union with no new rendering path.

- [ ] **Step 1: Write the failing test — one case per element kind**

```ts
it("serializes a path element", () => {
  expect(toSvgDocument([pathEl], bounds)).toContain("<path");
});
it("serializes every element kind without throwing", () => {
  for (const el of [pathEl, shapeEl, textEl, noteEl, imageEl]) {
    expect(() => toSvgDocument([el], bounds)).not.toThrow();
  }
});
it("escapes text content", () => {
  expect(toSvgDocument([{ ...textEl, text: "a<b&c" }], bounds)).toContain("a&lt;b&amp;c");
});
it("sets a viewBox from the content bounds", () => {
  expect(toSvgDocument([pathEl], { x: 10, y: 20, width: 30, height: 40 }))
    .toContain('viewBox="10 20 30 40"');
});
it("produces a valid empty document for no elements", () => {
  expect(toSvgDocument([], bounds)).toMatch(/^<svg[\s\S]*<\/svg>$/);
});
```

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat(export): add SVG board serializer"
```

---

### Task 24: PNG + PDF export with tiling

**Files:** `src/lib/pdfTiling.ts` (+ tests), `src/utils/recapExport.ts` (extend), `src/utils/canvasCapture.ts`.

**⚠️ Check the M4 finding before starting.** PNG export on native rides the same `react-native-svg` `toDataURL` path whose `<Image href>` rendering is the open Month 4 question (ROADMAP § Month 4, remaining item 5). If closeout found images do not render, PNG export inherits that bug — record it and export SVG/PDF on native instead of shipping a silently broken PNG.

- [ ] **Step 1: Test the tiling math**

```ts
it("returns one page for content smaller than a page", () => {
  expect(tilePages({ width: 500, height: 500 }, A4)).toHaveLength(1);
});
it("tiles a wide board across columns", () => {
  const pages = tilePages({ width: 2000, height: 500 }, A4);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.every((p) => p.width <= A4.width)).toBe(true);
});
it("covers the full board with no gaps", () => {
  const pages = tilePages({ width: 2000, height: 1500 }, A4);
  const covered = pages.reduce((a, p) => a + p.width * p.height, 0);
  expect(covered).toBeGreaterThanOrEqual(2000 * 1500);
});
```

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat(export): add PNG and multi-page PDF board export"
```

---

### Task 25: Reactions

**Files:** `src/services/reactionService.ts` (+ tests), `firestore.rules`, `firestore-tests/`, `src/components/board/ReactionBadge.tsx`.

Reuse the **`Comment.anchorElementId` + `CommentAnchorKind` precedent** rather than inventing an anchoring scheme. Reactions: 👍 ❤️ ❓ ⭐ 💡, counts on the element corner.

Storage: `boards/{id}/reactions/{elementId}_{emoji}_{uid}` — **the document id is the uniqueness constraint**, so one user cannot double-react.

- [ ] **Step 1: Rules tests**

```js
it("lets a board commenter react", async () => { /* assertSucceeds */ });
it("denies a viewer reacting", async () => { /* assertFails */ });
it("denies reacting as another user", async () => { /* assertFails — uid segment must match auth */ });
```

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat(collab): add element-anchored reactions"
```

---

### Task 26: Polls + quiz mode

**Files:** `src/services/pollService.ts` (+ tests), `src/types/index.ts` (`PollElement`), `firestore.rules`, `firestore-tests/`.

**Votes are persisted, not ephemeral** — they must survive a refresh, so they never ride the cursor side channel (that channel is explicitly for data safe to drop).

`PollElement`: `schemaVersion: 1`, `question`, `options[]` (2–6), `anonymous: boolean`, `x`, `y`. Votes at `boards/{id}/polls/{pollId}/votes/{uid}` — **document id is the uid**, which is what enforces one-vote-per-user.

**Anonymous mode still stores the uid** (it must, to dedupe). Keep it out of every client-readable path, and say so plainly in the UI: anonymous to other users, not to the system.

- [ ] **Step 1: Rules + service tests**

```js
it("allows one vote per user per poll", async () => { /* second write to same doc = update, still one row */ });
it("denies voting as another user", async () => { /* assertFails */ });
it("denies a non-member voting", async () => { /* assertFails */ });
it("hides voter identity from members in anonymous mode", async () => { /* assertFails on votes read */ });
```

- [ ] **Step 2: Implement quiz sequencing + dot-voting variant, run, commit**

```bash
git commit -m "feat(collab): add polls, quiz mode and dot voting"
```

---

### Task 27: Education — invite-based enrollment + instructor grid

**Files:** `src/services/classroomService.ts` (+ tests), `firestore.rules`, instructor grid screen.

**Reshaped from the spec's CSV import, deliberately.** A roster CSV is bulk PII for people who never signed up; under-13 users invoke COPPA's verifiable-parental-consent requirement, which a CSV import cannot provide. **Invite-based self-enrollment is both less engineering and less exposure** — students enroll with their own accounts, consent implicit in signup. University-level only; K-12 explicitly out of scope.

- [ ] **Step 1: Rules tests — the isolation property that matters**

```js
it("denies a student reading another student's assignment board", async () => { /* assertFails */ });
it("lets the instructor read every assignment board in the class", async () => { /* assertSucceeds */ });
it("denies an instructor of class A reading class B", async () => { /* assertFails */ });
```

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat(edu): add invite-based class enrollment and instructor grid"
```

---

### Task 28: Sample workspace seeding

**Files:** `src/services/onboardingService.ts` (+ tests).

Seed a sample workspace on signup: an example study board (from a Task 22 template), a finished session with an AI summary, a mock roster. **The tutorial itself is Task 18** — this is seeding only.

- [ ] Test that a new signup lands in a populated workspace, never a zero state. Implement, run, commit.

---

# TRACK E — M6b: post-launch scope

> **Controller note:** the spec deliberately places this track *after* the launch so its scope is chosen from launch data rather than from this document's ordering. If launch traffic contradicts the ordering below, that is the system working — reorder and record a ruling.

### Task 29: SM-2 scheduling library

**Files:** `src/lib/sm2.ts`, `src/lib/__tests__/sm2.test.ts`.

**Interfaces:**
- Produces: `review(card, quality, now)` → next `{ repetitions, intervalDays, easeFactor, dueAtMs }`. Task 30 consumes it.

Pure arithmetic, no I/O, ~40 lines. The SuperMemo SM-2 algorithm: quality 0–5; quality < 3 resets repetitions to 0 and interval to 1; ease factor updates by `EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))`, floored at 1.3; intervals go 1 day, 6 days, then `previous * EF`.

- [ ] **Step 1: Write the full state-transition table as the test**

```ts
import { review, INITIAL_CARD, MIN_EASE } from "../sm2";

const T = 1_760_000_000_000;
const DAY = 86_400_000;

describe("SM-2", () => {
  it("schedules a first successful review one day out", () => {
    const c = review(INITIAL_CARD, 5, T);
    expect(c.repetitions).toBe(1);
    expect(c.intervalDays).toBe(1);
    expect(c.dueAtMs).toBe(T + DAY);
  });

  it("schedules the second successful review six days out", () => {
    const c = review(review(INITIAL_CARD, 5, T), 5, T);
    expect(c.repetitions).toBe(2);
    expect(c.intervalDays).toBe(6);
  });

  it("multiplies by the ease factor from the third review on", () => {
    let c = review(review(review(INITIAL_CARD, 5, T), 5, T), 5, T);
    expect(c.repetitions).toBe(3);
    expect(c.intervalDays).toBe(Math.round(6 * c.easeFactor));
  });

  it("resets repetitions and interval on a failed review", () => {
    const good = review(review(INITIAL_CARD, 5, T), 5, T);
    const bad = review(good, 2, T);
    expect(bad.repetitions).toBe(0);
    expect(bad.intervalDays).toBe(1);
  });

  it("keeps the ease factor when a card is failed but does not raise it", () => {
    const good = review(INITIAL_CARD, 5, T);
    expect(review(good, 2, T).easeFactor).toBeLessThanOrEqual(good.easeFactor);
  });

  it("never lets the ease factor fall below the floor", () => {
    let c = INITIAL_CARD;
    for (let i = 0; i < 20; i++) c = review(c, 3, T);
    expect(c.easeFactor).toBeGreaterThanOrEqual(MIN_EASE);
  });

  it("raises the ease factor on a perfect review", () => {
    expect(review(INITIAL_CARD, 5, T).easeFactor).toBeGreaterThan(INITIAL_CARD.easeFactor);
  });

  it("rejects a quality outside 0-5", () => {
    expect(() => review(INITIAL_CARD, 6 as never, T)).toThrow();
    expect(() => review(INITIAL_CARD, -1 as never, T)).toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm it fails, implement, run, commit**

Run: `npx jest src/lib/__tests__/sm2.test.ts` → FAIL, then PASS with 8 tests.

```bash
git add src/lib/sm2.ts src/lib/__tests__/sm2.test.ts
git commit -m "feat(study): add SM-2 spaced-repetition scheduling"
```

---

### Task 30: Flashcard generation + review surface

**Files:** `functions/src/callable/generateFlashcards.ts` (+ tests), `src/services/flashcardService.ts` (+ tests), review screen.

**Interfaces:** consumes `review` (Task 29), the M4 gateway shape (`handleX` + `onCall`), `recordAiUsage` with `feature: "flashcards"`, and the `ocrCache.ts` hash-memoization pattern.

**The AI half is the easy half.** The cost here is a *second app surface*: a review screen, per-user scheduling, and a due-cards query. Scheduling is **per-user** (`users/{uid}/decks/{deckId}/cards/{cardId}`) because two students studying the same board have different schedules — never board-scoped.

**Anki `.apkg` export is cut** (SQLite-in-a-zip, a genuine time sink). Ship **CSV export**, which Anki imports natively.

- [ ] Test generation memoization (same selection hash ⇒ no second provider call), the due-cards query, and CSV escaping. Implement, run, commit.

---

### Task 31: Board Q&A — embedding write path

**Files:** `functions/src/ai/embeddings.ts` (+ tests), `firestore.rules`, `firestore-tests/`.

**Interfaces:**
- Produces: `boards/{id}/embeddings/{elementId}` = `{ vector: FieldValue.vector([...]), text, elementType, contentHash, updatedAt }`. Task 32 queries it.

**Firestore KNN vector search is GA** — no external vector store. `text-embedding-3-small` is 1536 dimensions, inside the 2048 cap.

Embed on write, debounced; **skip when `contentHash` is unchanged** — the `ocrCache.ts` discipline. The skip rate is what makes this affordable; verify it in the usage log before opening the feature up.

- [ ] **Step 1: Test the skip logic and the rules lock**

```ts
it("skips re-embedding when the content hash is unchanged", async () => {
  await embedElement(db, "b1", el, provider);
  await embedElement(db, "b1", el, provider);
  expect(provider.embed).toHaveBeenCalledTimes(1);
});
it("re-embeds when the text changes", async () => { /* 2 calls */ });
```

```js
it("denies a client write to embeddings", async () => { /* assertFails */ });
```

- [ ] **Step 2: Implement, add the vector index to `firestore.indexes.json`, run, commit**

```bash
git commit -m "feat(ai): add per-element embedding write path for board Q&A"
```

---

### Task 32: Board Q&A — retrieval + chat

**Files:** `functions/src/callable/askBoard.ts` (+ tests), `src/services/boardQaService.ts` (+ tests), sidebar chat panel.

**⚠️ This is the first *unbounded* AI feature in the product.** Summaries fire once per session; chat fires as often as someone types, and embeddings re-run on every meaningful edit to a chatty board. It therefore needs:
1. **Its own rate-limit bucket** — `consumeToken(db, bucketKey, now, config)` already accepts a `BucketConfig`; pass a tighter one rather than sharing the default bucket with summaries.
2. **Its own line in the plan-limits table** (Task 2) — add `boardQaPerPeriod` there and gate it in this handler.

Without both, one enthusiastic free-tier user outspends a paying one.

Retrieval: `findNearest` filtered by board, top-k into `gpt-4o-mini`; meter with `feature: "boardQa"` so it appears on the existing usage page automatically.

- [ ] **Step 1: Test the gate before the provider call**

```ts
it("refuses when the workspace is over its Q&A quota", async () => {
  await expect(handleAskBoard(req, depsOverQuota, T)).rejects.toThrow(/limit/i);
  expect(depsOverQuota.provider.chat).not.toHaveBeenCalled();
});
it("uses a tighter bucket than summaries", () => {
  expect(QA_BUCKET.capacity).toBeLessThan(DEFAULT_BUCKET.capacity);
});
it("returns an answer with the elements it cited", async () => { /* citations present */ });
```

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat(ai): add board Q&A retrieval with its own quota and rate bucket"
```

---

### Task 33: Browser extension (Chrome + Edge)

**Gate: G6.** Depends on Task 19 — **if the editable embed did not ship, this is view-only and much less compelling.**

**Files:** `web/extension/` (Manifest V3, side panel, content script).

Side panel wrapping the M4 embed; drag-an-image-from-any-page onto the board; "send this page to a board" action.

**LTI 1.3 is explicitly not this task** and moves to M7+: it needs OIDC third-party-initiated login, JWKS rotation, Deep Linking 2.0, Assignment & Grade Services passback, and Names & Roles, plus a partner application and an LMS admin — paperwork on a timeline nobody here controls.

- [ ] Implement, load unpacked, verify drag-to-board across two users, commit.

---

### Task 34: Camera capture + OCR (descoped scanner)

**Files:** `src/services/scanService.ts` (+ tests), capture affordance in the board `+` menu.

**⚠️ `expo-document-scanner` does not exist** — the spec names a package that was never published. ML Kit's document scanner is **Android-only** (Google ships no iOS module); iOS needs VisionKit separately; wrappers covering both need a config plugin and an EAS build and none work in Expo Go.

**Descoped to capture + crop + OCR**, which delivers the actual use case ("snap a textbook page, drop it on the board, AI explains it") with **zero new native dependencies**: `expo-image-picker` is already a dependency and already opens the camera; run the result through the existing M4 OCR pipeline. True auto-edge-detection is M7 polish.

- [ ] Test that capture produces an `ImageElement` and that OCR routes through the existing pipeline. Implement, run, commit.

---

### Task 35: Math elements (MathJax → SVG)

**Files:** `functions/src/callable/renderMath.ts` (+ tests), `src/types/index.ts` (`MathElement`), `src/components/board/MathElementView.tsx`, `functions/package.json`.

**KaTeX cannot render here.** It emits DOM HTML and the board is a `react-native-svg` tree with no DOM on native. **Do not reach for a WebView** — a WebView per equation is unusable at thirty equations on a board, and it opts the element out of selection, transform, export and print.

Render LaTeX to **SVG path data** with `mathjax-full`'s SVG output, in a callable, cached by hash exactly like `ocrCache.ts`:

```ts
export interface MathElement {
  schemaVersion: 1;
  type: "math";
  latex: string;      // editable source of truth
  svgPath: string;    // rendered output, cached
  width: number; height: number;
  x: number; y: number; scale: number;
}
```

Re-render only when `latex` changes. The element then renders as ordinary `<Path>` nodes — so it transforms, exports to PNG/SVG/PDF, prints and gets selected for free.

- [ ] **Step 1: Test determinism and the cache**

```ts
it("renders the same path data for the same latex", async () => {
  expect((await renderMath("x^2")).svgPath).toBe((await renderMath("x^2")).svgPath);
});
it("does not call the renderer twice for a cached expression", async () => { /* 1 call */ });
it("returns a structured error for malformed latex rather than throwing", async () => {
  await expect(renderMath("\\frac{")).resolves.toMatchObject({ error: expect.any(String) });
});
```

- [ ] **Step 2: Install `mathjax-full` in functions, implement, run, commit**

```bash
git commit -m "feat(canvas): add math elements rendered as native SVG paths"
```

---

### Task 36: Code elements (Shiki tokenizer)

**Files:** `src/lib/codeRender.ts` (+ tests), `src/types/index.ts` (`CodeElement`), `src/components/board/CodeElementView.tsx`.

**Use Shiki's tokenizer, not its HTML renderer.** `codeToTokens()` returns `{ content, color }` runs rather than HTML; render those as `<TSpan>` runs inside an SVG `<Text>`, one line per `dy`. ~150 lines, single cross-platform code path.

**Bundle only these grammars:** `ts`, `js`, `py`, `java`, `c`, `cpp`, `sql`, `json`, `bash`. The full grammar set is a large mobile bundle cost for no benefit.

- [ ] Test tokenization per supported language, line layout, and the element-level "copy code" action. Implement, run, commit.

---

### Task 37: Sticky-note polish

**Files:** `src/components/TextNoteOverlay.tsx`, `src/lib/markdown.ts` (+ tests).

8 colours, 3 sizes, markdown rendering (bold, italic, lists, links), pin-to-position or attach-to-element. **Batch as one dispatch** — mechanical. Lowest priority in the plan; cut first if time runs out.

- [ ] Test markdown rendering and attachment persistence. Implement, run, commit.

---

# Cross-cutting verification

Run before declaring the plan complete. **Every number is a floor, not a target** — none of these may regress.

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx jest --ci` — ≥ 44 suites, ≥ 512 tests, all passing
- [ ] `npm --prefix functions test` — ≥ 10 suites, ≥ 109 tests, all passing
- [ ] `npm run test:rules` — ≥ 2 suites, ≥ 83 tests, all passing
- [ ] `npm run test:coverage` — 60% global gate on `src/services/**` still met
- [ ] `npm --prefix functions run build` — clean

**The bypass test (manual, non-negotiable — this is what the whole spine exists for).** With a free workspace already at 5 boards, attempt a board create *outside the app*: a direct Firestore REST write with a valid auth token. **It must be denied.** A UI that hides the button is not enforcement. Repeat for a 4th session in the period and a 5th collaborator via the invite-code self-join path.

**Stripe round-trip (manual, G3).** Upgrade with `4242 4242 4242 4242` → `workspace.plan == 'pro'`; cancel via the portal → plan reverts → the gate re-engages. Both directions.

**Store-compliance check (manual).** Build the native bundle and confirm the upsell surface contains no price and no checkout link. Task 11's test guards this in CI; verify once on a real build.

**Mobile parity + perf (manual, G7).** Every new surface on a real mid-range Android against `docs/perf-baseline.md`. Watch cursor write volume with presenter + laser active — that is the combination most likely to push the M4 channel over budget.

---

# Plan Self-Review

Run against the spec before execution.

**Spec coverage** — every ROADMAP M5 item 1–14 and M6 item A1–B6 maps to a task:

| Spec item | Task |
|---|---|
| M5-1 Stripe | 8, 9, 10 |
| M5-2 Plan gating | 2, 3, 4, 5, 6, 7 |
| M5-3 Usage dashboard | 12 |
| M5-4 Onboarding | 18 |
| M5-5 Pricing page | 13 |
| M5-6 Meeting integration | 19, 20 |
| M5-7 Presenter | 14 |
| M5-8 Laser | 15 |
| M5-9 Voice notes | 16 |
| M5-10 Math *(moved to M6)* | 35 |
| M5-11 Code blocks *(moved to M6)* | 36 |
| M5-12 Colour polish | 17 |
| M5-13 Sticky polish *(moved to M6)* | 37 |
| M5-14 Upsell surfaces | 11 |
| M5 prerequisite: decomposition | 1 |
| M6-A1 Analytics | 21 |
| M6-A2 Templates | 22 |
| M6-A3 Export | 23, 24 |
| M6-A4 Reactions + polls | 25, 26 |
| M6-A5 Education | 27 |
| M6-A6 Seeding | 28 |
| M6-A7 Content + launch | **G8 — no code deliverable** |
| M6-B1 Flashcards | 29, 30 |
| M6-B2 Board Q&A | 31, 32 |
| M6-B3 Extension | 33 |
| M6-B4 Camera | 34 |
| M6-B5/B6 Carried M5 items | 35, 36, 37 |

**Known gaps, stated rather than hidden:**
- **Tasks 20, 33 have no test steps.** They are browser/marketplace shells whose verification is manual installation. That is a real limitation of this plan, not an oversight.
- **Tasks 16–18, 22, 25–28, 30, 33–37 carry test *intent* and representative assertions rather than complete literal test bodies.** Writing every line for 37 tasks would require reading files this plan's author has not read, and inventing signatures is worse than naming the behaviour precisely. **Implementers must write the tests from the stated behaviour, and reviewers must check the behaviour, not a transcription.** Tasks 1–15, 19, 21, 23, 24, 29, 31, 32, 35 carry literal code.
- **Task 1 is a refactor with a mechanical gate rather than new tests** — deliberately: its correctness criterion is that no test changes.

**Type consistency check:** `PLAN_LIMITS` / `limitFor` / `LimitedResource` (Task 2) are used identically in Tasks 3, 4, 5, 6, 7, 11, 12, 13, 32. `currentPeriod` is imported from `functions/src/ai/usage.ts` in Tasks 3 and 6, never redefined. `CursorPayload` extensions in Tasks 14 and 15 are additive to the same interface. `generateInviteCode` is defined once in Task 5 and imported by Task 6. `EmbedTokenPayload` v2 (Task 19) is consumed by Tasks 20 and 33.

**One deliberate duplication:** seat-cap numbers exist in both `functions/src/billing/limits.ts` and `firestore.rules`, because rules cannot import TypeScript. Task 7 adds a drift-detecting test rather than pretending the duplication is not there.

---

# Execution Handoff

**Recommended: Subagent-Driven** (superpowers:subagent-driven-development) — fresh implementer per task, task review after each, broad review at the end.

**Before dispatching Task 1, the controller should:**
1. Confirm **G1 (Month 4 closed)**. This plan assumes a deployed `functions/`; without it, Tasks 5–10 cannot be verified end-to-end even though they can be written and unit-tested.
2. Run the pre-flight conflict scan the skill requires, paying attention to: Tasks 5/6/7 (shared `firestore.rules` and the create path), Tasks 14/15 (shared `CursorPayload`), Tasks 2/7 (the deliberate limits duplication), and Tasks 23/24 (shared export path).
3. Note that **Tasks 19, 21, 23, 29, 31 have no dependencies** — they are the fillers whenever a human gate parks the monetization spine, which is likely, since G3 depends on a Stripe account existing.

**Suggested branch:** `feature/month-5-monetization` for Tasks 1–20, `feature/month-6-growth` for Tasks 21–37. Both already exist off `main`. Task 1 is shared infrastructure — **land it on `main` first**, or Track D/E will conflict with Track B over the board screen.



