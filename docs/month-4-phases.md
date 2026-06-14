# Month 4 — The Wedge: Sessions + AI: Phased Implementation Plan

**Author:** Arlo Kharod
**Drafted:** 2026-06-14
**Branch:** `feature/month-4-sessions-ai` (off `main`)
**Source scope:** `ROADMAP.md` § Month 4 (items 1–12), Appendix B (AI), Appendix C (collaboration).
**Status:** Planning draft — sequencing + per-phase contracts, not yet implemented.

> **How to read this:** Month 4 turns the `session` primitive + AI into the
> reason someone picks B.O.A.R.D over Excalidraw. The work splits into three
> tracks that can largely proceed in parallel after the foundation lands:
> **(A) server-side AI + quota**, **(B) session experience**, **(C) realtime
> collaboration + embeds**. The phases below are ordered by dependency, not by
> roadmap item number. The roadmap item each phase satisfies is called out so
> nothing is dropped.

---

## Investigation: current state by layer

### Current behavior and where it's implemented

- **AI is 100% client-side.** `src/services/aiService.ts` calls
  `https://api.openai.com/v1/chat/completions` directly with a Bearer token. The
  OpenAI key is stored in `AsyncStorage` (`board_openai_key`) **and** Firestore
  (`users/{uid}/private/apiKeys.openaiKey`). `generateSessionSummary()` gathers
  sticky/text content, builds a prompt, and uses `gpt-4o-mini` when an image data
  URL is supplied (vision), else `gpt-3.5-turbo`.
- **Vision capture is web-only.** `src/utils/canvasCapture.ts#captureSvgAsPng`
  clones the SVG → canvas → data URL (≤1024px, ≤900KB). Native platforms return
  `null`, so mobile sessions cannot feed an image into the summary.
- **Sessions already carry the M4 hooks.** `Session` (`src/types/index.ts`) has
  `workspaceId`, `summary?`, `canvasSnapshot?`, `status`, `joinCode?`.
  `sessionService` exposes `updateSessionSummary`, `updateSessionSnapshot`,
  `getSessionsByBoard`, `getSessionsForUser`, `getUpcomingSessions`. There is **no
  session-history UI** and **no lobby / in-session / recap UX** beyond create +
  join + view.
- **Quota is a plumbed stub.** `quotaService.checkQuota(workspaceId, resource)`
  returns `true` for everyone; `QuotaResource = "board" | "session" | "aiSummary"`.
  Call sites (`createBoard`, `createSession`) already call `assertQuota`. `aiSummary`
  is declared but not yet gated anywhere.
- **Presence exists; cursors do not.** `presenceService` writes
  `boards/{id}/presence/{uid}` (lastSeen / lastActive) and exposes subscriptions.
  There is no live cursor position, no ephemeral side channel, no follow-mode.
- **Canvas model.** Elements are discriminated by `type`: `DrawPath`, `TextElement`,
  `ShapeElement`, `TextNote` (legacy sticky), `ImageElement`. `useSelection()`
  holds selected IDs and transforms; `SelectionOverlay` paints handles;
  `src/lib/spatialIndex.ts` (rbush) does culling + hit-test. Z-order is per-layer.
- **Routing.** Expo Router with `(auth)`, `(tabs)`, `board/[id]`, `b/[code]`,
  `session/[id]`, `session/create`, `share`, `notifications`. **No `/embed` route.**
- **No backend.** No `functions/` directory; `firebase.json` has only Firestore +
  emulator config. Everything is client + Firestore today.
- **Tests.** Jest unit tests under `src/**/__tests__`; Firestore rules tests in
  `firestore-tests/`; CI runs `tsc --noEmit`, `test`, `test:rules`; 60% coverage gate.

### Required changes by layer

| Layer | Change |
|---|---|
| **Backend (NEW)** | Stand up `functions/` (Firebase Cloud Functions, TS). AI gateway, embed-token mint, cost/usage logging, callable + HTTPS endpoints. This is the single biggest new surface in M4. |
| **Data model** | `session`: structured `summary` object (not just string), `agenda`, `endedAt`, `participants[]` snapshot. New `boards/{id}/cursors/{uid}` (ephemeral). New `workspaces/{id}/aiUsage/{period}` + `workspaces/{id}/aiLog/{callId}` (cost telemetry). New element type `connector` is a stretch (Appendix A); OCR/explain produce existing `TextElement`s; text→diagram produces existing `ShapeElement`/`TextElement`s. |
| **Services** | `aiService` becomes a thin client that calls the Cloud Function (callable), no key. New `cursorService` (side channel). `quotaService` learns `aiSummary` + generic AI-call accounting. New `embedService` (mint/verify token client side). `sessionService` gains lifecycle transitions + recap export. |
| **Rules** | Gate `cursors` subcollection (workspace member, own-uid write). Gate `aiUsage`/`aiLog` (read: workspace admin; write: Functions only). Embed read path must be token-scoped and **rules-tested** (Appendix C.4, roadmap risk row). |
| **Client UI** | Session lobby / in-session / recap screens; session-history tab; live cursor + follow-mode overlay layer (must be a separate ephemeral SVG layer — Appendix A.4 hard rule); embed-mode chrome strip; AI affordances (perfect-it, OCR, explain, text→diagram); AI usage settings page. |
| **Config** | `app.json` deep-link schema already declared; add `/embed/*` to web routing. EAS/Functions deploy wiring. Secrets: OpenAI + Google Vision keys live in Functions config, never client. |

### Reporting / analytics impact

- Per-request AI cost logging (model, tokens, $ estimate) into `aiLog` powers the
  M5 plan-gating decisions and the M4 cost benchmark (< $0.02/session avg).
- Session lifecycle events feed the M3 activity feed ("Session Z ended with N
  participants") and the M6 analytics funnel (session completed, summary generated).

### Migration / backfill needs

- **OpenAI key removal:** one-time notice + delete of `users/{uid}/private/apiKeys`
  after the Cloud Function path is live (roadmap item 1). Do **not** delete until
  the function is verified in prod, else summaries break.
- **Session summary shape:** `summary` moves from `string` to a structured object.
  Reader must tolerate the legacy string form (schema-version tolerance, per the
  roadmap element-schema-churn risk). No destructive migration required.

---

## Phase ordering at a glance

| Phase | Title | Roadmap items | Track | Depends on | Complexity |
|---|---|---|---|---|---|
| 1 | Cloud Functions foundation + AI gateway | 1 | A | — | **High** |
| 2 | AI quota + cost telemetry | 12 | A | 1 | Medium |
| 3 | AI summary v2 (structured + mobile capture) | 3 | A/B | 1 | Medium |
| 4 | Session lifecycle UX (lobby / in-session / recap) | 2 | B | 3 | High |
| 5 | Session history tab | 4 | B | 3 | Low–Med |
| 6 | Live cursors (ephemeral side channel) | 6 | C | — | High |
| 7 | Follow-user mode | 7 | C | 6 | Low–Med |
| 8 | Embeddable boards (iframe + signed JWT) | 5 | C | 1 | High |
| 9 | AI shape recognition + auto-perfect (client-side) | 8 | A | — | Medium |
| 10 | AI handwriting OCR (region → text element) | 9 | A | 1, 2 | Medium |
| 11 | AI "explain selection" | 10 | A | 1, 2 | Low–Med |
| 12 | AI text → diagram (Mermaid → native elements) | 11 | A | 1, 2 | High |

**Critical path:** Phase 1 unblocks the entire AI track (2, 3, 10, 11, 12) and the
embed-token mint (8). Phases 6/7 (cursors/follow) and 9 (client-side shape
recognition) have **no** dependency on the backend and can run in parallel from day
one — good candidates for a second contributor. Phases 4 and 5 are the
daily-driver value and should not slip behind the AI feature breadth (10–12) if
time is tight; those three are the most deferrable.

---

## Phase 1 — Cloud Functions foundation + AI gateway

**Goal:** Stand up the backend and move every AI call server-side so the client
never holds a key. Satisfies roadmap item 1; unblocks 2, 3, 8, 10, 11, 12.

**Scope:**
- Initialize `functions/` (TypeScript, Node 20, Firebase Functions v2). Add to
  `firebase.json`. Wire EAS/CI deploy and emulator support for local dev.
- AI adapter module `functions/src/ai/` (provider behind an interface, per
  Appendix B.5 — model name is one config change). OpenAI key + Google Vision key
  in Functions runtime config / secrets, never shipped to the client.
- A single **callable** `generateSummary` to start, plus a generic `aiInvoke`
  shape that later AI phases (OCR, explain, diagram) extend rather than reinvent.
- Per-workspace rate limiting at the function boundary (token-bucket in Firestore
  or in-memory + Firestore backstop).
- Client: `aiService` rewritten to call the callable via the Firebase SDK; delete
  all key load/save (`loadOpenAIKey`, `setOpenAIKey`, `getOpenAIKey`, AsyncStorage
  `board_openai_key`). Add the one-time `users/{uid}/private/apiKeys` cleanup with
  a user-facing notice.

**Key changes:** `functions/` (new), `firebase.json`, `src/services/aiService.ts`,
remove client OpenAI key UI in `app/(tabs)/profile.tsx` (verify), `firestore.rules`
(lock `aiLog`/`aiUsage` to Functions-only writes).

**Risks & mitigations:**
- *Cold starts on free tier* — acceptable for v1 (roadmap-accepted); set min
  instances to 0, surface a "summarizing…" state.
- *Blaze billing required* for Functions — roadmap budget already plans Blaze in
  M5; M4 needs it earlier. Set the hard spend caps **before** first deploy.
- *Breaking summaries during cutover* — keep the client path behind a flag until
  the function is verified in prod; only then delete keys.

**Tests:** Function unit tests (mock provider) for prompt assembly + rate limit;
emulator integration test for the callable; rules test that `aiLog`/`aiUsage` reject
client writes.

**Exit:** A summary generates end-to-end through the function with no client key;
`apiKeys` cleanup ships behind a notice.

---

## Phase 2 — AI quota + cost telemetry

**Goal:** Make `quotaService` a real choke point for AI and log per-call cost.
Satisfies roadmap item 12; the gate stays soft (free-for-all today) but the meter
and the wiring become real, ready for M5 enforcement.

**Scope:**
- `workspaces/{id}/aiUsage/{period}` counters (calls, tokens, $ estimate) updated
  transactionally by the function after each AI call. `workspaces/{id}/aiLog/{id}`
  append-only per-call record (model, token count, $ estimate, feature, uid).
- `quotaService` learns `aiSummary` + a generic `aiCall` resource; `assertQuota`
  is called inside the function before invoking the provider. Returns true today
  but reads real counters so M5 only flips limits, not plumbing.
- Workspace AI-usage settings page (read-only this month): calls used, $ this
  period, per-feature breakdown. Owner/admin only (rules).
- Hard daily spend cap set on the OpenAI + Google Cloud dashboards (ops task,
  documented in the runbook).

**Key changes:** `functions/src/ai/`, `src/services/quotaService.ts`, new
`src/services/aiUsageService.ts`, new settings screen, `firestore.rules`.

**Risks:** *Quota leak = cost spike* (roadmap top risk). Mitigate with the
function-side `assertQuota` + dashboard hard caps as the backstop.

**Tests:** Unit test counter increments + cost estimate math; rules test that a
non-admin cannot read `aiLog`.

**Exit:** Every AI call logs cost; the usage page reflects it; caps are set.

---

## Phase 3 — AI summary v2 (structured + mobile capture)

**Goal:** Fix mobile snapshot capture and make the summary a structured artifact.
Satisfies roadmap item 3 (and finishes the Tier-0 work in Appendix B.2).

**Scope:**
- Native capture via `react-native-view-shot` (**new dependency — needs explicit
  approval** per working profile); keep `captureSvgAsPng` for web. Unify behind a
  `captureBoardImage()` that returns a data URL on all platforms.
- Function returns structured JSON: `{ tldr, actionItems[], decisions[],
  openQuestions[] }` (Appendix B.2). Bias the prompt toward structured output;
  Mermaid-style strictness not needed here.
- Two modes: short ("TL;DR") and detailed. Render as a structured card, not a blob.
- `Session.summary` becomes the structured object; reader tolerates the legacy
  string form (schema-version tolerance).

**Key changes:** `functions/src/ai/summary.ts`, `src/utils/canvasCapture.ts`,
`src/services/aiService.ts`, `src/types/index.ts` (summary shape), summary card
component.

**Risks:** *Summary quality on mostly-drawings is poor* (roadmap top AI risk).
Mitigate by forcing structured input (agenda + text), JSON-schema output, and the
M4 benchmark (< $0.02/session, ≥ 3.5/5 user rating).

**Tests:** Snapshot test the structured card render (short + detailed); function
test asserting JSON shape + graceful fallback on a non-JSON model reply.

**Exit:** A mobile session produces an image-fed structured summary; cost tracked.

---

## Phase 4 — Session lifecycle UX (lobby / in-session / recap)

**Goal:** Build the pre/in/post-session experience. Satisfies roadmap item 2.

**Scope:**
- **Lobby:** who's joining, board preview, editable `agenda` field on the session.
- **In-session:** elapsed timer, "raise hand" + lightweight reactions (reuse the
  Phase 6 cursor side channel for ephemeral signals — do **not** persist to paths).
  Voice is **explicitly deferred to M5** (roadmap allows; the M5 meeting-app
  integration is the A/V story).
- **Post-session:** show the Phase 3 summary, exportable recap (PDF), shareable
  read-only board URL (uses the Phase 8 embed link when available; falls back to
  the existing invite link until then).
- `sessionService` lifecycle transitions: `scheduled → active → ended` with
  `endedAt` + a frozen `participants[]` snapshot; emit M3 activity-feed events.

**Key changes:** `app/session/` screens, `src/services/sessionService.ts`,
`src/types/index.ts` (`agenda`, `endedAt`), PDF export util.

**Risks:** PDF export parity across web/native (use a platform-split util). Reaction
spam — throttle via the same side-channel limits as cursors.

**Tests:** Service unit tests for lifecycle transitions + event emission; render
tests for the three states.

**Exit:** schedule → notify → join → collaborate → end → summary → shareable recap,
verified in one real 30-min session (the roadmap M4 verification).

---

## Phase 5 — Session history tab

**Goal:** A "Past sessions" surface — the daily-driver value prop. Item 4.

**Scope:** New tab/section listing ended sessions with summary, snapshot thumbnail,
attendees, duration. Backed by `getSessionsForUser` / `getSessionsByBoard` (exist)
plus workspace scoping. Mobile parity: vertical recap cards.

**Key changes:** `app/(tabs)/` (new tab or section under an existing one),
`src/services/sessionService.ts` (a `getEndedSessions(workspaceId)` query +
Firestore index).

**Risks:** Unbounded query cost — paginate; add the composite index in
`firestore.indexes.json`.

**Tests:** Query/service unit test; render test for the recap card list + empty state.

**Exit:** A user who ran several sessions sees organized recap cards on web + mobile.

---

## Phase 6 — Live cursors (ephemeral side channel)

**Goal:** Render every active user's pointer in real time. Satisfies item 6. **No
backend dependency — can start day one.**

**Scope:**
- Write cursor position to `boards/{id}/cursors/{uid}` (Firestore v1), **not** the
  path collection — keeps cursor jitter off the persisted-state listeners
  (Appendix A.5 M4 evolution).
- Throttle writes to ~20Hz; subscribers render ~10–15Hz. Show name + per-user
  color + tool icon (per-user color assigned at workspace join — Appendix C.1).
- **Hard rule (Appendix A.4):** cursors render in a *separate top-layer SVG group*;
  never re-render the element tree when only cursor state changes.
- Design the `cursorService` API so the transport is swappable — if Firestore is
  too laggy at scale (likely mid-M4), drop in Ably / Liveblocks free tier behind
  the same interface with a Firestore fallback (roadmap risk row).

**Key changes:** new `src/services/cursorService.ts`, new ephemeral overlay layer
in `app/board/[id].tsx` / a dedicated `CursorLayer` component, `firestore.rules`
(own-uid write, workspace-member read), cleanup on leave/disconnect.

**Risks:** *Side-channel free tier blows up if throttling regresses* (roadmap risk)
— server/client throttle + weekly volume monitor + Firestore fallback so it
degrades, not breaks. Perf regression from re-rendering the tree — enforced by the
layer split + a perf check against `docs/perf-baseline.md`.

**Tests:** Throttle/coalesce unit test; render test that the cursor layer updates
without re-rendering elements; rules test for cross-user write denial.

**Exit:** Two users see each other's labeled cursors at ≥10Hz with no element-tree
re-render; listener count stays within the Appendix A.6 budget (≤5/user).

---

## Phase 7 — Follow-user mode

**Goal:** Tap a presence avatar → your viewport tracks theirs. Item 7. Depends on 6.

**Scope:** Subscribe to the followed user's viewport (broadcast on the cursor side
channel — add `viewport {x,y,scale}` to the cursor doc). Camera follows their
pan/zoom; "Following Scott" indicator; tapping the canvas exits.

**Key changes:** `cursorService` (viewport field), board screen camera controller,
follow-state UI.

**Risks:** Feedback loop if a followed user is also following — guard against
cycles. Motion sickness from fast pans — ease the camera.

**Tests:** Unit test the follow/unfollow state machine + cycle guard.

**Exit:** "Watch me draw this" works — follower's camera mirrors the leader; tap exits.

---

## Phase 8 — Embeddable boards (iframe + signed JWT)

**Goal:** The one deliverable that unblocks every later integration (Zoom, Notion,
Canvas LTI, browser extension). Satisfies item 5. Depends on Phase 1 for token mint.

**Scope:**
- **Read-only embed:** `/embed/b/<boardId>?token=…` web route renders a board with
  no auth required when the signed link is valid.
- **Editable embed:** same URL with an `embedToken` (short-lived signed JWT minted
  by a Cloud Function) asserting identity from the host app (used by M5/M6
  integrations).
- **Embed-mode UI flag:** strips chrome (tabs, profile menu) so the board fills the
  parent frame — same React tree, conditional rendering.
- Token mint + verify in `functions/`; client `embedService` for building links.

**Key changes:** new `app/embed/` route, `functions/src/embed/` (mint/verify),
`src/services/embedService.ts`, `firestore.rules` (token-scoped read path),
embed-mode conditional rendering in the board screen.

**Risks:** *Embed introduces an auth path that bypasses normal rules* (roadmap
named risk). Mitigate exactly as the roadmap dictates: short-lived signed JWTs
minted by a Cloud Function, never long-lived tokens, and **rules-test the embed
path explicitly**.

**Tests:** Function test for mint/verify (expiry, signature, scope); rules test
that an expired/forged token is denied and a valid read-only token cannot write;
render test for chrome-stripped embed mode.

**Exit:** A signed `https://<domain>/embed/b/<id>?token=…` renders a read-only board
in an external iframe with no login; an expired token is rejected.

---

## Phase 9 — AI shape recognition + auto-perfect (client-side)

**Goal:** Finish a rough stroke → offer to replace it with a clean primitive.
Satisfies item 8. **No model, no backend — pure geometry; can start day one.**

**Scope:** On stroke end, run vertex extraction + angle classification +
RANSAC-style circle fit (Appendix B.3: client-side, $0). If it resembles
rect/ellipse/triangle/arrow/line, show a discreet "perfect it?" affordance → replace
the `DrawPath` with the matching `ShapeElement`. Per-user toggle: always / ask /
never. Use existing `simplify-js` (already a dep from M1) + a ~100-line heuristic.

**Key changes:** new `src/lib/shapeRecognition.ts`, hook into stroke-commit in
`app/board/[id].tsx`, per-user preference on the user doc, Toolbar affordance.

**Risks:** False positives annoy users — bias to false-positive-rejectable (target
90%+ on the four primitives; user can always decline). Keep it off the hot draw path
(run on stroke end only).

**Tests:** Unit tests on the geometry classifier with fixture point arrays for each
primitive + negative cases (squiggles should not match).

**Exit:** Drawing a rough rectangle offers a clean rect; the toggle is respected.

---

## Phase 10 — AI handwriting OCR (region → text element)

**Goal:** Select strokes → OCR → editable text element in place. Item 9. Depends on
Phases 1 + 2.

**Scope:** Region-select strokes → send to a Cloud Function that calls Google Cloud
Vision (cheaper) and escalates to `gpt-4o-mini` vision on low confidence (Appendix
B.3). Result is a new `TextElement` at the same board-space location. Memoize against
a hash of the path IDs so re-running is free (Appendix B.3 caching). Low-confidence
(<70%) shows a badge and asks the user to confirm (Appendix B.7).

**Key changes:** `functions/src/ai/ocr.ts`, `src/services/aiService.ts`, selection →
AI command wiring (reuse `useSelection`), result placement, cache doc.

**Risks:** OCR misreads — confidence threshold + confirm step. Cost — Vision-first,
gpt-4o-mini only on low confidence; logged via Phase 2.

**Tests:** Function test with a mocked Vision response (high + low confidence paths);
client test for placement at correct board-space coords + cache hit on re-run.

**Exit:** Selecting handwritten strokes yields an editable text element; re-running
the same selection is a cache hit (no second paid call).

---

## Phase 11 — AI "explain selection"

**Goal:** Select content → "explain this" → structured explanation placed beside it.
Satisfies item 10. Depends on Phases 1 + 2.

**Scope:** Selection (strokes / text / image / mix) → Cloud Function (`gpt-4o-mini`,
output capped ~200 tokens, structured "concept / explanation / example" sections per
Appendix B.3) → new `TextElement` next to the selection. Distinct prompt path from
summaries; target ≤5s.

**Key changes:** `functions/src/ai/explain.ts`, selection → command wiring,
result placement.

**Risks:** Latency/quality — small token cap, structured prompt, fast feedback.

**Tests:** Function test asserting the three-section structure; client placement test.

**Exit:** "Explain this equation/proof/notes" returns a useful structured block in ≤5s.

---

## Phase 12 — AI text → diagram (Mermaid → native elements)

**Goal:** Prompt → Mermaid → editable native B.O.A.R.D shapes. Satisfies item 11.
Depends on Phases 1 + 2. **Most complex AI phase — schedule last; deferrable if M4
time is tight.**

**Scope:** Sidebar prompt → Cloud Function returns Mermaid syntax (`gpt-4o-mini`) →
a one-time renderer `src/lib/mermaid-to-board.ts` parses it and emits native
`ShapeElement` nodes + connector/line edges + `TextElement` labels, which are then
editable. v1 limited to flowcharts, sequence, class, mind-map, simple network
diagrams. Mermaid syntax validation step; on parse failure, retry once with a
stricter prompt (Appendix B.7).

**Key changes:** `functions/src/ai/diagram.ts`, new `src/lib/mermaid-to-board.ts`,
sidebar prompt UI, element emission via existing element creation paths. (The
`connector` element type is a roadmap M4 *stretch* in Appendix A.2 — v1 may render
edges as plain `line` shapes and upgrade to true connectors later.)

**Risks:** Mermaid → board conversion is the hard part; nonsense output (roadmap
risk) — validate syntax, retry once, keep v1 to five diagram families. Don't let
this phase's complexity eat the session-history / lifecycle value (4, 5).

**Tests:** Pure-function tests for `mermaid-to-board` on canonical samples of each
of the five diagram families; function test for the validate-and-retry path.

**Exit:** "draw a flowchart for the HTTPS handshake" renders editable native shapes;
invalid Mermaid triggers exactly one stricter retry before surfacing an error.

---

## Cross-cutting verification (roadmap M4 exit criteria)

- **Real session, end-to-end:** schedule → notify → join → collaborate → end →
  summary appears → both can view it tomorrow (covers Phases 3, 4, 5).
- **AI cost benchmark:** average summary cost < $0.02/session via the Phase 2 log.
- **OpenAI key fully removed from client** (Phase 1).
- **5+ real sessions** completed by users outside the core team; **summary quality
  ≥ 3.5/5** (just ask them).
- **Mobile parity gate (non-negotiable):** every new surface verified on a real
  mid-range Android, with a perf check vs `docs/perf-baseline.md` and a screenshot
  in the PR. Cursor layer especially must not regress draw FPS (Appendix A.4/A.6).
- **Embed path rules-tested** (Phase 8) — expired/forged token denied in CI.

## Dependencies & new costs to approve

- **New runtime dependency:** `react-native-view-shot` (Phase 3) — **needs explicit
  approval** per the working profile (no new deps without sign-off).
- **New infra:** Firebase Blaze (Functions) one month earlier than the roadmap's M5
  budget line; Google Cloud Vision API; optional Ably/Liveblocks free tier if
  Firestore cursors lag. Set hard spend caps before first deploy (roadmap §5).
- **Backend language/runtime:** `functions/` is the first server-side code in the
  repo — adds a deploy target and a second test surface to CI.

## Open questions for sign-off

1. **Cursor transport:** start on Firestore (cheapest, no new vendor) and only move
   to Ably/Liveblocks if perf demands it — agreed? (Recommended: yes.)
2. **`react-native-view-shot`** approval for Phase 3 mobile capture.
3. **Scope-cut order if time runs short:** recommend trimming from the *end* — 12
   (text→diagram) first, then 11 (explain), then 10 (OCR). Protect 1–7 (foundation,
   summary, sessions, cursors). Confirm this priority.
