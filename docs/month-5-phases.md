# Month 5 — Monetization Infrastructure: Phased Implementation Plan

**Author:** Arlo Kharod
**Drafted:** 2026-09-01
**Branch:** `feature/month-5-monetization` (off `main`)
**Source scope:** `ROADMAP.md` § Month 5 (items 1–14, as revised 2026-09-01), Appendix C (collaboration), Appendix E (education pricing).
**Status:** Planning draft — sequencing + per-phase contracts, not yet implemented.

> **How to read this:** Month 5 is the month the product can take money. The work
> splits into three tracks that run in parallel after a shared prerequisite:
> **(A) the monetization spine** — counters, enforcement, Stripe, gating, dashboard;
> **(B) product surfaces** — presenter, laser, voice notes, polish, onboarding;
> **(C) the meeting integration**, whose real content is the editable embed.
> Phases are ordered by dependency, not by roadmap item number; the roadmap item
> each phase satisfies is called out so nothing is dropped.

> **Hard prerequisite — Month 4 must be closed first.** Stripe webhooks need the
> same deployed `functions/` codebase that M4 never deployed, and you cannot set
> prices against an AI unit cost you have never measured. See ROADMAP.md § 9.

---

## Executive summary — four corrections to the roadmap

Three roadmap instructions are wrong or unbuildable as written, and one item has no
home in the plan at all. All four are folded into the phases below.

| # | Roadmap said | Reality | Lands in |
|---|---|---|---|
| 1 | *"Use Firebase's official Stripe extension (it is — `firestore-stripe-payments`). This saves 1-2 weeks."* | Stripe archived the repo and handed it to Invertase, and **Firebase Extensions shuts down 2027-03-31**. Adopting it installs a dependency that dies ~5 months later. Its premise — "you don't have a backend" — stopped being true in M4. | Phase 3 |
| 2 | *"`checkQuota` from Month 3 becomes a real gate."* | It's a client-side call in front of a direct client `addDoc`. Making it real is an **architecture change**. | Phases 1–2 |
| 3 | *"KaTeX is small, fast, fully client-side"* / *"Render with Shiki"* | Both emit **DOM HTML**; the board is a `react-native-svg` tree with no DOM on native. | **Moved to M6** |
| 4 | — | `app/board/[id].tsx` is 3,894 lines / 142 hooks, and five M5 items land in it. | Phase 0 |

**Scheduling consequence:** the month is under-scoped by roughly two weeks — one
for Stripe plumbing assumed free, one for the enforcement architecture. Moving
roadmap items 10, 11 and 13 (math, code blocks, sticky polish) to M6 pays for it.
**If the month still slips, cut Phase 8, then Phase 7 — never Phases 1–2.** Shipping
Stripe without enforcement means a paid tier anyone can have for free.

---

## Investigation: current state by layer

Verified against `main` at `9825bbb`. Full suite green locally 2026-09-01:
`tsc` clean, app 44 suites / 512 tests, `functions` 10 / 109, `test:rules` 2 / 83.

### Current behavior and where it's implemented

- **No billing exists.** A repo-wide grep for `stripe|posthog|katex|shiki|presenter|laser`
  returns one hit — a comment in `quotaService.ts` saying "no Stripe this month."
- **`plan` is already plumbed and is the one pre-built piece.** `Plan = "free" | "pro" | "edu"`
  (`src/types/index.ts:38`) sits on `Workspace.plan`, is written `'free'` by both
  signup and the Phase 9 migration, and **is read by nothing**.
- **Quota is advisory, not enforced.** `quotaService.checkQuota()` returns `true`
  unconditionally, and the call sites are in the *client* service layer:
  `boardService.createBoard` (line 110) calls `assertQuota` and then does a direct
  `addDoc`. `firestore.rules` → `match /boards/{boardId} → allow create` checks
  ownership and workspace membership but **cannot count existing boards**. A patched
  bundle or a raw REST write creates board #6 on a free plan.
- **Only AI is metered.** `workspaces/{id}/aiUsage/{period}` holds calls, tokens,
  `costUsd` and a `byFeature` breakdown, accumulated transactionally in
  `functions/src/ai/usage.ts` with the pure math (`estimateCostUsd`, `currentPeriod`,
  `applyUsage`) split out and unit-tested. Rules lock it to Functions-only writes.
  **This is the pattern M5 extends** — boards, sessions and seats have no counters.
- **The ephemeral channel is ready for presenter/laser.** `cursorService.ts` writes
  `boards/{id}/cursors/{uid}` off the persisted-state listeners, throttles to 20 Hz
  (`CURSOR_WRITE_INTERVAL_MS = 50`, render side ~12 Hz in `CursorLayer`), hides
  cursors stale past `CURSOR_STALE_MS = 10000`, and hides all of it behind a
  `CursorTransport` interface so Ably/Liveblocks can drop in. `CursorPayload`
  already carries `viewport` and `following`.
- **The embed's editable arm is a stub.** `EmbedScope = "view" | "edit"` is declared
  and documented as reserved; only `view` is implemented. `EmbedTokenPayload` is
  `{ v, boardId, scope, iat, exp }` — **no user identity**.
- **No audio dependency, and `expo-av` was fully removed in Expo SDK 55** (this repo
  is on `expo ~55.0.8`). Voice notes must use `expo-audio`.
- **Element union is five kinds:** `DrawPath`, `TextElement`, `ShapeElement`,
  `TextNote` (legacy sticky), `ImageElement`. Rendering is `react-native-svg` on both
  platforms — same tree, no DOM on native.
- **`app/board/[id].tsx`: 3,894 lines, 67 imports, 142 hook calls.**

### Required changes by layer

| Layer | Change |
|---|---|
| **Backend** | New: `createBoard` / `createSession` callables (moved off the client), `createCheckoutSession`, `stripeWebhook` (HTTPS, raw body), `createPortalSession`. New secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. |
| **Firestore data** | New `workspaces/{id}/usage/{period}`. New `workspaces/{id}/billing/subscription` (Stripe customer + subscription ids, status, current period end). |
| **Rules** | Board/session `create` → `if false` for clients. Collaborator cap as a predicate on `request.resource.data.members.size()`. `usage` + `billing` → Functions-only writes, owner/admin reads. |
| **Client services** | `boardService.createBoard` / `sessionService.createSession` become callable wrappers. `quotaService` demoted to explicitly non-authoritative pre-flight UX. New `billingService`. |
| **Client UI** | Upsell modal (two platform variants), Pro badges, usage dashboard (extends `app/ai-usage.tsx`), pricing page (web), presenter/laser controls, voice-note affordance, onboarding tutorial. |
| **Types** | `AudioElement`; `Subscription`; a shared `PLAN_LIMITS` table importable by both client and functions. |

### Migration / backfill needs

- **Existing workspaces need no backfill** — `plan` already defaults to `'free'`.
- **Counters start empty.** A workspace that already has 8 boards on the free plan
  must not be broken by the new gate. Boards use a **live `count()`**, so existing
  data is counted correctly with no backfill; the gate blocks *new* creates only.
  Sessions use a monthly bucket that starts at zero — **an existing workspace gets a
  fresh 3-session allowance in its first gated month.** That's the right call
  (retroactively counting historical sessions would silently lock people out).
- **No destructive migration**, so no staging soak is required — unlike M3.

---

## Phase ordering at a glance

| Phase | Title | Roadmap items | Track | Depends on | Complexity |
|---|---|---|---|---|---|
| 0 | Board screen decomposition | — (prereq) | — | — | Medium |
| 1 | Usage counters (server-side meters) | 2 (half) | A | — | Medium |
| 2 | Enforcement architecture | 2 (half) | A | 1 | **High** |
| 3 | Stripe, written in `functions/` | 1 | A | — | **High** |
| 4 | Plan limits + upsell surfaces | 2, 14 | A | 2, 3 | Medium |
| 5 | Usage dashboard + pricing page | 3, 5 | A | 1, 4 | Low |
| 6 | Presenter mode + laser pointer | 7, 8 | B | 0 | Medium |
| 7 | Voice notes | 9 | B | 0 | Medium |
| 8 | Colour + stroke polish | 12 | B | 0 | Low–Med |
| 9 | Onboarding polish | 4 | B | — | Low–Med |
| 10 | Google Meet add-on + editable embed | 6 | C | 0 | **High** |

**Critical path:** 1 → 2 → 4 is the spine; Phase 3 is independent of it and can run
in parallel (a second contributor's natural slice). Phase 0 gates the whole B track
and Phase 10 — do it first, in one sitting, and merge it before anything else
branches. Phase 5 is the cheapest item in the month because `app/ai-usage.tsx`
already reads the M4 meter. **Phase 10 should start in week 1 regardless of its
position here**, because the Marketplace review queue is measured in weeks.

---

## Phase 0 — Board screen decomposition *(prerequisite, no roadmap item)*

**Goal:** Make `app/board/[id].tsx` a composition root under ~600 lines so five M5
phases and five M6 phases don't serialize through merge conflicts in one file.

**Scope:** Pure refactor, **no behaviour change**. Extract by concern:

| Extract to | Owns |
|---|---|
| `src/hooks/useBoardElements.ts` | element subscriptions, culling, spatial index |
| `src/hooks/useBoardTools.ts` | active tool, tool options, shortcut wiring |
| `src/hooks/useBoardCollab.ts` | presence, cursors, follow mode (later: presenter) |
| `src/hooks/useBoardAI.ts` | the four flag-gated AI affordances |
| `src/hooks/useBoardComments.ts` | comment pins + thread panel state |
| `src/components/board/*` | the overlay layers currently inlined |

**Key changes:** `app/board/[id].tsx`, new `src/hooks/useBoard*.ts`, new
`src/components/board/`.

**Risks & mitigations:**
- *A "pure refactor" that isn't* — the safety net is that **any diff that changes a
  test is a bug.** If a test needs editing, the extraction changed behaviour; revert
  and redo the seam.
- *Feels like a lost week* — it is 3–4 days, and it is repaid the first time two
  phases touch the board screen in the same week.

**Tests:** No new tests. The existing 512 must pass **unmodified**, and `tsc` clean.

**Exit:** `app/board/[id].tsx` < 600 lines; 512 tests green with zero test edits.

---

## Phase 1 — Usage counters (server-side meters) *(roadmap item 2, first half)*

**Goal:** Meter the resources the free tier caps, using the M4 telemetry pattern
verbatim. No enforcement yet — counters only, so Phase 2 has something to read.

**Scope:**
- New `workspaces/{id}/usage/{period}`: `{ sessions: number, updatedAt: number }`,
  written only by Functions, `allow write: if false`, owner/admin read.
- **Boards are a stock, not a flow.** "5 boards" means 5 alive at once, so deleting
  one must free a slot. Use a **live Firestore `count()` aggregation** rather than a
  stored counter — no drift, no decrement bug, and board creation is rare enough that
  the aggregation read is irrelevant.
- **Sessions are a flow.** "3 per month" needs the monthly bucket, incremented and
  never decremented. **Reuse `currentPeriod()` from `functions/src/ai/usage.ts`
  verbatim** so AI and session periods can never disagree about when a month starts.
- Seats and workspaces-per-user need no counter — `board.members.size()` is on the
  doc being written, and workspaces-per-user is a `count()` query.
- Split the pure math out (`applyUsage`-style) so it unit-tests without Firestore.

**Key changes:** `functions/src/billing/usage.ts` (new), `firestore.rules`,
`firestore.indexes.json` if the count query needs one.

**Risks & mitigations:**
- *Period disagreement between AI and session counters* — mitigated by importing
  `currentPeriod` rather than reimplementing it. Add a test asserting both modules
  return the same bucket for the same timestamp.
- *`count()` cost on a large workspace* — aggregation queries bill per index entry
  read, not per document; negligible at these cardinalities.

**Tests:** Unit tests for the counter math mirroring `usage.test.ts`; a rules test
that clients cannot write `usage`.

**Exit:** Counters observable in the emulator after a create; client writes denied.

---

## Phase 2 — Enforcement architecture *(roadmap item 2, second half)*

**Goal:** Move enforcement to where the client cannot reach it. This is the phase
that makes a paid tier meaningful, and it is the highest-risk phase in the month.

**Scope:**
- `createBoard` and `createSession` become **callables**. Each reads
  `workspace.plan` + the Phase 1 counter, decides, and writes the doc **and** the
  counter increment in one transaction — so the count can never drift from reality.
- `firestore.rules`: board and session `create` flip to `if false` for clients,
  exactly like `aiUsage` today.
- The **collaborator cap becomes a rules predicate** on
  `request.resource.data.members.size()` rather than a callable. This matters: the
  self-join-by-invite-code path is a client `update`, not a create, so a callable
  would not cover it. One predicate closes both doors.
- `quotaService.checkQuota` survives as a **pre-flight UX check only**, with a
  comment saying so in as many words, so nobody mistakes it for the gate again.

**Considered and rejected — rules-enforced counters.** Keeping client writes and
having rules validate a counter-increment batch avoids the cold start and stays
offline-friendly. Rejected because every create becomes a multi-doc batch the rules
must validate, rules `get()` calls cost reads and count against the per-request
limit, and rules complexity was already flagged as an M3 risk. The callable is
simpler to read, simpler to test, and matches the M4 precedent.

**Key changes:** `functions/src/callable/createBoard.ts`,
`functions/src/callable/createSession.ts`, `firestore.rules`,
`src/services/boardService.ts`, `src/services/sessionService.ts`,
`src/services/quotaService.ts`.

**Risks & mitigations:**
- *Offline board creation stops working* — accepted. Creating a board offline was
  never meaningful (it needs a server-generated invite code and `serverTimestamp`).
  Document it; the offline *drawing* path is untouched, which is the one that matters.
- *Cold start on create* — surface a pending state; creates are rare.
- *Breaking every existing client at cutover* — the rules flip is the breaking edge.
  Ship the callables **first**, migrate the client to them, verify, and flip the
  rules in a **separate commit** so it can be reverted alone.

**Tests:** Rules tests proving a 6th board, a 4th monthly session, and a 5th
collaborator (**including via the invite-code self-join path**) are all denied at the
database. Function unit tests for the decision logic at, below and above each limit.

**Exit:** The bypass test in the roadmap's verification list fails to create — a
direct Firestore REST write with a valid token is denied.

---

## Phase 3 — Stripe, written in `functions/` *(roadmap item 1)*

**Goal:** Take money, and update `workspace.plan` from an authenticated webhook.

**Scope:** Three functions, no extension:
- `createCheckoutSession` (callable) — price ID resolved **server-side** (never
  passed from the client), `client_reference_id = workspaceId`.
- `stripeWebhook` (HTTPS, **raw body required** for signature verification) —
  handles `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_failed`. **Idempotent on
  `event.id`** — Stripe retries, and a replayed upgrade must not double-apply.
- `createPortalSession` (callable) — the Stripe Customer Portal handles cancellation
  and payment-method changes, so you write no UI for either.
- New doc `workspaces/{id}/billing/subscription`, Functions-only writes.

**Why not the extension:** Stripe archived
[the repo](https://github.com/invertase/stripe-firebase-extensions) and transferred
it to Invertase, and Firebase Extensions is deprecated with a hard shutdown on
**2027-03-31** — after which installed extensions keep running but can no longer be
updated, reconfigured or uninstalled via console or CLI. Publisher migration tooling
landed September 2026, and the documented path is "move it into your own Cloud
Functions codebase." You already have that codebase, with secret management, a
provider-adapter pattern, transactional accumulation, a rate limiter, 10 test suites
and a CI job. **Estimate 4–6 days**, versus the roadmap's assumed zero.

**Key changes:** `functions/src/billing/*` (new), `functions/src/config.ts` (two new
secrets), `src/services/billingService.ts` (new), `firestore.rules`.

**Risks & mitigations:**
- *Webhook signature verification silently failing* — Firebase Functions v2 parses
  bodies by default; use the raw-body accessor and assert in a test with a real
  signed fixture.
- *Plan drift between Stripe and Firestore* — the webhook is the only writer, and
  `customer.subscription.updated` carries the authoritative status. Reconcile on
  read for the dashboard rather than trusting a cached flag.
- *Testing without a live account* — Stripe CLI (`stripe listen --forward-to`)
  against the emulator covers the whole loop locally.

**Tests:** Unit tests per event type from saved fixtures, including a **replayed
event** asserting idempotency; a test asserting an unsigned/mis-signed request is
rejected.

**Exit:** Test-mode round-trip **both directions** — upgrade with `4242…`,
`workspace.plan == 'pro'`; cancel, plan reverts, gate re-engages.

---

## Phase 4 — Plan limits + upsell surfaces *(roadmap items 2, 14)*

**Goal:** One limits table, enforced everywhere, surfaced without getting the mobile
binary rejected.

**Scope:**
- A single `PLAN_LIMITS` module imported by **both** the client and `functions/` —
  one definition, no drift. Free: 1 workspace, 5 boards, 3 sessions/mo, 5 AI
  summaries/mo, 4 collaborators. Pro: unlimited boards/sessions/AI, 25 collaborators.
- **Two upsell variants, chosen by `Platform.OS`:**
  - **Web:** limit message + price + Stripe checkout link.
  - **iOS/Android:** state the limit and **stop**. No price, no link, no "manage your
    plan" affordance.
- Pro badges on gated affordances (presenter, voice notes, custom palette) → tapping
  opens the platform-appropriate modal.

**Risks & mitigations:**
- *App-store rejection* — this is the specific failure mode: a tappable
  "Upgrade for $5/mo" inside the binary is what gets it rejected. Build **two
  renders, not one render with a conditional link** — the conditional is the thing
  that eventually leaks. Add a test asserting the native variant's rendered tree
  contains no URL and no price string.

**Tests:** Snapshot/behaviour tests for both variants; the native-variant assertion
above; unit tests that client and function agree on every limit.

**Exit:** All five gates enforced *and* surfaced; native variant provably link-free.

---

## Phase 5 — Usage dashboard + pricing page *(roadmap items 3, 5)*

**Goal:** Let an owner see where they stand. Cheapest phase in the month.

**Scope:** Extend `app/ai-usage.tsx` — it **already reads the M4 meter** — to show
boards used/limit, sessions this period/limit, AI usage/limit, and plan headroom,
plus a "manage billing" entry point (web only). Pricing page on web: honest copy,
free tier shown first.

**Key changes:** `app/ai-usage.tsx`, new pricing route (web).

**Tests:** Rendering tests against fixture usage docs at 0%, near-limit and over.

**Exit:** Owner sees all four resources and their headroom in one screen.

---

## Phase 6 — Presenter mode + laser pointer *(roadmap items 7, 8)*

**Goal:** Sell the tutor/office-hours use case on top of M4's cursor channel.

**Scope:**
- Extend `CursorPayload` with `presenting?: boolean` and an ephemeral `ping`.
- Presenter locks followers' viewports (**overrides individual follow choices**),
  disables non-presenter drawing (configurable), shows an audience banner, and
  supports pause/resume so the presenter can step away without dropping everyone.
- Laser: a 2-second fading trail on the same channel. **Never persisted** — it must
  not touch the path collection. Hotkey `L` on web; press-and-hold for continuous,
  quick-tap for a single ping.

**Risks & mitigations:**
- *"Trivial if the M4 cursor channel is solid" — the channel has never run under
  real multi-user load*, because M4 was never deployed. Treat that as an assumption
  to verify during M4 closeout, not a fact. If cursor write volume is already at
  budget, presenter + laser is what pushes it over, and the `CursorTransport`
  interface exists precisely so Ably/Liveblocks can drop in.
- *Follow-mode cycles* — `wouldCreateCycle` already exists in `src/lib/followMode.ts`;
  presenter override must respect it.

**Tests:** Unit tests for presenter-overrides-follow precedence and ping expiry;
two-client manual verification with cursor write volume measured.

**Exit:** Two real clients; presenter locks the audience; laser fades and never
persists; write volume within the M4 budget.

---

## Phase 7 — Voice notes attached to elements *(roadmap item 9)*

**Goal:** 60s of audio attached to any element — async tutoring at its lowest friction.

**Scope:** `expo-audio` (**new dependency — needs approval; `expo-av` is gone in SDK
55**) via `useAudioRecorder`. AAC/m4a to Firebase Storage (~80KB/10s). New
`AudioElement` type. Speaker affordance on the anchored element. Transcription stays
deferred to M6.

**Risks & mitigations:**
- *Storage leak* — the M2 carry-forward "Storage objects orphaned on
  group-delete/clear-board" is already a known defect, and audio makes it louder and
  more expensive. **Fix the orphan path in this phase or accept it explicitly in
  writing** — don't inherit it silently.
- *Recording permissions on both platforms* — request at first use, not at launch.

**Tests:** Unit tests for the element/storage lifecycle including delete;
record→playback verified on web and native.

**Exit:** Record and play back on both platforms; the Storage object is deleted with
its element.

---

## Phase 8 — Colour + stroke polish *(roadmap item 12)*

**Goal:** The visible "Pro feel" affordances that Phase 4 badges.

**Scope:** Custom picker (hex + alpha + recent colours + per-workspace swatches),
6 stroke widths plus a continuous slider, **eyedropper**, highlighter (semi-transparent,
multiply blend), marker and calligraphy variants. Mostly `PenOptionsBar` /
`ShapeOptionsBar` work. *First cut if the month slips.*

**Tests:** Colour-model unit tests (hex/alpha round-trip); mobile-parity pass.

**Exit:** All variants usable on a real mid-range Android.

---

## Phase 9 — Onboarding polish *(roadmap item 4)*

**Goal:** Cut time-to-first-aha. **Build the tutorial once, here** — M6 item 14
re-specifies the same thing, and M6's version is reduced to sample-workspace seeding.

**Scope:** First-run interactive tutorial (draw → shape → invite → schedule →
end → summary), a sample board, and empty-state CTAs that point at value
("Schedule your first study session →", not "you have 0 boards").

**Tests:** Manual — hand it to one friend who has never seen the app, no
instructions, and time them to first board.

**Exit:** That friend reaches a first board unaided.

---

## Phase 10 — Google Meet add-on + editable embed *(roadmap item 6)*

**Goal:** Collaborate on a board without leaving the call. **Start the marketplace
submission in week 1** — the review queue, not the code, is the long pole.

**Why Meet over Zoom:** the add-on is an iframe around the M4 embed that already
exists, and Workspace Marketplace review typically runs days; Zoom's review
complexity scales with every requested scope and may require a live demo call or
demo video. Zoom's install base is the better education wedge — it becomes the M7+
stretch goal. **Do not split scope across both.**

**Scope:** The integration shell is small. **The real work is the editable embed:**
- Extend `EmbedTokenPayload` with a **host-asserted subject** and add an
  identity-mapping step (host user → B.O.A.R.D uid). Today the payload is
  `{ v, boardId, scope, iat, exp }` with **no identity** — fine for read-only,
  fatal for editable: every write from inside the panel would be unattributable,
  presence anonymous, and comments and activity author-less.
- Implement the `edit` arm of `exchangeEmbedToken` and the rules that honour it.
- Bump `EMBED_TOKEN_VERSION` — the payload shape changes, and the existing
  `bad-version` rejection path is there for exactly this.

**Risks & mitigations:**
- *This is a security boundary, not plumbing.* Rules-test it as hard as the M4 read
  path was — forged subject, expired token, wrong board, downgraded scope.
- *Review queue blocks launch* — ship an unlisted manual-install build in parallel;
  never gate the launch date on approval.

**Tests:** Rules tests for every forgery case above; an end-to-end exchange test in
the emulator.

**Exit:** A second user edits a board from inside a Meet panel, and their writes are
correctly attributed in presence, comments and the activity feed.

---

## Cross-cutting verification (roadmap M5 exit criteria)

1. **Bypass test — non-negotiable.** Free workspace at 5 boards; attempt a board
   create via direct Firestore REST with a valid auth token. **Must be denied.**
   A hidden button is not enforcement.
2. Stripe test-mode round-trip, both directions.
3. All five free-tier gates enforced at the database or in a Function.
4. Mobile-parity + perf gate on a real mid-range Android against
   `docs/perf-baseline.md`, watching cursor write volume with presenter + laser active.
5. `tsc` clean; app, `functions` and `test:rules` suites green.
6. One paying customer who is not you, a co-developer, or family.

## Dependencies & new costs to approve

| Package / cost | For | Notes |
|---|---|---|
| `stripe` (functions only) | Phase 3 | **Server-side only — never in the client bundle** |
| `expo-audio` | Phase 7 | Mandatory; `expo-av` removed in SDK 55 |
| Stripe fees | Phase 3 | 2.9% + $0.30/txn |
| Google Workspace Marketplace listing | Phase 10 | $0; submit week 1 |
| Ably / Liveblocks | Phase 6 fallback | **Only if** M4 cursor-load verification fails |

## Open questions for sign-off

1. **Pricing is still a guess** and cannot be validated until M4's cost data exists.
   Confirm $5/user/month after seeing real cost-per-session, not before.
2. **Do existing over-limit workspaces get grandfathered?** Recommendation: yes for
   boards (the live `count()` blocks new creates without deleting anything), and a
   fresh allowance for sessions. Confirm this is the intended experience.
3. **Is Edu tier manual-only this month?** The roadmap says don't build self-serve.
   Confirm — it changes whether Phase 4 needs a third limits column.
4. **Who is the paying customer going to be?** M5's exit criterion is not an
   engineering task, and the M3 gut-check target (10–20 real users) has no recorded
   answer. Seed users during M4 closeout, in parallel — not after this month.

## Sources

- [Run Payments with Stripe — Firebase Extensions Hub](https://extensions.dev/extensions/stripe/firestore-stripe-payments)
- [invertase/stripe-firebase-extensions](https://github.com/invertase/stripe-firebase-extensions)
- [Firebase Extensions Deprecation FAQ](https://firebase.google.com/docs/extensions/faq-and-troubleshooting)
- [Prepare Firebase Extensions for migration to Cloud Functions](https://firebase.google.com/docs/extensions/publishers/migrate)
- [Expo SDK 55 migration — `expo-av` removal](https://reactnativerelay.com/article/expo-sdk-55-migration-guide-breaking-changes-sdk-53-to-55)
- [Publish your Meet add-on](https://developers.google.com/workspace/meet/add-ons/guides/publish)
- [Zoom Meeting SDK feature review & requirements](https://developers.zoom.us/docs/distribute/sdk-feature-review-requirements/)
