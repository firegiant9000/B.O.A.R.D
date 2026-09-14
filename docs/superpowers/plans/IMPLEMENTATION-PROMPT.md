# Implementation Prompt — Months 5–6

Paste the block below into a fresh Claude Code session in this repo to start execution.
Update the **Gate status** section first if any gate has changed since 2026-09-09.

---

Execute the Months 5–6 implementation plan.

**Plan:** `docs/superpowers/plans/2026-09-09-months-5-6-monetization-and-growth.md` — 37 tasks.
**Spec (binding authority):** `ROADMAP.md` §§ Month 5 and Month 6. Rationale behind each task shape lives in `docs/month-5-phases.md` and `docs/month-6-phases.md` — read those only when a task's *why* is unclear; the plan is what you execute.
**Branch:** `feature/months-5-6-monetization-growth` — already exists, already carries the plan. **All 37 tasks land on this one branch.** Do not create a second branch, and do not branch per month or per track.

Use **superpowers:subagent-driven-development**: a fresh implementer subagent per task, a task review (spec compliance + quality) after each, and a broad whole-branch review at the end. Work continuously — do not check in with me between tasks, and do not post progress summaries. I asked you to execute the plan; execute it.

## Before Task 1

1. `git checkout feature/months-5-6-monetization-growth` and confirm the plan file is readable from there.
2. Resolve this plan's ledger workspace and check for an existing ledger. If one exists and names this plan, resume at the first task with no `Task <N>: complete` line — do not re-dispatch completed tasks.
3. Read the plan once. Note its **Global Constraints** — copy that block verbatim into every reviewer dispatch. Create one todo per task (37).
4. Record the green baseline before touching anything. Every number is a floor that must never regress:
   - `npx tsc --noEmit` — clean
   - `npx jest --ci --silent` — 44 suites / 512 tests
   - `npm --prefix functions test` — 10 suites / 109 tests
   - `npm run test:rules` — 2 suites / 83 tests
5. Run the pre-flight conflict scan and write the table to the ledger. Pay specific attention to the four multi-task files, which are the reason this is one branch:
   - `app/board/[id].tsx` and the hooks Task 1 extracts — Tasks 14–18, 22, 25, 26, 34–37
   - `firestore.rules` — Tasks 3, 7, 19, 25, 26, 27, 31
   - `functions/src/index.ts` — Tasks 5, 6, 8, 9, 10, 30, 32, 35
   - `src/types/index.ts` — Tasks 10, 16, 26, 35, 36
   - and these known pairs: 5/6/7 (shared create path + rules), 14/15 (shared `CursorPayload`), 2/7 (the deliberate seat-cap duplication between the limits table and rules), 23/24 (shared export path)

**Task 1 goes first and alone.** It decomposes `app/board/[id].tsx`, and twelve later tasks edit the hooks it produces. Its gate is mechanical and unusual: the existing 512 tests must pass **with zero edits to any test file**. If a test needs changing, the extraction changed behaviour — reject and redo that seam.

## Gate status as of 2026-09-09

The plan's **Human Gates** section (G1–G8) lists work no subagent can do. Current state:

- **G1 (Month 4 closed) — NOT MET.** `functions/` has never been deployed, the four `EXPO_PUBLIC_AI_*` flags still default OFF, and the legacy client OpenAI key path is still live. **Consequence:** Tasks 5–10 can be written and fully unit-tested, but cannot be verified end-to-end.
- **G2 (M3 migration cut over) — NOT MET.** The migration has only ever run against tests. Task 7 tolerates this either way.
- **G3 (Stripe account) — assume NOT MET** unless I tell you otherwise. Tasks 8–10 are implementable and unit-testable against fixtures without it.
- **G4 (pricing confirmed) — NOT MET.** Task 13's displayed price is the only thing that waits; the limits structure is unblocked.
- **G5 (PostHog project) — assume NOT MET.** Task 21's seam must no-op without a key rather than throw; that is already a required test.
- **G6 (marketplace accounts) — NOT MET.** Blocks *shipping* Tasks 20 and 33, not building them.
- **G7 (Android device) — unknown.** Affects final manual verification only.
- **G8 (outreach, content, launch) — out of scope for this plan entirely.**

**Rule for gated tasks — this matters more than anything else in this prompt:** implement the task, write and run its unit tests, commit it, and **park only the verification that genuinely requires the gate**, with a ledger entry saying what is unverified and why. Then keep going. Do **not** stall the run waiting on a gate, and do not skip a task because its gate is unmet. Tasks 19, 21, 23, 29 and 31 have no dependencies at all and are the natural fillers whenever the monetization spine is parked.

## Constraints that override your defaults

- **Never add Claude attribution to a commit** — no `Co-Authored-By` trailer, no "Generated with Claude Code" line. Commit as the repo owner.
- **Commit per task**, conventional-commit subject, on the one branch. Do not push, do not open a PR, do not merge to `main`.
- Do not lower the 60% coverage gate, and do not weaken or delete an existing test to make a new one pass.
- Only these new dependencies are approved: `stripe` (functions only), `expo-audio`, `posthog-js`, `posthog-react-native`, `mathjax-full` (functions only), `shiki`. Anything else — stop and ask.
- Never dispatch two implementer subagents at once. Tasks that share a file go strictly sequentially.
- Specify the model explicitly on every dispatch; the plan's Task Map gives a tier per task.
- Some tasks carry literal test and implementation code; others carry test *intent* plus representative assertions, and the plan's Self-Review section says which are which. For the latter, the implementer writes tests from the stated behaviour and the reviewer checks **the behaviour, not a transcription**.

## Rulings, not stalls

Conflicts, ambiguities, plan defects, a cap you would have asked to exceed — decide them yourself, record each in the ledger as `Ruling: <what you decided> — <why> — <what it costs if wrong>`, and continue. The spec is the binding authority; the plan is its argument.

Stop and ask me only for: an irreversible or destructive operation; a security-sensitive action; a side effect outside this branch (a merge, a push, a publish, a deploy, a marketplace submission); or a plan defect so bad that every path forward is a guess.

When you finish, give me the full list of rulings you made, in order, each with what it costs if it was wrong.
