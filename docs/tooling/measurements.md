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
| 2026-09-22 | 0 | PlanPal | 11600 | 5900 | 609 | n/a | n/a | 0 | n/a |

The PlanPal row is the **first real Procedure M measurement** — an M-A `/context` capture from a
fresh session (Messages 1.3k), model `claude-fable-5-1`, 1M window. Absolute tokens, not estimated.
`sysprompt` is System prompt 5.0k + Memory files 6.6k = 11.6k; the split matters because Wave 1 adds
a repo `CLAUDE.md`, which lands in the Memory files half. `totalinput`/`cacheread%` are `n/a`
because `/context` is a snapshot, not a session total — the `agg` rows above carry those.

**Two findings from that single capture, both of which contradict the plan's assumptions:**

1. **`mcpinstr` is 609 tokens — not "probably the largest single line".** Review §2.2 identified MCP
   standing cost as the biggest unmeasured item and Task 4/D5 ordered a connector detach on that
   basis. Measured, it is **0.06% of the window** and the smallest category except Custom agents.
   The 2026-09-21 D5 entry already found the detach was a no-op; this puts a number on it. **The
   connector-detach line of work was chasing roughly nothing.**
2. **`System tools` is 17.8k — 3× `Skills` and by far the largest controllable line.** It is not a
   column in Procedure M and no task in this plan addresses it. Every measured category:
   System tools 17.8k, Memory files 6.6k, Skills 5.9k, System prompt 5.0k, Messages 1.3k,
   MCP tools 609, Custom agents 73. **The rollout has been optimizing the third-largest line while
   the largest was never measured.** Worth a decision before any further measurement work.

`Skills` at 5.9k is post-`skillOverrides`. Because no pre-change capture was ever taken, the
review's ~3,150-token claim for the 15 venture skills **remains unverified and now unverifiable** —
recorded as an open question, not as a win.

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
