# Phase 9 — Workspace migration & staging cutover runbook

> **Status:** ready to run on staging. Do **not** run on prod until the staging
> soak (below) is complete. Source plan: [month-3-phases.md](month-3-phases.md) Phase 9.

This is the prod-risk gate for Month 3 multi-tenancy. The migration backfills the
tenancy primitive onto every legacy doc; the rules and clients have tolerated
missing `workspaceId` since Phase 2 so old clients keep working *during* rollout.
Nothing about prod flips until this soaks on staging for a week.

## What the migration does

Script: [`scripts/migrate-workspaces.js`](../scripts/migrate-workspaces.js)
(run via `npm run migrate:workspaces`). Admin SDK, idempotent, with `--dry-run`.

1. **Users → personal workspace.** Each user gets `workspaces/personal_{uid}`
   (`members: { uid: 'owner' }`, `plan: 'free'`). If the user already has a
   personal workspace (a signup-created "Personal", or a prior run's
   `personal_{uid}`), it's reused — never duplicated.
2. **Boards → `workspaceId`.**
   - **Solo board** (only the owner is a member) → the owner's personal workspace.
   - **Shared board** (any other member) → a dedicated `workspaces/board_ws_{boardId}`
     whose members mirror the board: owner→`owner`, `adminId`→`admin`, everyone
     else→`member`. **This is the key correctness point:** a personal workspace
     holds only its owner, so without a shared workspace, board collaborators
     would 403 the moment the legacy rules fallback is removed at cutover.
3. **Sessions → `workspaceId`** inherited from the parent board. A session whose
   board no longer exists is left unscoped and logged (`sessionsOrphaned`).

**Roles are intentionally not backfilled.** Legacy boards had no role distinction
(every member could edit), which is exactly the default role resolution
(`effectiveBoardRole`: workspace member/admin/owner ⇒ editor). Writing an explicit
`roles` map would be redundant and would have to be unwound on the first demotion.

## Pre-flight

- [ ] Migration test green: `npm run test:rules` (covers
      [`firestore-tests/migrate.test.js`](../firestore-tests/migrate.test.js) — dry-run,
      live, idempotency, signup-WS reuse) — also the CI hard gate.
- [ ] `npx tsc --noEmit` clean.
- [ ] A service-account JSON for the **staging** project (Project Settings →
      Service accounts → Generate new private key). Keep it out of git
      (`scripts/*-service-account.json` is gitignored).

## Staging cutover

1. **Export prod, import to staging.**
   ```bash
   gcloud firestore export gs://<prod-bucket>/m3-pre-migration --project <prod>
   gcloud firestore import gs://<prod-bucket>/m3-pre-migration --project <staging>
   ```
2. **Dry run on staging** — verify counts look sane (no surprise orphans):
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=./scripts/staging-service-account.json \
     node scripts/migrate-workspaces.js --project=<staging> --dry-run
   ```
3. **Live run on staging:**
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=./scripts/staging-service-account.json \
     node scripts/migrate-workspaces.js --project=<staging>
   ```
4. **Re-run once** to confirm idempotency — every count except `*AlreadyMigrated`
   should be 0.
5. **Soak a week** of real internal use on staging. Watch for 403s and re-run the
   Android perf baseline vs [perf-baseline.md](perf-baseline.md) (the rules
   `get()` on the parent workspace is the watched read).

## Prod cutover (after a clean week on staging)

1. **Snapshot prod** (export to a dated bucket — this is the rollback point).
2. **Dry run**, then **live run** against prod (same commands, `--project=<prod>`).
3. **Verify exit criteria** (roadmap):
   - Migration runs clean on prod data.
   - Two test users, each in two workspaces, collaborate within a workspace and
     cannot read the other's boards — including a crafted-URL probe of a board id
     in a workspace they don't belong to.
   - Rules tests green in CI.

## Post-cutover — remove the legacy-tolerant fallbacks

Once every doc is stamped and the soak is clean, delete the dated
`TODO(phase-9-cutover)` clauses so a missing `workspaceId` is no longer treated as
"unscoped" (a defense-in-depth tightening). Each is marked in-code:

- [`firestore.rules`](../firestore.rules): `inBoardWorkspace` (L33), `isBoardEditor`
  (L79), `isBoardCommenter` (L108), and the session `read`/`create` tolerance (L270).
- [`src/services/boardService.ts`](../src/services/boardService.ts) `inWorkspace` (L139)
  — drop the `!b.workspaceId` clause.
- [`src/services/sessionService.ts`](../src/services/sessionService.ts) `inWorkspace`
  (L144) — drop the `!s.workspaceId` clause.

Removing these is a separate PR, gated on the prod migration completing. Re-run the
full rules suite after — the cross-workspace isolation cases must still pass with the
fallbacks gone.

## Rollback

The migration only *adds* `workspaceId`/workspace docs; it never deletes board
content. If something looks wrong mid-rollout, the legacy fallbacks mean old clients
keep working, so there's no flag-day to revert. For a hard rollback, restore the
pre-migration export. **Do not** remove the legacy fallbacks until you're confident,
since that's the only step that makes the stamped state load-bearing.
