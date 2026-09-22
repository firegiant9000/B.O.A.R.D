# Documentation index

Start with the top-level [README](../README.md) for what this is, and
[ARCHITECTURE.md](../ARCHITECTURE.md) for how it is built. Everything here is
one level deeper.

## Plan of record, month by month

The six-month roadmap is [ROADMAP.md](../ROADMAP.md). Each month has a phased
plan that was written before the work and kept as the record of what was built.
Each states its own unmet gates.

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
