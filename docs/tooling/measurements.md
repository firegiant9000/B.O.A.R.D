# Claude Code tooling rollout — measurements

Numbers only. No transcript excerpts, no query text, no identifiers. See the PHI rule in
`2026-09-17-claude-tooling-rollout-plan.md`.

| date | wave | repo | sysprompt | skilldesc | mcpinstr | totalinput | cacheread% | discoverycalls | discoverytokens |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-22 | agg | B.O.A.R.D | n/a | n/a | n/a | 229699369 | 98.6 | 32 | n/a |
| 2026-09-22 | agg | PlanPal | n/a | n/a | n/a | 1459817 | 96.6 | 0 | n/a |
| 2026-09-22 | agg | WMSAPI | n/a | n/a | n/a | 2053029286 | 97.7 | 83 | n/a |
| 2026-09-22 | agg | WMS_Reports | n/a | n/a | n/a | 56844030 | 94.3 | 58 | n/a |
| 2026-09-22 | agg | WMSSite | — | — | — | — | — | — | — |
| 2026-09-22 | 1 | B.O.A.R.D | 9400 | 5900 | 0 | n/a | n/a | 32 | n/a |
| 2026-09-22 | 0 | PlanPal | 11600 | 5900 | 609 | n/a | n/a | 0 | n/a |
| 2026-09-22 | 0 | WMSAPI | 11500 | 6000 | 626 | n/a | n/a | 83 | n/a |
| 2026-09-22 | 0 | WMSSite | 11900 | 5900 | 626 | n/a | n/a | 0 | n/a |
| 2026-09-22 | 0 | WMS_Reports | 11900 | 5900 | 645 | n/a | n/a | 58 | n/a |

## M-A capture — all five repos, 2026-09-22

Procedure M step M-A complete for every in-scope repo. All five captured with bare `/context` from a
fresh session, model `claude-fable-5-1`, 1M window, absolute tokens, none flagged as estimates.
Same model across all five, so the rows are directly comparable.
`sysprompt` = System prompt + Memory files. `totalinput`/`cacheread%` stay `n/a` on these rows:
`/context` is a snapshot, not a session total — the `agg` rows above carry those.

Raw categories as displayed:

| category | B.O.A.R.D | PlanPal | WMSAPI | WMSSite | WMS_Reports |
|---|---|---|---|---|---|
| System prompt | 5.0k | 5.0k | 5.0k | 5.0k | 5.0k |
| **System tools** | **17.8k** | **17.8k** | **17.7k** | **17.8k** | **17.8k** |
| MCP tools | *(absent)* | 609 | 626 | 626 | 645 |
| Custom agents | 73 | 73 | 467 | 73 | 73 |
| Memory files | 4.4k | 6.6k | 6.5k | 6.9k | 6.9k |
| Skills | 5.9k | 5.9k | 6.0k | 5.9k | 5.9k |
| Messages | 1.3k | 1.3k | 10 | 10 | 10 |
| **total loaded** | **34.5k** | **37.3k** | **36.4k** | **36.3k** | **36.4k** |

### Findings

1. **`System tools` is 17.7–17.8k in every repo — dead constant, and ~half of all loaded context.**
   It is the largest controllable category by a factor of three, it is identical everywhere, and
   **it is not a column in Procedure M. No task in this plan addresses it.** The rollout spent
   Wave 0 on `Skills` (5.9k) and Task 4 on MCP (≤645). Both were the wrong targets by an order of
   magnitude. This is the single most actionable number in the whole exercise.

2. **`mcpinstr` is ≤645 tokens everywhere, and in B.O.A.R.D the MCP row is absent entirely (0).**
   Review §2.2 called MCP standing cost "probably the largest single line" and Task 4/D5 ordered a
   connector detach on that basis. It is 0.06% of the window at most. **That work was chasing
   nothing**, now confirmed across five repos rather than inferred from one.

3. **`Skills` is 5.9–6.0k in all five — a 100-token spread.** Post-`skillOverrides` in every repo.
   Because no pre-change capture was ever taken, the review's ~3,150-token claim for the 15 venture
   skills **remains unverified and is now unverifiable.** Recorded as an open question, not a win.

4. **The only real per-repo variance is Memory files (4.4k–6.9k) and, in one repo, Custom agents.**
   WMSAPI carries 467 tokens of custom agents against 73 everywhere else — three repo-local agents
   (`fireflies-transcript-summarizer` 145, `sql-ef-core-wms-assistant` 133,
   `csharp-dotnet-wms-maintainer` 116) on top of the shared `code-simplifier` 73. Small, but it is
   the only category any repo-level decision has actually moved.

5. **B.O.A.R.D is the cheapest repo at 34.5k, and its Memory files are the LOWEST at 4.4k — despite
   Wave 1 having just added a `CLAUDE.md` to it.** Its memory is `~/.claude/CLAUDE.md` 2.7k +
   the new repo `CLAUDE.md` 1.6k + `MEMORY.md` 199. The other four are higher because they each
   also carry a `CLAUDE.local.md` (1.1k–1.4k). So Task 9's expected "sysprompt rises after Wave 1"
   is **not** observable as a regression — the added file is 1.6k and B.O.A.R.D still sits lowest.

6. **WMS_Reports has no tracked project `CLAUDE.md` at all.** Its memory is `MEMORY.md` 2.9k +
   `~/.claude/CLAUDE.md` 2.7k + `CLAUDE.local.md` 1.4k. It is the only in-scope repo whose project
   instructions live entirely in untracked/machine-local files, and its auto-memory `MEMORY.md` is
   the largest of any repo by 20×. Not in any task's scope; flagged because a shared repo with
   7–11 contributors having no shared project instructions is a gap worth a decision.

## Decisions recorded

**D1 (2026-09-22): hooks re-enabled in B.O.A.R.D and PlanPal only, via project-level
`disableAllHooks: false`. Option B, verified working.**
Attribution check after commits made with hooks live: **clean.** Checked all 8 commits across both
branches (`git log --format=%B | grep -ci "co-authored-by|generated with claude|🤖"` → `0` in each
repo), not just the first. Global `~/.claude/settings.json` `disableAllHooks` confirmed still
`true` — Option B did not quietly become Option A. Attribution rule confirmed present at
`~/.claude/CLAUDE.md:31` *before* hooks were re-enabled.
Stronger than the plan asked for: this session's environment **actively instructed** the agent to
append `Co-Authored-By: Claude Opus 5 (1M context)` and the `🤖 Generated with Claude Code` line.
Neither landed. That is a direct confirmation of the Note on D1 — the global CLAUDE.md rule, not
`disableAllHooks`, is what suppresses attribution. No plugin hook rewrites commit messages.

**D-ponytail (2026-09-22): SKIP. Ruled by Arlo. Task 17 is closed, not deferred.**
Not installed, no marketplace added, no `env` block written anywhere. Reasons on record: it adds a
third-party marketplace and executes its code on a machine carrying PHI repos and production DB MCP
servers; it installs a UserPromptSubmit hook that sees and modifies every turn; the one independent
evaluation measured −15.4% code / −10.3% cost against vendor claims of −54% / −20%; and Task 18,
which would decide whether it pays for itself, is a Procedure M re-measure that cannot produce the
per-turn delta it needs. **Consequence: Task 18's Ponytail netting-out step is moot, and Wave 3 is
complete.** The M-A data above also undercuts the premise independently — the categories Ponytail
would affect are dwarfed by `System tools`, which it does not touch.

**D-superpowers (2026-09-22): keep globally enabled. No change.**
Confirmed `"superpowers@claude-plugins-official": true` at `~/.claude/settings.json:74`. The skills
are invocable by name without the bootstrap hook, and after D1 they also self-discover in B.O.A.R.D
and PlanPal. Recorded so it is not revisited from scratch. Note the cost side is still unmeasured
in isolation: the 5.9k `Skills` figure above is all enabled plugins together, not superpowers alone.

## Read this before using the table above

**These are NOT Procedure M rows and must not be compared against future wave rows.**
The wave label is `agg`, not `M`/`0`/`1`, deliberately. Three independent reasons:

1. **`/session-report` does not produce three of the six columns.** Verified by inspecting the
   analyzer's own JSON schema on 2026-09-22, not assumed. Its per-project object contains exactly:
   `sessions`, `api_calls`, `input_tokens{uncached, cache_create, cache_read, total, pct_cached}`,
   `output_tokens`, `human_messages`, `hours`, `cache_breaks_over_100k`, `subagent`,
   `skill_invocations`, `span`. There is **no system-prompt breakdown anywhere in the file** — no
   `sysprompt`, no `skilldesc`, no `mcpinstr`. Procedure M step 3 asks for five numbers "from the
   report"; only two of them (`totalinput`, `cacheread%`) exist.
   => The plan named the wrong command. The system-prompt breakdown is what `/context` reports,
   not `/session-report`. `/context` is interactive and per-session, so it stays Arlo-driven.
   => The review's ~3,150-token `skilldesc` sanity check cannot be evaluated, and **Task 5's
   `skilldesc` delta cannot be computed by this route at all.**

2. **These are 7-day aggregates across many sessions, not one fresh session per repo.**
   Window 2026-09-15 .. 2026-09-22. Session counts behind each row: B.O.A.R.D 9, PlanPal 1,
   WMSAPI 12, WMS_Reports 4. Procedure M measures *standing* cost, which is workload-independent;
   `totalinput` here is dominated by workload and is close to meaningless for comparison. A repo
   that happened to run a big refactor looks "expensive" for reasons the rollout does not control.

3. **The baseline window has closed.** The window straddles 2026-09-21, when the Wave 0
   `skillOverrides` change landed, so these figures mix pre- and post-change sessions. A clean
   `wave=M` row is no longer obtainable retrospectively — the config it was meant to measure is
   already in effect.

**`discoverycalls`** was NOT taken from the report, which does not break out tool calls. It was
counted directly from the transcript JSONL (`tool_use` entries named `Grep`, `Glob` or `Read`,
timestamped inside the window). Split around the 2026-09-21 config change:

| repo | pre 09-21 | sessions | per session | on/after 09-21 | sessions | per session |
|---|---|---|---|---|---|---|
| B.O.A.R.D | 10 | 2 | 5 | 22 | 2 | 11 |
| WMSAPI | 20 | 4 | 5 | 63 | 5 | 13 |
| WMS_Reports | 58 | 3 | 19 | 0 | 0 | — |
| PlanPal | 0 | 0 | — | 0 | 0 | — |

Discovery calls per session went **up**, not down, in both repos with data on both sides. Recorded
as observed. No causal claim: the post-09-21 sessions are the rollout sessions themselves, which
do an unusual amount of config archaeology, so this is very likely an artifact of what was being
worked on rather than an effect of the config. It is not evidence that a CLAUDE.md failed to earn
its tokens — B.O.A.R.D's CLAUDE.md did not exist for most of that window.

**`discoverytokens`** is `n/a` everywhere: the report does not break out tokens returned by tool
calls, and the transcripts do not record it in a form that can be attributed per tool call.

**WMSSite has no row.** It had zero sessions in the window, so there is nothing to measure. Not a
failure — simply no activity.

## What is still required for a real Procedure M run

- `/context` (not `/session-report`) in a fresh session per repo, for `sysprompt` / `skilldesc` /
  `mcpinstr`.
- One fresh session per repo, which an agent inside a session cannot open.
- For a true `wave=M` baseline: not recoverable. The earliest honest comparison point is now a
  `wave=0`-or-later row, with the Wave 0 config already applied.

## PHI note — do not generate the HTML report into a tracked repo

`/session-report`'s HTML output embeds the analyzer JSON verbatim, and that JSON's `top_prompts`
array carries **verbatim prompt text**. Of 87 entries in the 2026-09-22 run, 61 came from WMSAPI
(42) and WMS_Reports (19) — the two PHI-bearing repos — plus 57 `cache_breaks` entries. The skill
writes that file to the current working directory, which here is a git-tracked repo with an open
PR. The HTML was **not** generated. If it is ever wanted, strip `top_prompts` and `cache_breaks`
first and write it outside any repo.
