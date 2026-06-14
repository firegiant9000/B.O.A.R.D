# Month 3 — Multi-tenancy + Workspaces: Phased Implementation Plan

> **Status:** Planning. Branch `feature/month-3-multitenancy-workspaces` cut from
> `main` (post-M2 merge, commit `1295f1f`). No prior M3 branches or PRs exist.
> **Roadmap source:** ROADMAP.md → Month 3 (scope items 1–10).
> **Deferred-from-M2 folded in:** Google Sign-In (M2 §4, parked behind the
> `authProviders` seam — needs `expo-auth-session` + native OAuth redirect).

**Goal (from roadmap):** Restructure the data model so the product supports
multiple isolated groups (study groups, classes, teams) under one account, with
roles — then layer the first true collaboration surfaces (per-board roles,
comments, activity, @mentions, dashboard) on that foundation.

This is the **highest-risk month** in the roadmap. The migration is invasive and
touches every read path, the security rules, and prod data. Everything in Phase 2
and Phase 3 of the product depends on it. The phasing below front-loads the
risky, blocking data-model work and gates the prod cutover behind a staging soak.

---

## Investigation: current state by layer

Verified against the tree on this branch.

### Current behavior and where it's implemented

- **No tenancy primitive.** Every board is a sibling under `/boards`. A user's
  boards are found two ways in [boardService.ts](../src/services/boardService.ts):
  `getUserBoards` (`where ownerId ==`) and `getMemberBoards`
  (`where members array-contains`). The home screen
  [app/(tabs)/index.tsx](../app/(tabs)/index.tsx) calls `getMemberBoards` on focus.
- **Access control is per-board.** [firestore.rules](../firestore.rules) gates on
  `board.members` / `ownerId` / `adminId` only — there is no workspace concept in
  the rules. Three role-ish fields exist on a board today (`ownerId`, `adminId`,
  `collaboratorIds`/`members`) but no named role enum.
- **No roles enum, no plan field, no quota hooks.** `Board` in
  [src/types/index.ts](../src/types/index.ts) has `ownerId`/`adminId`/`members`;
  there is nothing resembling `plan`, `role`, or a `checkQuota` choke point
  anywhere in the services.
- **Signup creates only a user doc.** [authService.ts](../src/services/authService.ts)
  `signUp` writes `users/{uid}` and nothing else — no personal workspace.
- **Sessions are workspace-agnostic.** `Session` in
  [src/types/index.ts](../src/types/index.ts) has `boardId` but no `workspaceId`.
- **No comments, no activity feed, no @mentions.** None of these collections or
  types exist. Comments would be the first canvas-anchored social primitive.
- **Notifications exist but are session-scoped.** `notificationService` handles
  push tokens + session notifications; there is no mention/reply routing and no
  user-level notification-preference doc.
- **Home screen is a bare boards list** — `FlatList` of `BoardCard`, FAB to
  create, header button to join. No dashboard, no switcher. Tabs are
  Boards / Schedule / Profile ([app/(tabs)/_layout.tsx](../app/(tabs)/_layout.tsx)).
- **Tests:** 28 suites / 306 tests green; 60% global coverage gate in CI.
  `@firebase/rules-unit-testing` is **not** yet a dependency.

### Required changes by layer

- **Data model (`src/types/index.ts`):** new `Workspace`, `WorkspaceRole`,
  `BoardRole`, `Plan` types; add `workspaceId` to `Board` and `Session`; add
  `roles` map to `Board`; new `Comment`/`CommentReply`, `ActivityEvent`,
  `NotificationPref` types.
- **Firestore collections:** new `/workspaces/{wsId}`,
  `/workspaces/{wsId}/activity/{eventId}` (and/or `/boards/{id}/activity`),
  `/boards/{id}/comments/{commentId}`. `boards` and `sessions` gain `workspaceId`.
- **Services:** new `workspaceService`, `commentService`, `activityService`,
  `quotaService` (`checkQuota` stub). `boardService`/`sessionService` queries
  re-scope to `workspaceId`. `authService.signUp` auto-creates a personal
  workspace. `notificationService` gains mention/reply routing.
- **Security rules:** workspace-membership gate becomes the root of board access;
  board access = subset of workspace members; per-board role checks layered on
  top; comments gated by board access. Rules-test harness added.
- **Migration:** one-off Node Admin-SDK script — create a personal workspace per
  existing user, stamp every existing board/session with a `workspaceId`,
  backfill `roles`.
- **UI:** workspace switcher in a top bar; create-workspace + invite-member flows;
  Share & permissions modal (replaces share modal); comment pins + thread panel;
  activity panel; @-mention autocomplete; new workspace dashboard/home screen.

### Reporting / analytics impact

- Activity feed (Phase 7) is itself a reporting substrate and the documented
  foundation for M5 board-version-history. Quota choke points (Phase 5) and
  `session.workspaceId` (Phase 4) are the hooks M4/M5 usage-metering and
  cost-telemetry will read. No external analytics tool lands this month (M6).

### Migration / backfill needs

- Invasive and serial — see Phase 9. Must run against a Firestore export on a
  **staging** project first, be idempotent (re-runnable), and snapshot prod
  before the real run. Old clients must keep working during rollout (readers
  default missing `workspaceId`/`roles`), so the migration is forward-compatible,
  not a hard flag-day.

### Risks, edge cases, regressions

- A board with no `workspaceId` mid-migration must not 403 existing users → rules
  and readers tolerate the missing field during the soak window.
- Rules `get()` calls on the parent workspace add a read per board access check —
  watch the M1 Android time-to-first-paint perf gate (roadmap verification).
- Cross-workspace data leakage is the headline security risk → rules tests are a
  hard CI gate this month, not optional.
- Firestore rules complexity compounds fast; keep helpers tight and tested.

### Existing branch / PR findings

- No `feature/workspaces` or M3 branch exists yet (this branch is the first).
- Google Sign-In is the only open carry-forward explicitly routed into M3
  (ROADMAP.md M2 status block). It's independent of the tenancy work and can run
  on a parallel track.

---

## Test plan

- **Rules tests (new, hard CI gate):** add `@firebase/rules-unit-testing`
  (needs approval — see deps). Minimum coverage from the roadmap: cross-workspace
  read denied, member read allowed, viewer write denied. Extend with: board-role
  override > workspace-role floor, comment access follows board access, self-join
  via invite still works.
- **Service unit tests:** `workspaceService` (create/personal-auto-create/invite/
  role math), `quotaService` (`checkQuota` returns-true contract + choke-point
  call sites), `commentService` (anchor/reply/resolve), `activityService` (append
  shape), mention parsing/token round-trip. Keep the 60% global gate green.
- **Migration script test:** dry-run mode + idempotency assertion against a
  seeded emulator dataset.
- **Manual:** two-workspace isolation (crafted-URL probe), workspace switcher
  ≤ 2 taps on iPhone SE / 5.5" Android, Android perf re-baseline vs
  `docs/perf-baseline.md`.

---

## Phased plan

Two tracks. The **tenancy track (Phases 1–5, 9)** is strictly dependency-ordered
and blocking — it must land and soak before prod cutover. The **collaboration
track (Phases 6–8, 10)** layers on the tenancy foundation; within it the order is
6 → (7, 8 parallel) → 10. The **Google Sign-In track (Phase 11)** is independent
and can run in parallel by a second contributor at any time.

Recommended single-developer order is the phase numbering below. **Do not start
Phase 6+ until Phases 1–4 are merged to the branch** — they assume `workspaceId`
exists on boards and the rules gate on workspace membership.

> Mobile-parity gate (M1 cross-cutting) stays in force: any phase that touches UI
> (3, 6, 7, 8, 10) needs a real mid-range-Android screenshot + a perf check vs
> `docs/perf-baseline.md` in its PR.

---

### Phase 1 — Workspace data model + types *(roadmap item 1)*
**Why first:** every later phase references `Workspace` / `workspaceId` / roles.
Pure type + service scaffolding, no behavior change, no migration yet — lowest
risk, unblocks everything.

**Scope:**
- Add to [src/types/index.ts](../src/types/index.ts): `Plan = 'free' | 'pro' | 'edu'`,
  `WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'`, and
  `Workspace { id, name, ownerId, members: Record<uid, WorkspaceRole>, plan,
  createdAt }`.
- New `workspaceService.ts`: `createWorkspace`, `getWorkspace`,
  `getUserWorkspaces` (`where 'members.{uid}'`-style membership query — note the
  map-key query constraint; may need a parallel `memberIds: string[]` array for
  `array-contains`), `addMember`, `updateMemberRole`, `removeMember`.
- **Personal workspace auto-create on signup:** extend `authService.signUp` to
  create `workspaces/{wsId}` with `members: { [uid]: 'owner' }`, `plan: 'free'`.
  Make it resilient (the signup must not hard-fail if the WS write lags).
- `firestore.rules`: add `/workspaces/{wsId}` rules — read/write gated on
  membership; role changes gated on `owner`/`admin`.

**Verification:** unit tests for workspaceService + role helpers; signup creates
exactly one personal workspace; `tsc --noEmit` clean.

**Out of scope:** boards referencing workspaces (Phase 2); UI (Phase 3).

---

### Phase 2 — Board ↔ workspace binding + rules rework *(roadmap item 2)*
**Why second:** the core invasive change. Everything that reads boards must
re-scope, and the rules gate flips from board-membership to workspace-membership.
Blocks the UI and the migration.

**Scope:**
- Add `workspaceId: string` to `Board` ([src/types/index.ts](../src/types/index.ts))
  and stamp it in `boardService.createBoard` (now takes a `workspaceId`).
- Re-scope queries: `getMemberBoards` / `getUserBoards` filter by `workspaceId`
  (compound query: `workspaceId == ws AND members array-contains uid`). The home
  screen passes the active workspace.
- **Rules:** `firestore.rules` board access resolves through the parent workspace
  — `isBoardMember` becomes "is a member of the board AND a member of the board's
  workspace"; `board.members` is a subset of workspace members. Keep the
  invite-code self-join path. **Tolerate missing `workspaceId`** during the
  migration window (legacy board ⇒ fall back to today's board-only gate behind a
  dated TODO removed after cutover).
- Add `@firebase/rules-unit-testing` + a rules-test harness; wire `firebase
  emulators:exec` into CI. Cover the roadmap's minimum three cases.

**Verification:** rules tests pass in CI; two crafted-URL probes (Phase verified
fully in Phase 9 with migrated data); `tsc` clean.

**Risk:** the single most likely place to break existing testers. Mitigation: the
legacy-tolerant fallback + staging soak (Phase 9). Watch the rules `get()` read on
the parent workspace against the Android perf gate.

---

### Phase 3 — Workspace switcher + create/invite UI *(roadmap item 3)*
**Why here:** first user-visible tenancy surface; needs Phases 1–2. Makes the
rest of the month testable by humans.

**Scope:**
- Active-workspace context (new `WorkspaceContext` or extend `AuthContext`),
  persisted to AsyncStorage; defaults to the personal workspace.
- Persistent switcher in the top bar (dropdown). **Mobile gate: reachable in ≤ 2
  taps on iPhone SE / 5.5" Android** (roadmap verification) — if not, design isn't
  done.
- "Create workspace" flow (modal, mirrors the existing New-Board modal pattern in
  [app/(tabs)/index.tsx](../app/(tabs)/index.tsx)).
- Invite members to a workspace (email-based; **reuse the existing invite-code
  primitive** + `addMemberByEmail` lookup pattern from `boardService`).
- Home boards list now reads from the active workspace.

**Verification:** switch workspaces → board list changes; create + invite
round-trip; mobile-parity screenshot + ≤ 2-tap check in PR.

---

### Phase 4 — Sessions inherit workspace *(roadmap item 4)*
**Why here:** small, mechanical, depends on Phase 2's `workspaceId` convention;
sets up M4/M5 usage metering.

**Scope:**
- Add `workspaceId` to `Session` ([src/types/index.ts](../src/types/index.ts));
  stamp it in `sessionService` create paths (inherit from the board's workspace).
- Session queries scope by workspace where it matters (e.g. dashboard upcoming).
- Rules: session access can reference workspace membership (keep join-code path).
- Migration backfill of `session.workspaceId` folded into Phase 9.

**Verification:** new sessions carry `workspaceId`; existing session flows
unregressed; unit test.

---

### Phase 5 — Plan-gating hooks (`checkQuota` choke point) *(roadmap item 5)*
**Why here:** trivial once the workspace has a `plan` field; the roadmap
explicitly wants the **choke point to exist now**, returning true for everyone, so
M5 can turn it into a real gate without re-plumbing call sites.

**Scope:**
- `plan` already on `Workspace` (Phase 1). New `quotaService.checkQuota(
  workspaceId, resource: 'board' | 'session' | 'aiSummary' | ...)` → returns
  `true` today.
- Wire the choke point into `createBoard`, `createSession` (and the AI path seam
  when it lands in M4). No enforcement, no UI — just the call site.

**Verification:** unit test asserts the contract (true for all) + that the call
sites invoke it. **Explicitly out of scope: enforcement, Stripe, upsell UI (M5).**

---

### Phase 6 — Per-board roles + Share & permissions modal *(roadmap item 6)*
**Why here:** first collaboration-track phase; needs the workspace role floor
(Phase 1) and the workspace-gated rules (Phase 2). Blocks comments' permission
checks (commenter role).

**Scope:**
- `BoardRole = 'editor' | 'commenter' | 'viewer'`; `boards/{id}.roles:
  Record<uid, BoardRole>` ([src/types/index.ts](../src/types/index.ts)).
- Role resolution: defaults inherited from workspace membership; per-board
  overrides explicit. **Floor rule:** workspace `viewer` cannot exceed
  `commenter` on any board; workspace `member` defaults to `editor` on
  workspace-owned boards.
- Rules: board paths/shapes/text/images writes gated on effective `editor`;
  comments on `commenter`+ (Phase 7).
- **Share & permissions modal** replaces the current share modal: one dialog for
  invite link, who-has-access, per-user role, and revoke.
- Use case to verify: read-only study-guide share to non-workspace classmates;
  TA can comment, not edit.

**Verification:** rules tests for role floor + override; viewer-write-denied;
modal round-trip; mobile screenshot.

---

### Phase 7 — Comments + threads anchored to elements *(roadmap item 7)*
**Why here:** needs per-board roles (Phase 6, `commenter`). Independent of Phase 8;
they can run in parallel.

**Scope:**
- `boards/{id}/comments/{commentId}`: `{ anchorElementId, offsetX, offsetY,
  authorId, body, replies: CommentReply[], resolved: bool, createdAt }`. Anchor to
  any element type (stroke/shape/text/sticky/image — all carry `id` today).
- Comment pin (numbered) rendered near the anchored element in a top SVG overlay
  layer (Appendix A.4 step 5 — never re-render the element tree for comment
  state). Thread panel: replies, resolve/reopen, unread-on-viewer-side.
- Realtime via `onSnapshot`. Reply/@mention notifications wired in Phase 10.
- Rules: read = board access; write = `commenter`+ (Phase 6).

**Verification:** anchor → pin renders at element; thread reply/resolve realtime
across two clients; rules test (viewer cannot comment); mobile screenshot.

---

### Phase 8 — Activity feed (workspace + board scoped) *(roadmap item 8)*
**Why here:** independent of comments; parallel with Phase 7. Append-only and
low-risk. Foundation for M5 version history.

**Scope:**
- `activityService.append(event)` → append-only log. Event shape:
  `{ actorId, verb, targetType, targetId, workspaceId, boardId?, meta, createdAt }`.
  Examples from roadmap: "created Board X", "commented on element Y", "Session Z
  ended with N participants".
- Storage: workspace-scoped collection (`/workspaces/{wsId}/activity`) for the
  workspace feed; board events also queryable per-board (denormalize `boardId` and
  index, or mirror to `/boards/{id}/activity` — decide on read pattern, document
  it). Append from existing service mutations (board create, comment, session end).
- "Recent activity" panel on workspace home (Phase 10) + per-board history
  sidebar.

**Verification:** mutations emit events; feed renders newest-first; append-only
enforced in rules; unit test on event shape.

---

### Phase 9 — Migration script + staging cutover *(roadmap item 2 backfill)*
**Why here:** runs once the data model (Phases 1–4, 6) is stable. This is the
prod-risk gate. **Nothing flips prod until this soaks on staging for a week**
(roadmap risk mitigation).

**Scope:**
- One-off Node script (Admin SDK, under `scripts/`): for each existing user create
  a personal workspace; for each board stamp `workspaceId` (= owner's personal WS)
  + backfill `roles` from current `members`/`adminId`/`ownerId`; for each session
  stamp `workspaceId` from its board.
- **Idempotent** (skip already-migrated docs) + a `--dry-run` mode that reports
  counts without writing.
- Runbook: export prod → import to **staging Firebase project** → run migration on
  staging → soak a week of internal use → snapshot prod → run on prod → remove the
  legacy-tolerant rules fallback (Phase 2 dated TODO).

**Verification (roadmap exit criteria):** script runs clean on a snapshot of prod
data; two test users each in two workspaces collaborate within a WS and cannot see
the other's boards (crafted-URL probe); rules tests green in CI.

---

### Phase 10 — @mentions + notification routing + workspace dashboard *(roadmap items 9 + 10)*
**Why last:** depends on comments (Phase 7, mentions live in comments), activity
(Phase 8, dashboard surfaces it), and workspace membership (Phase 3, mention
autocomplete source). The capstone UX.

**Scope:**
- **@mentions (item 9):** type `@` in a comment → autocomplete from workspace
  members; mention persists as a **structured token** (not plain text). On
  mention: push (extend `notificationService`) + in-app notification + opt-in
  daily email digest.
- **Notification preferences** on the user doc (`NotificationPref` type) with
  sensible defaults (push on mention, email digest daily).
- **Workspace home / dashboard (item 10):** new first-screen-after-sign-in
  (replaces the bare boards list as the default tab landing). Sections: pinned
  boards, recent boards, upcoming sessions, recent activity (Phase 8), workspace
  members. **Mobile parity:** vertical reflow; "pinned" + "upcoming sessions" are
  the above-the-fold cards.

**Verification:** @-autocomplete from WS members; mention fires push + in-app;
digest opt-in respected; dashboard renders all sections; mobile screenshot.

**Out of scope:** enforcing quotas, Stripe, AI, new canvas tools, live cursors (M4).

---

### Phase 11 — Google Sign-In *(carry-forward from M2 §4 — independent track)*
**Why separate:** unrelated to tenancy; can run in parallel by a second
contributor. Behind the existing `authProviders` seam.

**Scope:**
- Implement `expo-auth-session` Google provider behind `src/services/authProviders.ts`.
- Needs a native build (OAuth redirect) — verify on TestFlight + Android internal
  track, not Expo Go. Personal-workspace auto-create (Phase 1) must fire on
  first Google sign-in too, not just email signup.

**Verification:** hand a TestFlight/Play-internal link to a friend → Google
sign-in → lands in a personal workspace.

---

## Dependency graph

```
1 ─┬─> 2 ─┬─> 3 ─────────────┐
   │      ├─> 4              │
   │      └─> 5              │
   │                         ├─> 10  (dashboard + mentions)
   └─> (after 2,6) 6 ─┬─> 7 ─┤
                      └─> 8 ─┘
   2,4,6 ──────────> 9  (migration + staging cutover gate)
11  (independent, any time)
```

## New dependencies (require explicit approval — CLAUDE.md §8)

- `@firebase/rules-unit-testing` (dev) — rules tests; hard CI gate this month.
- `firebase-admin` (dev/scripts) — migration script (Admin SDK). May already be
  available via the Firebase CLI toolchain; confirm before adding.
- `expo-auth-session` (Phase 11, Google Sign-In) — was already flagged for M2/M3.

## Risks and mitigations (M3-specific)

| Risk | Mitigation |
|---|---|
| Migration breaks existing testers | Legacy-tolerant rules fallback during window; staging soak a week; snapshot prod before run; idempotent + `--dry-run` |
| Cross-workspace data leak | Rules tests are a hard CI gate (Phase 2); crafted-URL probe in Phase 9 |
| Rules `get()` reads regress board time-to-first-paint | Re-run M1 Android perf baseline (Phase 2/9); keep helpers tight |
| Map-key membership query limits (`members.{uid}`) | Carry a parallel `memberIds: string[]` for `array-contains` queries |
| Rules complexity compounds | Tight tested helpers; one role-resolution function, reused |
| Mobile switcher buried | ≤ 2-tap gate enforced in Phase 3 PR |
| Scope creep from appendices | Appendices are reference; month scope is ROADMAP §4 items 1–10 only |

## Exit criteria (from roadmap)

- Two test users, each in two workspaces, collaborate within a workspace and
  cannot see the other's boards.
- Migration script runs successfully on a snapshot of prod data.
- Firestore rules tests pass in CI.

## Mid-point gut check (end of Month 3 — non-engineering)

- 10–20 real users seeded outside the class?
- Are AI summaries something users *want*? (talk to 5 people)
- If "no, they want X" — repivot to Option C now, while the architecture is still
  flexible.
</content>
</invoke>
