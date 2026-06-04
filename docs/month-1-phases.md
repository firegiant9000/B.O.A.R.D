# Month 1 — Phased Implementation Plan

Decomposes ROADMAP.md **Month 1 — Hardening + Foundations** (8 scope items) into
dependency-ordered, individually-mergeable phases, grounded in the current codebase.

**Branch:** `feature/month-1-hardening`

---

## Dependency chain

The ordering is driven by one hard chain:

```
coordinate model (P2) ──> bbox (P3) ──> culling (P4)
                                    ├──> selection + real eraser (P5)
                                    └──> snapshot/checkpoint (P7)

safety net + tests (P1)  ── do first; unblocks safe refactoring
offline resilience (P6)  ── independent; parallelizable to a 2nd contributor
```

| Phase | Title | Roadmap items | Depends on |
|---|---|---|---|
| 1 | Safety net & test harness | 3, 4 | — (do first) |
| 2 | Coordinate model + pan/zoom | 5 | 1 |
| 3 | Schema bbox + draw perf/correctness baseline | 1 (perf), 6-data | 2 |
| 4 | Viewport culling | 6 | 2, 3 |
| 5 | Selection primitive + real eraser | 8, 1 (eraser) | 2, 3 |
| 6 | Offline resilience | 2 | 1 (parallelizable) |
| 7 | Snapshot / checkpoint system | 7 | 3 |

---

## Current state (verified against code)

- **No coordinate transform** — `DrawingCanvas.tsx` uses raw `nativeEvent.locationX/Y`;
  board-space == screen-space. No pan/zoom.
- **No throttling** — `onPanResponderMove` → `setCurrentPoints` every frame; full stroke
  saved as one doc at `app/board/[id].tsx:354`. Writes are per-*stroke* (not per-*point*),
  but there is no point coalescing or RDP simplification.
- **Eraser paints white** — saved as `tool:"eraser"`, rendered as a white line of
  `strokeWidth+10` (`src/components/DrawingCanvas.tsx:123-124`). Paths persist in Firestore.
- **No `bbox`** on any element doc; no snapshot/checkpoint collection.
- **Selection** exists only for text elements (`selectedTextId`), nothing for paths.
- **No error boundary** in `app/_layout.tsx`. Silent `.catch(() => {})` in `aiService`,
  `notificationService`, `ShareBoardModal`.
- **Zero tests**; CI (`.github/workflows/ci.yml`) runs only `tsc --noEmit`.
- **No offline** — no `enableIndexedDbPersistence`, no NetInfo, no reconnect/dedupe logic.

---

## Phases

### Phase 1 — Safety net & test harness *(do first, low risk)*
Unblocks safe refactoring of the canvas in later phases.

- Top-level React error boundary in `app/_layout.tsx`.
- Wire Sentry (free tier); replace every `.catch(() => {})` with `console.warn` +
  `Sentry.captureException` stub (`aiService.ts:25,31,36,45`, `notificationService.ts:44,81`,
  `friendService.ts:72`).
- Jest + `@testing-library/react-native`; mock Firestore via `@firebase/rules-unit-testing`.
- Unit tests for `boardService`, `sessionService`, `pathService`, `friendService` →
  **60% coverage on `src/services/`**.
- Add a `test` step to `.github/workflows/ci.yml`.

**Why first:** invasive canvas work (Phases 2–5) is unsafe with zero tests and silent
error swallowing. This is the regression net for everything after.

**Approved deps:** `jest`, `jest-expo`, `@testing-library/react-native`,
`@firebase/rules-unit-testing`, `@sentry/react-native`.

### Phase 2 — Coordinate model + pan/zoom *(architectural keystone)*
- Introduce viewport `{ x, y, scale }`; render-time transform `<g transform="translate scale">`.
  All elements stored in board-space; convert to screen only at paint time.
- Refactor `DrawingCanvas` input to map touch → board-space before storing points.
- Two-finger pan + pinch-zoom (mobile); wheel-zoom + drag-pan (web); 10%–800% range;
  fit-to-content + 100% shortcuts; pan inertia.

**Why second:** culling, selection, eraser hit-testing, and all M2+ tools depend on this
contract (ROADMAP Appendix A.1). Highest-risk refactor — isolate it.

### Phase 3 — Element schema bbox + drawing perf/correctness
- Compute & persist `bbox: {minX,minY,maxX,maxY}` (board-space) on every element write.
- Throttle `onPanResponderMove` to ~30Hz; coalesce points client-side; flush on stroke end.
- Ramer–Douglas–Peucker simplification (2–3px tolerance) **before** the Firestore write.
- Establish the **Android perf baseline** (Pixel 6a / Galaxy A): TTFP, dropped-frame %,
  writes/sec, JS-thread responsiveness — the regression gate per Appendix A.6.

**Why here:** `bbox` is the shared prerequisite for Phases 4, 5, 7; pairs naturally with
the write-path perf work.

### Phase 4 — Viewport culling
- Filter in-memory elements by `bbox ∩ viewport` before assembling the SVG tree;
  re-eval on pan/zoom (debounced 50ms).

**Why after 2+3:** needs the viewport (P2) and persisted bbox (P3).

### Phase 5 — Selection primitive + real eraser
- `useSelection` hook (own state slice); tap-to-select single element; bbox + handles;
  Delete (web) / trash (mobile).
- Real eraser: detect intersected paths (board-space hit-test) → `pathService.deletePath`
  per stroke; verify it survives refresh.

**Why grouped:** both are board-space hit-testing on bbox; share geometry primitives.

### Phase 6 — Offline resilience *(parallelizable after Phase 1)*
- `enableIndexedDbPersistence` (web); verify native default-on; "offline, will sync" banner;
  resilient listeners (auto-reconnect, dedupe on reattach).

**Why parallelizable:** independent of the canvas work — good candidate for a 2nd contributor.

### Phase 7 — Snapshot / checkpoint system
- Compact prior paths into `snapshots/{ts}` every ~500 writes (client-side compaction or
  Cloud Function); cold-load = latest snapshot + deltas since.

**Why last:** depends on stable bbox/schema; also the basis for M5 version-history, so least
urgent for M1 exit criteria.

---

## Cross-cutting gates

- **Mobile parity is a hard merge gate** from this month on — every canvas PR (Phases 2–5, 7)
  needs a real-Android measurement/screenshot, not emulator-only.
- **Phase 2 is the highest-risk refactor** — feature-flag the transform; A/B perceived
  smoothness; land Phase 1 tests first.

## Exit-criteria mapping (from ROADMAP Month 1)
- All scope items merged to `main` → Phases 1–7.
- Eraser works correctly → Phase 5.
- 60% service coverage via `jest --coverage` → Phase 1.
- Sentry receives a dogfood exception → Phase 1.
