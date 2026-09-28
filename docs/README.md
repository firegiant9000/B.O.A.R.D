# Documentation index

Start with the top-level [README](../README.md) for what this is, and
[ARCHITECTURE.md](../ARCHITECTURE.md) for how it is built. Everything here is
one level deeper.

## Plan of record, month by month

The six-month roadmap is [ROADMAP.md](../ROADMAP.md). Months 2–6 each keep the
phased plan written before the work, as the record of what was built; Month 1
keeps a completion record instead, its forward-looking plan preserved in git at
commit `fbdb075`. Each states its own unmet gates.

| Month | Theme | Document |
|---|---|---|
| 1 | Hardening + foundations | [month-1-phases.md](month-1-phases.md) |
| 2 | Production readiness + auth polish | [month-2-phases.md](month-2-phases.md) |
| 3 | Multi-tenancy + workspaces | [month-3-phases.md](month-3-phases.md) |
| 4 | Sessions + the AI gateway | [month-4-phases.md](month-4-phases.md) |
| 5 | Monetization infrastructure | [month-5-phases.md](month-5-phases.md) |
| 6 | Growth + Decide | [month-6-phases.md](month-6-phases.md) |

## Runbooks

- [functions-deploy-runbook.md](functions-deploy-runbook.md) — deploying the
  Cloud Functions AI gateway and cutting the client over. Not yet executed.
- [month-3-phase-9-migration-runbook.md](month-3-phase-9-migration-runbook.md) —
  backfilling the workspace tenancy primitive onto legacy documents. Ready to
  run on staging; do not run on prod until the staging soak is complete.
- [perf-baseline.md](perf-baseline.md) — the canvas performance regression gate.
  Template; the on-device columns are unfilled.

## Reference

- [build-and-release.md](build-and-release.md) — EAS profiles, environment
  variables and secrets, Sentry, the installable web build.
- [authentication.md](authentication.md) — email/password, reset, verification,
  the Google Sign-In seam.
- [deep-linking.md](deep-linking.md) — the `boardapp://` scheme, universal links,
  and the share-into-app receiver.
- [keyboard-shortcuts.md](keyboard-shortcuts.md) — the web binding table and the
  native hardware-keyboard hooks.

## Reproducing these numbers

The README's figures were produced by these commands at the commit it names. Run
them at that commit to reproduce, or at `HEAD` to refresh.

| Figure | Command |
|---|---|
| Type-check | `npx tsc --noEmit` |
| App suite | `npm test -- --ci` |
| Functions suite | `npm --prefix functions test -- --ci` |
| Rules suite | `npm run test:rules` (needs JDK 21+) |
| TypeScript lines, incl. tests | `git ls-files -z -- 'src/**/*.ts' 'src/**/*.tsx' 'app/**/*.ts' 'app/**/*.tsx' 'functions/src/**/*.ts' \| xargs -0 wc -l \| tail -n 1` |
| Callables / triggers | `ls functions/src/callable \| wc -l`, `ls functions/src/triggers \| wc -l` |
| Service modules | `ls src/services/*.ts \| wc -l` |
| Rules lines | `wc -l firestore.rules` |

"Service modules" counts top-level modules in `src/services/`, including platform
variants and excluding tests. Use the shell glob above rather than a git pathspec:
in `git ls-files 'src/services/*.ts'` the `*` crosses `/`, so it also counts the
test files under `src/services/__tests__/`.
