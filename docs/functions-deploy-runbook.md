# Cloud Functions deploy runbook — AI gateway (Month 4, Phase 1)

**Audience:** whoever owns the Firebase project + billing.
**Why this exists:** Phase 1 moves every AI call server-side so the client never
holds an OpenAI key. The code is in `functions/`; this is the manual ops path to
get it live and cut the client over safely. Steps 1–3 are one-time; step 6 is the
cutover.

> The destructive part — deleting `users/{uid}/private/apiKeys` and removing the
> client key UI — does **not** happen in this phase. Keys stay until the function
> is verified in prod (Exit criteria below). The client runs the legacy
> direct-OpenAI path until `EXPO_PUBLIC_AI_GATEWAY=1` is set.

## 0. Prerequisites

- `firebase-tools` (already a devDependency): `npx firebase login`
- The Firebase project must be on the **Blaze** (pay-as-you-go) plan — Functions
  require it. This is one month earlier than the roadmap's M5 budget line.

## 1. Set the hard spend caps FIRST (before any deploy)

This is the backstop for the roadmap's top risk ("quota leak = cost spike"). Do it
before the function can be invoked.

- **Google Cloud Billing → Budgets & alerts:** create a budget on the project with
  an alert (e.g. $20/mo) — Cloud Billing budgets alert but do not hard-stop, so
  also:
- **OpenAI dashboard → Limits:** set a hard monthly usage cap on the API key.
- The per-workspace token-bucket limiter in `functions/src/ai/rateLimit.ts`
  (30-call burst, ~120/hr sustained) is the in-app throttle; the dashboards are the
  money backstop.

## 2. Provision the secret

The OpenAI key lives only in the Functions runtime — never in the client bundle.

```bash
firebase functions:secrets:set OPENAI_API_KEY
# paste the key when prompted
```

**Phase 10 — Google Cloud Vision key (handwriting OCR).** The `recognizeHandwriting`
callable calls Vision key-first and only escalates to the OpenAI vision model on
low confidence. Enable the **Cloud Vision API** on the GCP project, then set the
key (Vision can use an API-key credential restricted to the Vision API):

```bash
firebase functions:secrets:set GOOGLE_VISION_API_KEY
# paste the Vision API key when prompted
```

Add a Vision daily/monthly cap in the GCP console alongside the OpenAI cap — see
the Phase 10 section at the bottom.

**Phase 8 — embed token signing secret.** The `mintEmbedToken` /
`exchangeEmbedToken` callables sign embed links with an HS256 secret that must
never reach the client. Generate a strong random value and set it before
deploying those functions:

```bash
firebase functions:secrets:set EMBED_JWT_SECRET
# paste e.g. the output of: openssl rand -base64 48
```

Rotating it invalidates every outstanding embed link immediately (they fail
verification) — acceptable, since links are short-lived and the host re-mints.

## 3. Deploy

```bash
npm run functions:build        # tsc → functions/lib
firebase deploy --only functions
```

The callable region is `us-central1` (pinned in `functions/src/index.ts` and
matched by the client's `getFunctions(app, "us-central1")`). If you change it,
change both.

## 4. Verify in the emulator (optional, before prod)

```bash
npm run functions:serve        # builds + starts functions + firestore + auth emulators
```

Point the client at the emulators (connect `getFunctions`/`getFirestore`/`getAuth`
to localhost) and run a summary. Unit tests already cover prompt assembly,
rate-limit math, and the handler's auth/membership/rate-limit guards
(`npm run functions:test`); the emulator step exercises the real provider call.

## 5. Smoke-test in prod (key NOT yet removed)

With the function deployed but `EXPO_PUBLIC_AI_GATEWAY` still unset, flip the flag
in a single preview/build only and generate one summary end-to-end:

- A summary returns with **no client key present**.
- The rate limiter rejects a rapid burst with a friendly "too many requests".
- A non-member of the board gets `permission-denied`.

## 6. Cut over

Once step 5 passes in prod:

1. Set `EXPO_PUBLIC_AI_GATEWAY=1` in the EAS/build env for all builds.
2. Ship. The client now routes through the function; the legacy path is dead code
   behind the flag.

## 7. Cleanup (a LATER change, after the cutover soaks)

Only after the gateway has run clean in prod for the agreed soak window:

- Remove the legacy path + client key APIs (`loadOpenAIKey`, `setOpenAIKey`,
  `getOpenAIKey`, `clearOpenAIKey`, the AsyncStorage `board_openai_key`), the
  `loadOpenAIKey()` call in `app/_layout.tsx`, and the AI-key UI in
  `app/(tabs)/profile.tsx`. Drop the `AI_GATEWAY_ENABLED` flag.
- Ship a one-time notice and delete `users/{uid}/private/apiKeys` (roadmap item 1).
  Do **not** delete before the gateway is verified, or summaries break.

## Phase exit criteria (from the plan)

- A summary generates end-to-end through the function with **no client key**.
- `aiLog`/`aiUsage` reject client writes (CI rules test:
  `AI telemetry (aiUsage / aiLog / aiRate)`).
- `apiKeys` cleanup is staged behind a notice (step 7), not yet executed.

## What landed in Phase 1 vs. deferred

- **Landed:** `functions/` package + AI provider seam + OpenAI adapter, the
  `generateSummary` callable, per-workspace rate limiter, client flag-gated
  cutover, rules lock on `aiUsage`/`aiLog`/`aiRate`, CI build/test job.
- **Phase 2:** the function writes `aiUsage` counters + per-call `aiLog`
  cost records, the read-only usage settings page, and `quotaService` wiring.
  See below.

---

# Phase 2 — AI quota + cost telemetry

**What landed:** every workspace-scoped AI call now logs cost and bumps a period
counter; an owner/admin-only usage page reads them; the function carries a soft
quota gate ready for M5.

## How it works

- `functions/src/ai/usage.ts` — `estimateCostUsd` (per-model input/output rate
  table), `currentPeriod` (UTC year-month), `applyUsage` (pure accumulation, like
  `applyBucket`), and `recordAiUsage` (one transaction writing
  `workspaces/{id}/aiUsage/{period}` + appending `workspaces/{id}/aiLog/{auto}`).
- `generateSummary` calls `checkAiQuota` **before** the provider (soft — allows
  everyone today, reads the live counter so M5 flips a limit here, not the call
  site) and `recordAiUsage` **after** a successful call. Telemetry failure is
  logged and swallowed — it never breaks a summary the user already paid for.
- Solo/legacy boards with no `workspaceId` are not metered (no workspace to bill).
- Client: `src/services/aiUsageService.ts` reads the docs; `app/ai-usage.tsx` is
  the read-only page (linked from Profile → AI Settings), gated to owner/admin in
  both the UI and `firestore.rules`. `quotaService` gained the generic `aiCall`
  resource.

## Cost model (edit when prices move)

Rates are USD per 1M tokens in `MODEL_RATES` (`functions/src/ai/usage.ts`):
`gpt-3.5-turbo` $0.50 in / $1.50 out, `gpt-4o-mini` $0.15 in / $0.60 out. An
unknown model falls back to the pricier text rate so estimates never under-report.

## Hard spend caps (ops — same as Phase 1 step 1)

The dashboards remain the money backstop; the in-app meter is for visibility, not
enforcement. Confirm the Google Cloud Billing budget alert and the OpenAI monthly
usage cap from Phase 1 step 1 are in place. M5 turns `checkAiQuota` into the
in-app hard gate.

## Exit criteria

- A summary call writes one `aiLog` row and increments `aiUsage/{period}`.
- The usage page reflects calls / tokens / $ for an owner/admin; a non-admin sees
  the gate, not a permission error (CI rules test: `AI telemetry` non-admin read).
- Unit tests cover the cost math + counter accumulation
  (`functions/src/__tests__/usage.test.ts`).

---

# Phase 10 — AI handwriting OCR (region → text element)

**What landed:** select strokes → "Recognize text" → a cropped image of the region
goes to the `recognizeHandwriting` callable, which runs Google Vision first and
escalates to the OpenAI vision model only when Vision is low-confidence. The result
is placed as an editable `TextElement` and memoized so a re-run is free.

## How it works

- `functions/src/ai/vision.ts` — `GoogleVisionClient` (REST `images:annotate`,
  `DOCUMENT_TEXT_DETECTION`) behind a `VisionClient` seam, parallel to `AIProvider`.
- `functions/src/ai/ocr.ts` — `recognizeImage` runs Vision, returns it when
  confidence ≥ `OCR_CONFIDENCE_THRESHOLD` (0.70), else escalates to the `ocr-vision`
  model tier (`gpt-4o-mini`). An escalation pays for **both** engines; both are logged.
- `functions/src/ai/ocrCache.ts` — result keyed by a hash of the sorted selected
  path ids at `boards/{id}/ocrCache/{hash}`. A changed selection misses naturally
  (stroke ids change on edit); a hit short-circuits before the limiter + any paid call.
- `functions/src/callable/recognizeHandwriting.ts` — same guard skeleton as
  `generateSummary` (auth → board access → rate limit → quota → engine → telemetry).
- Client: `aiService.recognizeHandwriting` (callable client) + `captureSelectionImage`
  (`src/utils/canvasCapture.ts`, crops the board capture to the selection via the
  already-present `expo-image-manipulator`). Board screen shows a "Recognize text"
  button on a selection and a confirm prompt on a low-confidence result.

## Cost model

Vision `DOCUMENT_TEXT_DETECTION` is billed **per image** (~$0.0015), not per token,
so it is logged via the new `flatCostUsd` override on `recordAiUsage` under model
`google-vision`. The escalation LLM (`gpt-4o-mini`) bills through the normal token
rate table. Add a **Cloud Vision API** budget/cap in GCP next to the OpenAI cap.

## Flags

OCR rides the same gateway as summaries, gated by `EXPO_PUBLIC_OCR=1` **and**
`EXPO_PUBLIC_AI_GATEWAY=1` (`isOcrConfigured`). Default OFF until the function is
deployed and `GOOGLE_VISION_API_KEY` is set.

## Exit criteria

- Selecting handwritten strokes yields an editable text element; re-running the
  same selection is a cache hit (no second paid call) — see the cache-hit unit test.
- `ocrCache` rejects client writes and is member-read only (CI rules test:
  `OCR cache (ocrCache)`).
- Unit tests cover Vision parsing, the escalation decision, the cache key, and the
  callable guard paths (`functions/src/__tests__/{ocr,recognizeHandwriting}.test.ts`).

---

# Phase 12 — AI text → diagram (Mermaid → native elements)

**What landed:** a prompt sheet on the board → the `textToDiagram` callable returns
validated Mermaid (`gpt-4o-mini`) → the client parser (`src/lib/mermaid-to-board.ts`)
turns it into editable native `ShapeElement`/`TextElement`s dropped at the viewport
center. No new key or secret — it rides the existing OpenAI gateway.

## How it works

- `functions/src/ai/diagram.ts` — pure prompt assembly, `extractMermaid` (strips
  code fences), `detectFamily`, and `validateMermaid` (the gate that drives the retry).
- `functions/src/callable/textToDiagram.ts` — same guard skeleton as the other AI
  callables (auth → board access → rate limit → quota → provider → telemetry), plus
  a **validate-and-retry loop**: on an unparseable first reply it retries exactly
  once with a stricter prompt (Appendix B.7). One rate-limit token covers the whole
  attempt; each paid completion is metered.
- `functions/src/ai/openai.ts` — new `diagram-text` model tier (`gpt-4o-mini`).
- Client: `aiService.textToDiagram` (callable client) + `mermaid-to-board` (the
  pure renderer). v1 families: flowchart/graph (also used for simple network
  diagrams), sequenceDiagram, classDiagram, mindmap. Edges render as plain
  `line`/`arrow` shapes — the first-class `connector` element type is a deferred
  roadmap stretch (Appendix A.2) and can be upgraded later without changing the
  function contract.

## Flags

Text→diagram rides the same gateway as summaries, gated by `EXPO_PUBLIC_DIAGRAM=1`
**and** `EXPO_PUBLIC_AI_GATEWAY=1` (`isDiagramConfigured`). Default OFF until the
function is deployed. No new secret — it uses the existing `OPENAI_API_KEY`.

## Exit criteria

- "draw a flowchart for the HTTPS handshake" renders editable native shapes; invalid
  Mermaid triggers exactly one stricter retry before surfacing an error.
- Unit tests cover the prompt/extract/validate seam, the validate-and-retry handler
  path, and the Mermaid→board parser on all five families
  (`functions/src/__tests__/{diagram,textToDiagram}.test.ts`,
  `src/lib/__tests__/mermaid-to-board.test.ts`).
