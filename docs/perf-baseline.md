# Canvas Performance Baseline (Month 1 / Phase 3)

The numbers captured here are the **regression gate** for every canvas change from
Month 1 onward (ROADMAP Appendix A.6). Mobile parity is a hard merge gate: a canvas
PR that regresses any metric on the baseline device does not merge.

> **Status:** Template — fill in `MEASURED` columns on a real device. The code-side
> Phase 3 work (30Hz move coalescing, RDP-before-write, persisted `bbox`) is the
> intervention this baseline measures.

## Baseline device

| Field | Value |
|---|---|
| Device | _e.g. Pixel 6a / Galaxy A54_ |
| OS version | _Android ___ |
| Build | _Expo Go / EAS preview_ |
| App commit | _git sha_ |
| Date measured | _YYYY-MM-DD_ |

## Targets vs. measured

| Metric | Target | Measured (pre-P3) | Measured (post-P3) |
|---|---|---|---|
| Time-to-first-paint, board with 500 strokes | ≤ 1.5s | | |
| Dropped frames during 30s continuous draw | ≤ 5% | | |
| Time-to-paint after pan/zoom | ≤ 1 frame (16ms) | | |
| Firestore writes / second during sustained draw | ≤ 10 | | |
| Listener count per active user | ≤ 5 | | |
| Memory footprint (RN heap, 1000-element board) | ≤ 100MB | | |
| JS thread responsiveness (worst-case input → render) | ≤ 100ms | | |

## How to measure

1. **Seed a board** with ~500 strokes (draw, or script `savePath` in a loop).
2. **TTFP:** cold-open the board; time from navigation to first stroke painted
   (React DevTools Profiler commit, or a manual `performance.now()` mark in
   `loadBoard`).
3. **Dropped-frame %:** draw continuously for 30s; read the Expo/RN perf monitor
   (shake → Show Perf Monitor) UI + JS FPS; `dropped% = (60 - avgFPS) / 60`.
4. **Writes/sec:** Firestore console → Usage, or count `savePath` calls over the
   draw window. With 30Hz coalescing + per-stroke (not per-point) writes this
   should sit well under 10/s.
5. **JS responsiveness:** worst-case input→render latency from the Profiler during
   a multi-user draw.

## Notes

- Phase 3 reduces points-per-stroke two ways: 30Hz sampling at input
  (`STROKE_SAMPLE_MS`) and RDP simplification before the write (`RDP_TOLERANCE`,
  board-space). Expect the largest win in writes/sec and per-stroke doc size.
- `bbox` is persisted per stroke now but is not yet *used* to cull — that is
  Phase 4. TTFP on large boards improves there, not here.
- Re-run this table after Phase 4 (culling) and any later canvas PR.
