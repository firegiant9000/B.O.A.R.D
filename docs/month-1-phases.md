# Month 1 — Hardening + Foundations: Completion Record

> **Status:** All 7 phases delivered and merged to `main` via PR #89
> (Phase 1 in `84a8222`; Phases 2–7 in `2e146c4`, plus cold-load snapshot fix
> `56d65d2`). Month 1 is closed.
>
> **Test status:** 16 suites, 140 tests passing. `npm run test:coverage` enforces
> the 60% global lines/statements gate from CI.
>
> The original forward-looking plan (scope per phase, dependency chain,
> "Why first / second / …" rationale) is preserved in git at commit `fbdb075`
> and the per-phase commits. Pull it up if you need the deeper context for any
> single phase; this document is the retrospective record + carry-forward list.

---

## What shipped

Mapping to ROADMAP.md → Month 1 scope items.

| Phase | Roadmap item(s) | Title | Key files |
|---|---|---|---|
| 1 | 3, 4 | Safety net & test harness | `src/lib/errorReporting.ts`, `src/components/ErrorBoundary.tsx`, `src/test-utils/firestoreMock.ts`, `babel.config.js`, `package.json` (jest config), `.github/workflows/ci.yml` |
| 2 | 5 | Coordinate model + pan/zoom | `src/lib/viewport.ts`, `src/hooks/useViewport.ts`, `src/components/ZoomControls.tsx`, `DrawingCanvas.tsx`, `app/board/[id].tsx` |
| 3 | 1 (perf), 6 (schema) | `bbox` + draw perf/correctness | `src/lib/simplify.ts`, `app/board/[id].tsx` (write path, `STROKE_SAMPLE_MS`, `RDP_TOLERANCE`), `src/services/pathService.ts` (bbox compute + back-fill), `src/types/index.ts`, `docs/perf-baseline.md` |
| 4 | 6 | Viewport culling | `src/lib/culling.ts`, `src/hooks/useThrottledValue.ts`, `app/board/[id].tsx` (culled lists) |
| 5 | 8, 1 (eraser) | Selection primitive + real eraser | `src/lib/hitTest.ts`, `src/hooks/useSelection.ts`, `src/components/SelectionOverlay.tsx`, `Toolbar.tsx` (`select` tool), `app/board/[id].tsx` (eraser delete loop) |
| 6 | 2 | Offline resilience | `src/config/firebase.ts` (`persistentLocalCache` + `persistentMultipleTabManager`), `src/lib/connectivity.ts`, `src/hooks/useConnectivity.ts`, `src/components/OfflineBanner.tsx`, `pathService.subscribeToBoardPaths` (metadata reporter) |
| 7 | 7 | Snapshot / checkpoint | `src/services/snapshotService.ts` (`SNAPSHOT_INTERVAL = 500`), `firestore.rules` (snapshots subcollection), `app/board/[id].tsx` (cold-load + compaction trigger) |

---

## Senior-call deviations from the original plan

Kept for institutional memory — these decisions are loaded with consequences that show up in M2 and beyond.

### Phase 1 — Safety net & test harness
1. **Sentry seam, native SDK deferred to M2.** `@sentry/react-native` needs a DSN + native build (EAS, M2) to function. Built the abstraction the roadmap calls a "stub" instead; swap to the real SDK is a one-liner in `errorReporting.ts`.
2. **Mocked Firestore, not `@firebase/rules-unit-testing`.** Services import a singleton `db` pinned to prod; emulator tests would risk prod writes and need emulator-in-CI. Emulator-backed rules tests belong in the M3 rules work.
3. **Added `babel-plugin-dynamic-import-node` (test env only).** Jest can't execute native `import()`, which several services lazy-load with. Scoped to `env.test`; does not affect Metro/production.
4. **Plan-vs-code correction:** the original plan cited `friendService:72` as a silent catch — actual site was `ShareBoardModal.tsx:72`.

### Phase 2 — Coordinate model + pan/zoom
1. **`react-native-gesture-handler`, not `PanResponder`.** Gesture-handler composes simultaneous gestures (1-finger draw vs. 2-finger pan/pinch) far more cleanly. No new dependency — already in the tree.
2. **The "100% shortcut" is `reset`** — returns to the identity viewport (scale 1 *and* origin 0,0). Fixed-focal 100% can fold in later if anyone asks.
3. **`enablePanZoom` feature flag retained** in `[id].tsx` per the cross-cutting "feature-flag the transform" gate. One-line rollback if mobile parity regresses.

### Phase 3 — `bbox` + draw perf/correctness
1. **`bbox` on paths only; notes/text derive theirs from `position + size`** at cull time. Same culling result, no schema bloat — text geometry is already exact from its stored width/height.
2. **Two-stage point reduction.** 30 Hz input coalescing caps points *at the source*; RDP then removes shape-redundant points *before* the write. Both client-side, pre-Firestore. `DrawingCanvas` keeps a separate distance-based render simplifier purely for paint smoothing.
3. **Perf baseline is a documented template, not measured numbers.** The Appendix A.6 metrics need a physical Pixel 6a / Galaxy A + Expo perf monitor. The *intervention* the table measures (30 Hz + RDP-before-write + persisted `bbox`) is shipped and tested; the numbers fill in on-device. → carries forward, see Carry-forward §3.

### Phase 4 — Viewport culling
1. **Throttle, not debounce.** A trailing debounce never fires *during* a continuous pan; off-screen content wouldn't mount until the gesture stopped. 50 ms leading+trailing throttle re-evals ~20×/s while still landing on the resting viewport.
2. **200 px screen-space margin ring.** Culling lags the live viewport (throttle), so a buffer keeps just-off-screen content mounted and kills one-frame pop-in. Screen-space (not board-space) keeps it constant at any zoom.
3. **Conservative keeps.** A path with no `bbox` (degenerate/empty points) and the text element currently being edited are never culled — correctness over a marginal render saving.

### Phase 5 — Selection + real eraser
1. **Text keeps its bespoke selection.** `selectedTextId` / `TextElementView` need editing + resize semantics the generic slice doesn't yet model; unification waits for M2 group transforms. → carries forward, see Carry-forward §4.
2. **Selection handles are decorative in M1** (no move/resize) — group transforms are explicitly M2 in the ROADMAP. M1 ends at: select → show bbox/handles → delete.
3. **Legacy white-eraser docs still render white.** Only the *write* path changed; the `DrawingCanvas` white fallback stays so pre-Phase-5 boards are unaffected. → carries forward, see Carry-forward §7.

### Phase 6 — Offline resilience
1. **No NetInfo.** The deliverable doesn't require it and it's a new native dep (CLAUDE.md: no deps without approval). Firestore snapshot metadata + `navigator.onLine` cover the banner cross-platform with zero bundle cost.
2. **`persistentLocalCache`, not `enableIndexedDbPersistence`.** The imperative API the plan named is deprecated in firebase v9+; the cache-settings API is the supported path on v12.
3. **"Native default-on" is corrected, not verified.** That claim holds for `@react-native-firebase`, *not* the firebase JS SDK this repo uses — on RN the JS SDK has no IndexedDB and uses an in-memory cache. Offline writes still queue/flush within a session, but durable native persistence is a future migration. → carries forward, see Carry-forward §5.
4. **Reconnect/dedupe leans on the SDK + full-snapshot replacement.** Subscriptions replace state wholesale (`setPaths(incoming)`), so a reattached snapshot can't duplicate — no extra dedupe layer.

### Phase 7 — Snapshot / checkpoint
1. **Client-side compaction; Cloud Function variant deferred to M5.** Functions require Blaze (project is on Spark); roadmap places Functions in M5. Mirrors the Phase 1 "build the abstraction, defer the server infra" call. → carries forward, see Carry-forward §6.
2. **Non-destructive checkpoint — pruning shipped but not wired.** A watermark-scoped `onSnapshot` *cannot observe deletions of snapshotted strokes*, so the real eraser / undo would silently fail or resurrect strokes on reload. The full-collection listener stays the authoritative live source; the snapshot is a cold-load accelerator + M5 version-history substrate. Watermark-scoped live listening + pruning needs deletion tombstones — explicitly M5. → carries forward, see Carry-forward §6.
3. **Doc-size risk noted.** A snapshot is one Firestore doc (1 MiB cap). 500 RDP-simplified strokes fit; chunked / Storage-backed snapshots for very dense boards are an M5 follow-up. → carries forward, see Carry-forward §6.

---

## Carry-forward to M2+

The deferrals every phase made, each tagged with its owning milestone. These are real residual items, not optional polish.

1. **[M2] Real Sentry SDK.** Swap `errorReporting.ts` from the console-only seam to `@sentry/react-native` + a DSN. The M1 exit criterion "Sentry receives a dogfood exception" is **not actually met today** — re-meeting it lands here. Tracked as issue #3.
2. **[M2] Selection unification on text.** Fold `selectedTextId` / `TextElementView` into the unified `useSelection` slice as part of M2 group-transform work. Tracked as part of issue #19.
3. **[M2 and onward] Android perf baseline numbers.** Fill in `docs/perf-baseline.md` on a real Pixel 6a / Galaxy A. **Every canvas PR from now on is gated on a measurement** (cross-cutting mobile-parity rule). Tracked as part of issue #1.
4. **[M5] Cloud-Function snapshot compaction.** Move the client-side compactor to a Function once Blaze is on. Today's `snapshotService.createSnapshot` already returns the correct shape; the Function variant just replaces the caller. Aligns with issue #34 (move all AI / cron / server work to Cloud Functions).
5. **[M5] Snapshot pruning enabled + watermark-scoped listeners.** Needs deletion tombstones so the eraser / undo / version-history can't resurrect snapshotted-and-deleted strokes. Don't enable `pruneSnapshottedPaths` until the tombstone scheme lands.
6. **[M5] Storage-backed snapshots for dense boards.** Single Firestore doc is fine at 500 RDP-simplified strokes; chunked / Storage-backed docs for boards that crossed the doc-size budget.
7. **[hygiene, anytime] Legacy white-eraser path backfill.** Optional one-off script to convert pre-Phase-5 `tool: "eraser"` strokes (still rendered white) into actual deletions. Not blocking anything.
8. **[Year-2] Native durable persistence.** On the firebase JS SDK, RN has in-memory cache only — offline writes queue within a session but don't survive an app kill. Real native persistence would require migrating to `@react-native-firebase`. Tracked in the Backlog milestone area.

---

## Cross-cutting gates (still apply to M2+ canvas work)

These were stated as M1 process gates; they remain in force for every later canvas-touching PR.

- **Mobile parity is a hard merge gate.** Every canvas PR from M2 onward needs a real-Android measurement / screenshot in the PR description — not emulator-only. The `docs/perf-baseline.md` template is the regression yardstick.
- **Feature-flag risky canvas refactors.** Phase 2 kept `ENABLE_PAN_ZOOM` for exactly this reason. Apply the same discipline to multi-select / group-transform (M2), Skia migration (Year-2), CRDT swap (Year-2).

---

## Exit-criteria status (from ROADMAP Month 1)

- ✅ **All scope items merged to `main`** (Phases 1–7, PR #89).
- ✅ **Eraser works correctly** (Phase 5 — verified: erase a stroke, refresh, stays erased).
- ✅ **≥ 60% service coverage via `jest --coverage`** (gate set in `package.json`; current run sits well above on services).
- ⚠️ **Sentry receives a dogfood exception** — *not yet met.* Seam is in place; real SDK lands in M2 (carry-forward §1).
