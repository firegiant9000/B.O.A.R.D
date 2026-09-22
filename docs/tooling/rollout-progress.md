# Claude Code tooling rollout — progress ledger

Append only. One line per task with the verification output actually observed.

---

## 2026-09-21

**D5 (connectors) — RESOLVED, but the premise was wrong.**
Arlo's claude.ai → Connectors screenshot shows Fireflies, Google Drive, Lucid and Microsoft 365
all with Authorization `—` and a `Connect` button: present in the list but **not authorized**.
Claude Docs and GitHub Integration are the only two connected (`Individual`, status ✓).
Observed in this session's context: the four unauthorized servers contributed only a short
"require authentication" list (~80 tokens for all four including the explanatory paragraph).
They did NOT emit MCP instruction blocks. The `MCP Server Instructions` section contained only
context7, Claude Docs, obsidian and microsoft-learn — i.e. the *connected* servers.
=> D5's assumed saving (full instruction blocks per session) does not exist for unauthorized
connectors. Residual cost is ~80 tokens. Task 5's `mcpinstr` delta should be recorded as
approximately zero and NOT attributed to a detach that was already in effect.

**Task 15 (D1 hooks) — Option B applied. VERIFICATION PENDING.**
Executed out of wave order at Arlo's instruction (Wave 2 is frozen — he cannot get shared-repo
PRs reviewed yet, so Tasks 11-14 cannot complete and Task 15's stated dependency on Task 14
cannot be honored).

Pre-change investigation (observed, not assumed):
- `~/.claude/settings.json` has NO `"hooks"` key. Arlo has defined zero hooks of his own.
- Of the 6 plugins `true` in global `enabledPlugins` (microsoft-docs, context7, superpowers,
  code-review, code-simplifier, claude-md-management), only **superpowers** ships a hooks.json.
- superpowers 6.3.0 defines exactly one hook: `SessionStart`, matcher `startup|clear|compact`,
  running `hooks/run-hook.cmd session-start`. That script reads
  `skills/using-superpowers/SKILL.md` (3108 bytes / 485 words, ~750 tokens) and injects it as
  `hookSpecificOutput.additionalContext`. That is the entire suppressed behavior.
- Plugins with interesting hooks (security-guidance, hookify, ralph-loop, claude-security,
  the two output-style plugins) are all absent from or `false` in `enabledPlugins`.
- => `disableAllHooks: true` was suppressing one ~750-token skill-discovery bootstrap and
  nothing else. No hook in the current configuration writes commit messages.

Attribution evidence (bears on the Note on D1): this session, running WITH `disableAllHooks:
true`, still received a system-reminder instructing it to append `Co-Authored-By: Claude Opus 5`
to commits and the `🤖 Generated with Claude Code` line to PR bodies. That guidance arrives
through Claude Code's own prompting, not through a hook. Confirms the flag never controlled
attribution; the global CLAUDE.md rule is what suppresses it.

Changes made:
- CREATED `B.O.A.R.D/.claude/settings.json` (did not previously exist; `.claude/` was empty and
  is NOT gitignored, so this file will be tracked):
  `{"$schema": ..., "disableAllHooks": false}`
- EDITED `PlanPal/.claude/settings.json`: added `"disableAllHooks": false` above the existing
  `enabledPlugins` block. File was already dirty before this change (see D6 note).
- `~/.claude/settings.json` `"disableAllHooks": true` — UNCHANGED, as Option B requires.

NOT YET VERIFIED — Task 15 Step 3 cannot be executed from inside a running session. Settings are
read at session start, so the override test requires a NEW session started in B.O.A.R.D.
Test: start a fresh session in B.O.A.R.D and check whether the superpowers bootstrap
(`<EXTREMELY_IMPORTANT> You have superpowers ...`) appears in context.
  - Appears => project-level `false` overrides user-level `true`. D1 Option B stands.
  - Absent  => override does not work on this build. D1 collapses to A-or-nothing and returns
    to Arlo. DO NOT flip the global flag as a workaround.

Task 15 Step 5 (attribution check on a real commit made with hooks live) — NOT YET RUN.

**D6 — noted, not actioned.** `PlanPal/.claude/settings.json` was already modified-uncommitted
before this session (`git status`: ` M .claude/settings.json`), carrying
`"typescript-lsp@claude-plugins-official": true`. D6 rules this should be reverted. Left in place
— it belongs to Task 8, and reverting it would have mixed two decisions in one edit. Task 8 must
still remove it.

**HOOKS B + C — written, tested, registered.** (Arlo's request, outside the plan's task list.)
Created `~/.claude/hooks/no-claude-attribution.py` and `~/.claude/hooks/phi-secret-guard.py`;
registered both as `PreToolUse` in `~/.claude/settings.json` (`hooks` key added; global
`disableAllHooks` left `true`, so they are live only where a project sets it `false` — today
B.O.A.R.D and PlanPal).

Output contract taken from a real implementation on this machine, not assumed:
`hookify/core/rule_engine.py:68-80` — PreToolUse deny is
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"},"systemMessage":...}`.

Observed test results:
- attribution guard, `git commit` carrying `Co-Authored-By: Claude Opus 5` -> DENY, correct
- attribution guard, `gh pr create` carrying the Generated-with line -> DENY, correct
- attribution guard, `git log --grep="Co-Authored-By: Claude"` -> exit 0, allowed (searching
  history for the trailer must not be blocked)
- attribution guard, `git -C /repo commit -m "fix: normal commit"` -> exit 0, allowed
- PHI guard, connection string with real password -> vault path -> DENY, correct
- PHI guard, SSN-shaped value -> docs/ path -> DENY, correct
- PHI guard false-positive sweep: the 82KB rollout plan, the spec, and this ledger -> all
  ALLOWED, silent. All 14 notes in the Obsidian vault -> all ALLOWED, silent. Zero false
  positives on real content.

Design note recorded because it will look like a gap otherwise: the PHI guard matches value
SHAPES (an actual SSN, an actual key, a credentialed URI), never identifier NAMES like
`patient_id`. Schema discussion is explicitly permitted by CLAUDE.md; row data is not. Matching
column names would fire on every legitimate schema note in the vault.

---

**Task 1 (measurement baseline) — PARTIAL.**
- Step 1 DONE: `"session-report@claude-plugins-official": true` added to global `enabledPlugins`.
  Verified the plugin exists at
  `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/session-report`.
- Step 3 DONE: created `docs/tooling/measurements.md` with the plan's exact header.
- Steps 2, 4, 5 BLOCKED — not doable from a running session. Plugins resolve at session start,
  so `/session-report` is unavailable to the session that enabled it. Needs five fresh sessions.
- Step 5 (commit the baseline) not run: there is nothing to commit until the rows exist.

**Task 2 (skillOverrides) — Steps 1-3 DONE, 4-5 BLOCKED.**
Step 1 found the plan WRONG on a load-bearing detail, which is what Step 1 exists to catch:

  The plan says "the setting keys must match the `skillId` values in the sync manifest, which are
  bare names". Observed in
  `~/.claude/skills/synced/6408ceb4-…-1491af2f1b56/manifest.json`: 23 skills. The 8 keepers
  (`docs`, `docx`, `pdf`, `pptx`, `xlsx`, `skill-creator`, `import-memory`, `morning`) have
  `source: anthropic-example` and bare-name `skillId`s. All 15 venture skills have
  `source: plugin` and OPAQUE `skillId`s (`skill_01XYbU3SqTRAK5xdD6JJr3BL` etc). Their readable
  name lives in the separate `name` field and matches the plan's list exactly, 15 for 15.

Key form chosen: bare names, per the plan's block. Evidence for that over the opaque ids:
  - on disk the skills are flat bare-name directories under `synced/` (`adoption-obstacles`, …)
  - `~/.claude/cache/changelog.md:579` describes skillOverrides entries as "keyed on a bundled
    skill's alias (e.g. `checkup` for `/doctor`)" — alias/name keying, not id keying
  - `changelog.md:3379` confirms the three accepted values; `off` is correct.
This is a judgement call on ambiguous evidence, so Step 4 is LOAD-BEARING.
FALLBACK if the venture skills still appear in a fresh session's `/` list: re-key as
`anthropic-skills:<name>` (the plugin-qualified form these surface under). Do NOT fall back to
renaming the synced directory — the sync loop rewrites it.
Step 3 verification, observed: `node -e JSON.parse(...)` -> `ok`; 15 entries; all `off`;
none of the 8 keepers present.

**Task 3 (warning budgets) — DONE.**
Replaced the four-line bullet in `~/.claude/CLAUDE.md` "Code style" with the plan's measured
block. Verified the plan's B.O.A.R.D claim rather than trusting it: `package.json` scripts are
start, android, ios, web, test, test:watch, test:coverage, test:rules, migrate:workspaces,
backfill:welcome-grant, functions:build, functions:test, functions:serve — no `lint`, no
top-level `build`. Claim holds.

**Task 4 (connectors) — CLOSED.** See the D5 entry above. Nothing to do; already unauthorized.

---

**HARD STOP REACHED.** Task 5 (re-measure) needs fresh sessions, and Wave 1 "Depends on: Task 5"
(plan line 450). Tasks 6-8 additionally need `/init` and `/fewer-permission-prompts`, both of
which are slash commands requiring their own session. Nothing further can be executed from here.

**Waves 1, 2, 4 — not started. Wave 5 — flagged for deferral.**
**Wave 5 — flagged for deferral.** Its gate is Task 20's WMSAPI measurement, which cannot produce
an honest number while Wave 2's config sits in unmerged PRs.

---

## 2026-09-21 (session 2)

### The three opening checks

**Check 1 — D1 hooks override: PASS, mechanism confirmed.**
The superpowers bootstrap (`<EXTREMELY_IMPORTANT> You have superpowers`) WAS present in this
session's context. Task 15 Step 3 is therefore VERIFIED: project-level `disableAllHooks: false`
overrides user-level `true` on this build. Option B stands. Global flag left `true`, untouched.
Corollary, also verified by the files: `~/.claude/settings.json:99` still reads
`"disableAllHooks": true` and `B.O.A.R.D/.claude/settings.json:3` reads `false`, and both
PreToolUse guards (`no-claude-attribution.py`, `phi-secret-guard.py`, mtimes 13:47/13:48) are
live here. The attribution guard did not fire on any of this session's four commits, which all
omitted attribution.

**Check 2 — skillOverrides: PASS. No re-key needed. Bare-name keying is correct.**
None of the 15 venture skills appeared in this session's skill list. All eight keepers did,
surfaced as `anthropic-skills:<name>`. The fallback in the 2026-09-21 entry was NOT needed and
the synced directory was not renamed.

This also settles the Task 2 Step 1 judgement call with evidence rather than inference. Observed
after re-reading the manifest in this session: all 15 venture skills are STILL PRESENT in
`synced/…/manifest.json` (23 skills total) with their opaque `skill_01…` ids. They are on disk
and synced, yet invisible to the model. So the hiding is being done by `skillOverrides` keyed on
the readable `name` field — not by id, and not by the sync dropping them. The plan's Step 1 claim
that "the `skillId` values … are bare names" remains wrong for the 15; the override works anyway
because it keys on name.

**Task 2 Step 5 — sync-durability: PASS on one real sync cycle, NOT the 15-minute soak.**
Observed mtimes: `~/.claude/settings.json` 13:51:57 (when skillOverrides was written);
`synced/…/manifest.json` 13:55:28. The sync loop rewrote the manifest 3.5 minutes AFTER the
override was added, and this session — started after that rewrite — still has all 15 hidden.
That is the property the spec's rename approach lacked, demonstrated against a live sync. The
literal test as written (15 minutes idle, then a fresh session) has still not been run.

**Check 3 — `/session-report`: UNAVAILABLE. Root cause found; it is not a settings error.**
Not improvised around, and no substitute was run.
- `~/.claude/settings.json:79` DOES carry `"session-report@claude-plugins-official": true`.
- `~/.claude/plugins/installed_plugins.json:185-193` DOES record an install:
  `installPath: …/plugins/cache/claude-plugins-official/session-report/c447c3207a42`,
  `installedAt 2026-09-21T18:55:27.795Z`, sha `c447c3207a4…`.
- **That install path does not exist.** `~/.claude/plugins/cache/claude-plugins-official/`
  contains 11 plugin dirs (including the four `false` LSP ones) and no `session-report`.
- The source files DO exist in the marketplace checkout
  (`marketplaces/claude-plugins-official/plugins/session-report/skills/session-report/`,
  4 files) — they were simply never copied into the cache.
- There is no `~/.claude/commands/` directory and no `plugins/config.json` on this machine.
- Also noted: a `claude-plugins-official.bak` sits beside the live marketplace directory.

=> The install record was written without the files being materialized. The plan's Task 1 Step 2
remedy is the right one and is Arlo's to run interactively:
`/plugin install session-report@claude-plugins-official`.

Consequence: **Procedure M cannot be run at all.** Task 1 Step 4, Task 5 and Task 9 Step 1 are
all blocked on it, and remain blocked. `measurements.md` still has zero rows. Wave M and Wave 0
acceptance criteria are therefore still unmet, and no delta figure has been recorded. Nothing was
estimated or back-filled in place of a measurement.

Second, independent blocker on Procedure M even if the plugin is fixed: its step 1 is "open a
Claude Code session with the working directory set to the repo", five times. An agent inside one
session cannot do that. Procedure M is an Arlo-driven procedure, not an agent-executable one.

### Wave 1

**Task 6 (B.O.A.R.D CLAUDE.md) — DONE. Commit `da969f9`, later parent of `e4c3d52`.**
Step 1 DEVIATED FROM, deliberately. The plan says to enable `claude-code-setup` to get `/init`.
Observed: that plugin ships exactly one skill, `claude-automation-recommender` — it does **not**
provide `/init`. `/init` is built in and was already available in this session. Enabling the
plugin would have bought nothing and, given what just happened to session-report, would likely
have written a second install record that never materializes. No change made to global
`enabledPlugins`.
Step 2: branch created. NOTE — `origin/main` did not exist locally until fetched; only
`origin/feature/months-5-6-monetization-growth` was present, and local `main` was 1 commit stale
(`9825bbb` vs `8935184`). Fetched first, then branched off the fresh `origin/main`.
Steps 3-4: `/init` run; generated file reviewed against the plan's three checks before commit.
It names only real scripts (verified against `package.json` and `.github/workflows/ci.yml`),
invents no `npm run lint` or `npm run build`, carries no Firebase values/keys/project ids (env
var NAMES only), and adds repo-specific facts rather than restating global CLAUDE.md conventions.
Step 5: committed alone — `1 file changed, 90 insertions(+)`, exactly `CLAUDE.md`.

**Task 7 (B.O.A.R.D project settings + allowlist) — Steps 1-6 DONE. Commit `e4c3d52`.**
Step 1 CONFLICTED WITH THE PLAN and was merged, not followed literally. The plan says *create*
`.claude/settings.json` with `{$schema, permissions.allow: []}`. That file already existed —
Task 15 created it on 2026-09-21 with `disableAllHooks: false`. Writing the plan's literal
content would have deleted that key and **killed both PreToolUse guards in this repo**. The
`permissions` block was added alongside the existing key instead. Final file carries both.
Step 2-3: allowlist generated from transcripts (50 most-recent JSONL across all projects; 14 of
them B.O.A.R.D). Counts observed in B.O.A.R.D transcripts: `npx tsc --noEmit` 96, `npx jest` 93,
`npm --prefix functions …` 79 (split: `test` ~43, `run build` ~34), `npm run test:rules` 44,
`npm run test:coverage` 20, `git grep` 1.
Kept 8 rules. Dropped `npx tsc --noEmit` and `npx jest` despite being the top two — already
covered by the 45 global rules, so a project entry would be pure duplication. Dropped `git grep`
(1 use, below threshold). Dropped `awk`, `pnpm exec`, `npx`, `docker exec` as arbitrary-execution
wildcards. No rule mutates git state, writes to a DB, or names an absolute path.
**Non-obvious finding, applied to both repos:** the dominant real-world form of these commands
carries a redirect (`npm --prefix functions test 2>&1 > …`). An exact rule like
`Bash(pnpm typecheck)` does NOT match `pnpm typecheck 2>&1 | tee x`. PlanPal's pre-existing
exact-form rules have therefore been under-matching in practice. Trailing-wildcard variants were
added in both repos for this reason.
Step 4-5: `.gitignore` appended. `git status --porcelain --untracked-files=all .claude .gitignore`
returned exactly ` M .gitignore` and `?? .claude/settings.json` — no `settings.local.json`, as
the plan requires.
Step 6: committed, `2 files changed, 20 insertions(+)`.
Step 7 NOT RUN — the "fresh session, no prompt for npm test / npx tsc --noEmit / git status"
probe cannot be executed from inside the session that wrote the settings. Still outstanding.

**Task 8 (PlanPal) — Steps 1-6 DONE. Commit `3abb26b`. One blocker found for Task 10.**
Step 1: the plan expects "a three-line addition". Observed a FOUR-line addition — the working
tree carried BOTH the pre-existing `enabledPlugins`/typescript-lsp entry AND the
`disableAllHooks: false` line that Task 15 added on 2026-09-21.
Step 2 CONFLICTED WITH THE PLAN. The plan's `git checkout -- .claude/settings.json` would have
reverted both, destroying Task 15's hooks override along with the typescript-lsp entry. Removed
only the `enabledPlugins` block, by hand, keeping `disableAllHooks: false`. D6 satisfied; Task 15
intact. Verified: `enabledPlugins: undefined` after the edit.
Step 3: **`git fetch origin main` FAILED — `remote: Repository not found` for
`https://github.com/firegiant9000/PlanPal.git`.** The cached `origin/main` ref (`f0187a7`) still
exists locally, so the branch was created off that. Committed work is safe, but
**Task 10 Step 3 (push PlanPal, open its PR) cannot succeed** until the remote is resolved —
renamed, made private, or deleted. This is new information, not in the plan.
Step 4-5: allowlist generated from 13 PlanPal transcripts. Counts: `pnpm typecheck` 47,
`pnpm lint` 44, `pnpm test` 40, `pnpm build` 33, `pnpm test:integration` 34, `pnpm recurrence:check`
25, `docker exec` 135, `pnpm exec` 73, `npx` 79, `pnpm install` 13, `pnpm db:reset` 10.
Added 7 entries, all pnpm — no npm forms introduced, as the plan requires. Existing deno/pnpm
rules untouched. Deliberately EXCLUDED: `docker exec`, `pnpm exec`, `npx` (arbitrary execution);
`pnpm install`/`pnpm add` (mutating, and global soft_deny forbids adding deps); `pnpm db:reset`,
`db:start`, `db:stop` (mutate a local DB); `pnpm recurrence:sync`; `gh api`; `npm view` (would
introduce an npm form). `docker ps`/`logs`/`inspect` and all git/gh read-only forms dropped as
already auto-allowed.
Step 6: committed, `1 file changed, 9 insertions(+), 1 deletion(-)`. Commit body records the D6
revert and the hooks line explicitly, since one file carried two decisions.

**Task 9 — BLOCKED.** Step 1 is Procedure M. No wave-1 rows recorded. Step 2's delta block was
NOT written: with no wave-M baseline and no wave-1 measurement, any number in it would be
invented. The plan's own instruction ("If `discoverycalls` does not fall, say so rather than
assuming a win") cuts the same way — there is nothing to compare.

**Task 10 — NOT STARTED, awaiting Arlo.** Both branches are committed locally and unpushed.
B.O.A.R.D `chore/claude-config` = `e4c3d52` (2 commits off `origin/main` @ `8935184`).
PlanPal `chore/claude-config` = `3abb26b` (1 commit off cached `origin/main` @ `f0187a7`,
remote currently unreachable). Nothing pushed, no PR opened, nothing merged.

**Wave 2 (Tasks 11-13) — NOT STARTED, frozen at Arlo's instruction. Wave 4 blocked behind it.
Wave 5 deferred.** No WMS repo was touched in this session.

**Still uncommitted in B.O.A.R.D and deliberately left so:** the plan, spec, review,
`PROMPTS-tooling-rollout.md`, `NEXT-SESSION-PROMPT.md`, and `docs/superpowers/plans/*`. The plan
never says to track them. Flagged because Task 10's PR body cites the plan path, which will
dangle in the PR if the plan stays untracked — Arlo's call.
RULED same session: leave them untracked; drop the plan reference from the PR body instead.

**Task 10 — ATTEMPTED on Arlo's go-ahead, then BLOCKED. Root cause found, not worked around.**
`git push -u origin chore/claude-config` in B.O.A.R.D failed:
`remote: Permission to firegiant9000/B.O.A.R.D.git denied to ArloK62` / HTTP 403.

`gh auth status` shows TWO authenticated github.com accounts in the keyring:
  - `ArloK62` — **Active account: true**, scopes gist/read:org/repo/workflow
  - `firegiant9000` — Active account: false, same scopes
The in-scope repos are owned by `firegiant9000`. The active credential is the other account.

This is very likely the SAME root cause as the PlanPal `fetch` failure recorded above: a private
`firegiant9000/PlanPal` is invisible to `ArloK62`, and GitHub answers a repo you cannot see with
`404 Repository not found` rather than `403`. B.O.A.R.D is public, so its read (fetch) succeeded
and only the write (push) hit 403. One cause, two different status codes. NOT yet confirmed for
PlanPal — confirming it requires switching the active account.

NOT actioned: `gh auth switch` changes the machine-wide git identity and would affect the WMS
repos and any other session, which is outside this rollout's "config changes only" scope.
Returned to Arlo.

State at end of session 2 — nothing pushed, no PR opened, nothing merged:
  B.O.A.R.D  `chore/claude-config` = `33fd443`, 3 commits ahead of `origin/main` @ `8935184`
  PlanPal    `chore/claude-config` = `3abb26b`, 1 commit ahead of cached `origin/main` @ `f0187a7`
`npx tsc --noEmit` in B.O.A.R.D: clean, no output, exit 0. No application code was touched.

---

## 2026-09-22

**Credential blocker — RESOLVED per-repo, at Arlo's instruction. Global identity untouched.**
Chosen over `gh auth switch` so the WMS repos and other sessions keep the `ArloK62` active
account. Applied identically to B.O.A.R.D and PlanPal, all `--local`:
  `credential.https://github.com.username = firegiant9000`
  `credential.helper = ""`   (empty value clears the inherited global `manager`)
  `credential.helper = !gh auth git-credential`
The global helper remains GCM (`manager`); `gh` 2.94 holds valid tokens for both accounts, and
its helper honours the pinned username.

**The PlanPal 404 hypothesis — CONFIRMED.** After the credential change, `git fetch origin main`
in PlanPal succeeded where it had failed with `remote: Repository not found` the day before.
One root cause, two status codes: 403 on the public repo's push, 404 on the private repo's
fetch, both because the active credential was the wrong GitHub account.

**Task 10 — DONE. Both branches pushed, both PRs open, neither merged.**
  B.O.A.R.D → https://github.com/firegiant9000/B.O.A.R.D/pull/94
  PlanPal   → https://github.com/firegiant9000/PlanPal/pull/7
PR bodies omit the plan path, per the 2026-09-21 ruling to leave the planning docs untracked.

**PlanPal had moved underneath the branch — rebased, not force-fitted.**
Observed on return: PlanPal was on `main`, working tree clean, and `origin/main` had advanced
from the cached `f0187a7` to `a4738c3` (PRs #5 and #6 merged in the interim). `chore/claude-config`
was `ahead 1, behind 6`. Rebased onto the new `origin/main`; `.claude/settings.json` conflicted.
Resolved as a UNION — main's newer entries kept, mine added. Did NOT drop rules that had landed
on main independently (`npx.cmd tsc|turbo|jest *`, two pinned `node -e` version reads, the
`Skill(claude-api*)` and PowerShell entries); removing another change's rules during a conflict
resolution would have been an unrelated regression smuggled into this PR. Final diff vs main is
additions only, 8 lines, 29 allow entries total.
Consequence for D6: **no action was needed.** Current `main` carries no `enabledPlugins` block at
all, so the uncommitted typescript-lsp entry is already gone upstream. The commit message was
amended to say so rather than claiming a revert that did not happen.
Also note: `disableAllHooks: false` is NOT on PlanPal's `main` — Task 15's PlanPal override lives
only on this PR branch until #7 merges. Until then, hooks are off in PlanPal on `main`.

**`/session-report` — NOW AVAILABLE.** The skill `session-report:session-report` appears in this
session's skill list, so the hollow-install problem recorded on 2026-09-21 has been fixed
(interactively, by Arlo). Procedure M's tooling blocker is cleared. Its *other* blocker stands
unchanged: Procedure M needs one fresh session per repo, which an agent cannot open. Tasks 1
Step 4, 5 and 9 remain outstanding and still have zero rows in `measurements.md`.

**Procedure M — RUN, and it does not work as the plan specifies. This is the seventh and most
load-bearing plan error found so far.**
`/session-report` was run over a 7-day window (2026-09-15..22, 28 sessions, 5 projects). Its
analyzer JSON was inspected directly rather than trusted. Per-project keys are exactly:
`sessions`, `api_calls`, `input_tokens{uncached,cache_create,cache_read,total,pct_cached}`,
`output_tokens`, `human_messages`, `hours`, `cache_breaks_over_100k`, `subagent`,
`skill_invocations`, `span`.
**There is no system-prompt breakdown in the output at all.** `sysprompt`, `skilldesc` and
`mcpinstr` — three of the six measurement columns — do not exist in this tool. Procedure M step 3
says to copy five numbers "from the report"; only `totalinput` and `cacheread%` are there.
Step 4's `Grep + Glob + Read` count is also absent and had to be derived from the JSONL by hand.
=> The plan named the wrong command. `/context` is what reports the system-prompt composition.
=> The review's ~3,150-token `skilldesc` sanity check is unevaluable by this route, and **Task 5's
`skilldesc` delta — the headline number of the whole Wave 0 justification — cannot be computed
from `/session-report` at all.**

Two further reasons no `wave=M` row was written:
- The figures are 7-day aggregates over many sessions, not one fresh session per repo. `totalinput`
  is workload-dominated and not comparable across repos or waves.
- The window straddles 2026-09-21, when Wave 0's `skillOverrides` landed. **The baseline window has
  closed** — a clean pre-change baseline is no longer obtainable retrospectively.
Rows were therefore written under wave label `agg`, with the three missing columns marked `n/a`
and a caveat block stating they must not be compared against future wave rows. Nothing was
estimated. WMSSite got no row: zero sessions in the window.

Observed and recorded without a causal claim: discovery calls per session ROSE either side of
09-21 (B.O.A.R.D 5 -> 11, WMSAPI 5 -> 13). Almost certainly an artifact — the post-09-21 sessions
are the rollout sessions themselves, which do unusual amounts of config archaeology, and
B.O.A.R.D's CLAUDE.md did not exist for most of the window.

**HTML report — DELIBERATELY NOT GENERATED. PHI risk in the skill's own design.**
The auto-mode classifier denied the embed step ("Sensitive-Source Provenance"). On inspection the
denial was correct and was not worked around. `/session-report`'s HTML embeds the analyzer JSON
verbatim, and `top_prompts` carries **verbatim prompt text**: of 87 entries, 42 from WMSAPI and 19
from WMS_Reports — the two PHI-bearing repos — plus 57 `cache_breaks` entries. The skill writes
that file into the current working directory, which here is a git-tracked repo with an open PR.
The template copy that had been made was deleted; no data was ever embedded. Recorded in
`measurements.md` as a standing warning. This is a hazard in the plugin, not in this rollout —
worth knowing before anyone runs `/session-report` in a WMS repo.

**Procedure M — REWRITTEN in the plan, 2026-09-22.** Split into M-0 (open a fresh session),
M-A (`/context all` → sysprompt/skilldesc/mcpinstr), M-B (`/session-report` → totalinput/cacheread%,
with the workload-aggregate caveat and the PHI warning), M-C (discoverycalls, counted from
transcripts, recorded per-session), M-D (record; never estimate). It now states up front that the
procedure is Arlo-driven, not agent-executable.

The plan file is UNTRACKED, so the superseded text is not recoverable from git. Preserved verbatim
here, as it stood before the rewrite:

    ### Procedure M — the measurement procedure

    Referenced by name from the baseline task and every re-measure task. Run it exactly as written.

    1. Open a Claude Code session with the working directory set to the repo.
    2. Run `/session-report`.
    3. From the report, copy **only these five numbers** into the measurement table:
       `system prompt tokens`, `skill+plugin description tokens`, `MCP instruction tokens`,
       `total session input tokens`, `cache read %`.
    4. Additionally record `Grep + Glob + Read tool call count` and, if the report breaks it out,
       `tokens returned by those calls`. This is the *discovery cost* figure the Graphify gate uses.
    5. Close the session. Repeat for the next repo.
    6. Append a row per repo to `docs/tooling/measurements.md` (in the B.O.A.R.D repo) with columns:
       `date | wave | repo | sysprompt | skilldesc | mcpinstr | totalinput | cacheread% | discoverycalls | discoverytokens`.

    **Numbers only. No excerpts.** See the PHI rule above.

Facts the rewrite is built on, all verified against `~/.claude/cache/changelog.md` rather than
assumed:
- `/context all` breaks out per-skill token estimates; bare `/context` summarizes them (line 3210).
  `all` is therefore required to get `skilldesc` at all.
- `/context all` attributes plugin-sourced skills to their providing plugin (line 3213).
- `/context` reports per-MCP-server tool token counts (line 4854).
- `/context` may fall back to a LOCAL ESTIMATE when the token-counting API is unavailable
  (line 536) — so rows must be marked `est` when that happens, or estimated and measured figures
  get mixed silently.
- Percentages are computed against the model's own window: 1M for Opus 4.7+, 200K for earlier
  models (line 3687). Absolute token counts only; percentages are not comparable across models.
- **In VSCode `/context` opens a native dialog rather than printing into the transcript**
  (line 3521). An agent in that session cannot read it. This is why M-A is explicitly Arlo's step,
  and why the numbers have to be pasted in or captured from the terminal CLI instead.
