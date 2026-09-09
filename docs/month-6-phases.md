# Month 6 — Growth + Decide: Phased Implementation Plan

**Author:** Arlo Kharod
**Drafted:** 2026-09-01
**Branch:** `feature/month-6-growth` (off `main`)
**Source scope:** `ROADMAP.md` § Month 6 (restructured into M6a / M6b, 2026-09-01), Appendix E (education vertical), Appendix F (M7+ backlog).
**Status:** Planning draft — sequencing + per-phase contracts, not yet implemented.

> **▶ Executable form:** the M5 and M6 plans are combined into a single
> subagent-executable task list at
> [`docs/superpowers/plans/2026-09-09-months-5-6-monetization-and-growth.md`](superpowers/plans/2026-09-09-months-5-6-monetization-and-growth.md)
> (37 tasks, Tasks 21–37 are this month). **That document is what you execute.**
> This one is the investigation and rationale behind it — read it when you need to
> know *why* a task is shaped the way it is.

> **How to read this:** Month 6 is the month the project earns a yes or a no. That
> makes it structurally different from months 1–5: the deliverable is not a feature
> set, it is **an attributable number**. The plan is therefore split at the launch —
> **M6a** ships the smallest set of things that make the product demoable and
> measurable, then launches; **M6b** spends the post-launch weeks on scope chosen
> from what the launch actually showed.

> **Hard prerequisite — Month 5 closed**, meaning a real payment can be taken and
> the free-tier gates are enforced server-side. A funnel with no working checkout at
> the end of it measures nothing.

---

## Executive summary — the month is over-scoped by ~2×, and that is the finding

Month 6 as originally written contains **eight substantial engineering features**
(polls, reactions/dot-voting, flashcards + spaced repetition, board Q&A/RAG,
document scanner, export polish, a 15–20 item template library, an onboarding
tutorial), **plus a second platform integration**, **plus analytics
instrumentation**, **plus three blog posts**, **plus instructor outreach**, **plus a
coordinated multi-channel launch** — in the same month that is supposed to produce
the go/no-go decision.

Any one of the AI items is a week. LTI 1.3 alone is 2–3 weeks *plus* partner
paperwork, by the roadmap's own estimate. **The failure mode is specific: eight
features at 70% with a launch on top of them, producing numbers too ambiguous to
attribute.** An unattributable number cannot support a decision, and the decision is
the entire point of the month.

Four further corrections, all folded into the phases below:

| # | Roadmap said | Reality |
|---|---|---|
| 1 | Analytics is item 4. | **It must be first.** Instrumentation shipped after the features it measures gives the launch no baseline. |
| 2 | Item 2 offers LTI 1.3 as option A. | **LTI does not fit.** OIDC + JWKS + Deep Linking 2.0 + AGS passback + Names&Roles, plus partner paperwork on a timeline you don't control. → M7+. |
| 3 | Items 3 and 7 are separate; item 14 duplicates M5 item 4. | Items 3 and 7 are **one item**. Onboarding is **specified twice** — build it once, in M5. |
| 4 | Item 12: *"`expo-document-scanner` or VisionKit on iOS, ML Kit on Android."* | **`expo-document-scanner` does not exist.** ML Kit's scanner is Android-only; iOS needs VisionKit separately; wrappers need a config plugin and an EAS build. |

And one piece of genuinely good news that **removes** work: **Firestore KNN vector
search is GA**, so board Q&A needs no external vector store.

---

## Investigation: current state by layer

Verified against `main` at `9825bbb`.

### What M6 can build on — more than expected

- **Export is half-built.** `src/utils/recapExport.ts` already does HTML→PDF with a
  platform split (`expo-print` + `expo-sharing` on native; browser print dialog on
  web, because `printToFileAsync` is unsupported there), and its HTML builder is
  deliberately a pure function so it unit-tests without the platform modules.
- **Capture is built.** `src/utils/canvasCapture.ts` captures and crops board regions
  to PNG data URLs via `expo-image-manipulator`, using normalized-fraction cropping
  so web and native stay consistent.
- **SVG export is nearly free.** The board *is* a `react-native-svg` tree, so
  "SVG (vector, lossless)" is a pure serializer over the element union — no new
  rendering path, trivially unit-testable. **The cheapest item in the month.**
- **The AI gateway generalizes.** `functions/src/ai/provider.ts` is an adapter and
  `usage.ts` meters per-feature with a `byFeature` breakdown whose client reader
  tolerates unknown keys. New AI features add a feature name, not infrastructure.
- **`ocrCache.ts` is the template for every memoized AI call** — hash the inputs,
  skip the call. Flashcards and Q&A embeddings both want exactly this.
- **Element anchoring is a proven pattern.** `Comment` with `anchorElementId` +
  `CommentAnchorKind`, rendered by `CommentPinLayer`, is a working precedent for
  anchoring anything to an element — which is what reactions need.

### What does not exist

- No analytics of any kind — no PostHog, no event taxonomy.
- No `src/templates/` directory and no template concept in the data model.
- No poll, quiz, reaction, flashcard or embedding types.
- No instructor/roster concept. `Workspace.members` is `Record<uid, WorkspaceRole>`
  with `owner|admin|member|viewer` — no instructor/student distinction.
- No camera/scanner integration.

### Element-schema pressure

M6 adds `PollElement`, a reaction store (anchored, *not* an element), a flashcard
deck (board-scoped subcollection, not an element), plus M5's deferred `MathElement`
and `CodeElement`. That takes a five-kind union to nine. **Add `schemaVersion` to
every new element type** — the embed token already models this
(`EMBED_TOKEN_VERSION` with an explicit `bad-version` rejection) and it is the right
precedent to copy before Appendix A's "element-schema churn" risk becomes real.

---

## Phase ordering at a glance

| Phase | Title | Roadmap items | Half | Depends on | Complexity |
|---|---|---|---|---|---|
| 1 | Analytics + event taxonomy | 4 | **M6a** | — | Low–Med |
| 2 | Template library | 3 + 7 | M6a | — | Medium |
| 3 | Print + export polish | 13 | M6a | — | Medium |
| 4 | Reactions + polls | 8 + 9 | M6a | — | Medium |
| 5 | Education pilot (reshaped) | 1 | M6a | — | Medium |
| 6 | Sample workspace seeding | 14 (reduced) | M6a | 2 | Low |
| 7 | Content + launch | 5 + 6 | M6a | 1–6 | — |
| 8 | AI: flashcards + SM-2 | 10 | M6b | — | **High** |
| 9 | AI: board Q&A (RAG) | 11 | M6b | — | **High** |
| 10 | Browser extension | 2 | M6b | M5 Ph.10 | Medium |
| 11 | Mobile camera capture (descoped) | 12 | M6b | — | Low–Med |
| 12 | Carried from M5: math + code elements | M5 10–11 | M6b | — | **High** |
| 13 | Carried from M5: sticky + colour polish | M5 12–13 | M6b | — | Low |

**Critical path:** Phase 1 gates everything, because it is the only phase whose
absence silently invalidates the month. Phases 2–6 are independent of each other and
can be worked in any order or in parallel. Phase 7 is the hinge. **Nothing in M6b
starts before the launch**, by design — its scope is an output of Phase 7, not an
input.

---

# M6a — instrument, sharpen, launch

## Phase 1 — Analytics + event taxonomy *(roadmap item 4 — moved to first)*

**Goal:** Make the funnel observable **before** anything is added to it.

**Scope:**
- PostHog free tier (`posthog-js` on web, `posthog-react-native` on native).
- Define the funnel up front so events are comparable across the launch:
  `signup`, `workspace_created`, `board_created`, `session_scheduled`,
  `session_completed`, `ai_summary_generated`, `upgrade_viewed`,
  `upgrade_completed`, plus an install event per integration surface.
- **Hashed workspace id + role only. Never names, never emails.** See Phase 5 for
  why this is a compliance property and not just hygiene.
- Route every call through a thin `src/services/analyticsService.ts` seam — same
  discipline as `errorReporting.ts`, so the vendor is one file.

**Key changes:** `src/services/analyticsService.ts` (new), `app/_layout.tsx`, call
sites at each funnel event.

**Risks & mitigations:**
- *Shipping it after the features it measures* — the entire reason it is Phase 1.
  A launch with no pre-launch baseline cannot attribute anything.
- *Leaking identifiers into a third party* — the seam is the choke point; add a test
  asserting no event payload contains an email-shaped string.

**Tests:** Unit tests for the seam (event shape, identifier hashing, opt-out); the
no-PII assertion above.

**Exit:** The M5 checkout funnel is visible end-to-end in PostHog **before any other
M6 phase merges.**

---

## Phase 2 — Template library *(roadmap items 3 + 7 — one item)*

**Goal:** 15–20 templates that double as the content-marketing surface.

**Scope:** Each template is a **JSON board export under `src/templates/`** — data,
not code, so the marginal cost after the first is small. Gallery in the new-board
flow. Each gets an indexable landing page (`/templates/cornell-notes`).

- **Study:** Cornell notes, flashcard deck, mind-map, spaced-repetition planner,
  exam-review grid (topics × confidence), study-streak tracker.
- **CS / engineering:** sprint planner, code-review checklist, system-design canvas,
  design-doc structure, sequence-diagram canvas, ERD canvas.
- **Classroom:** lab-report, lecture-notes layout, group-brainstorm with zones,
  peer-review canvas, weekly project Kanban.
- **Meeting:** retro (start/stop/continue), 1:1 agenda, daily-standup, decision log.

**Risks & mitigations:**
- *Template rot as the element schema changes* — stamp each with `schemaVersion` and
  add a test that every file in `src/templates/` parses into a valid board. That test
  is what stops a template silently breaking three months later.

**Tests:** Parse-and-validate every template file; gallery render test.

**Exit:** Gallery ships; every template opens into a correct board.

---

## Phase 3 — Print + export polish *(roadmap item 13 — pulled forward)*

**Goal:** PNG, PDF and SVG export. **Do SVG first — it is nearly free.**

**Scope:** SVG as a pure serializer over the element union. PNG with
viewport/fit-content options via `canvasCapture.ts`. PDF with multi-page tiling for
large boards, extending `recapExport.ts`. "Print this board" → PDF on web, native
print on mobile.

**Risks & mitigations:**
- *The M4 native-capture risk resurfaces here* — PNG export on native rides the same
  `toDataURL` path whose image-element rendering is the open M4 question. If M4
  closeout found `<Image href>` doesn't render, PNG export inherits that bug. **Check
  the M4 finding before building this**, not after.

**Tests:** SVG serializer over every element kind; PDF tiling math; a >1-page board
exported and opened.

**Exit:** All three formats round-trip; tiling verified beyond one page.

---

## Phase 4 — Reactions + polls *(roadmap items 8 + 9)*

**Goal:** The engagement primitive, and the retro/dot-voting mechanic with it.

**Scope:**
- Reactions (👍 ❤️ ❓ ⭐ 💡) anchored to elements, **reusing the
  `Comment.anchorElementId` precedent** rather than inventing an anchoring scheme.
- Polls as a new element: question, 2–6 options, optional anonymous mode, live
  result bars. Quiz mode = polls in sequence with a "show answer" reveal.
- Dot-voting is a host-toggled variant of the same vote store, with sort/cluster by
  count.
- **Votes are persisted, not ephemeral.** They must survive a refresh, so they do
  **not** ride the M4 cursor side channel — that channel is explicitly for data that
  is safe to drop.

**Risks & mitigations:**
- *Vote integrity* — one vote per user per poll must be enforced in rules, not the
  UI. Store votes as `polls/{pollId}/votes/{uid}` so the document id **is** the
  constraint.
- *Anonymous mode still needs a uid to dedupe* — store the uid as the doc id but keep
  it out of any read path the client can see. Say this explicitly in the UI: anonymous
  to other users, not to the system.

**Tests:** Rules tests for one-vote-per-user and member-only voting; two-client live
update check.

**Exit:** Two clients see live vote updates; counts survive reload; a second vote
from the same user is denied at the database.

---

## Phase 5 — Education pilot, reshaped *(roadmap item 1)*

**Goal:** Get into real classrooms without taking on a compliance problem a solo
developer cannot operate.

**⚠️ The compliance trigger the original scope under-weighted.** The moment you
onboard a *class* rather than a study group, the legal posture changes:

- **Under-13 users invoke COPPA's verifiable-parental-consent requirement** — which
  a CSV roster import cannot provide.
- **University coursework touches FERPA** when the institution is the customer;
  institutions will ask for a data-processing agreement.
- **A roster CSV is bulk PII** for people who never signed up, landing in Firestore
  and potentially in analytics.

**Scope, reshaped:**
- **University-level only.** K-12 explicitly out of scope until there is a reason to
  take it on.
- **Invite-based self-enrollment, not CSV import.** The instructor generates a join
  link; students enroll with their own accounts. Same end state, **less engineering**,
  no bulk PII, consent implicit in signup.
- Per-assignment boards + an instructor grid view of student work.
- Outreach to 5 instructors; free Edu tier for the semester in exchange for feedback.
- Build the CSV importer later, with a DPA, if a real instructor insists.

**Risks & mitigations:**
- *Analytics carrying student identifiers* — Phase 1's hashed-id rule is what keeps
  this clean; verify it holds for the instructor grid's events too.

**Tests:** Rules tests that a student cannot read another student's assignment board;
instructor-grid access scoped to the class workspace.

**Exit:** One real instructor runs one real class on it.

---

## Phase 6 — Sample workspace seeding *(roadmap item 14, reduced)*

**Goal:** A new signup lands somewhere populated.

**⚠️ Onboarding is specified twice.** M5 item 4 and M6 item 14 describe the same
90-second tutorial. **The tutorial ships in M5 Phase 9.** What remains here is
seeding: a sample workspace with an example study board, a finished session with an
AI summary, and a mock roster. Building it twice is pure waste.

**Tests:** New-signup path lands in the seeded workspace, not an empty state.

**Exit:** No new user ever sees a zero-state as their first screen.

---

## Phase 7 — Content, then launch *(roadmap items 5 + 6)*

Three blog posts; the honest dev-log post; one launch date with everything aimed at
it — ProductHunt, Show HN, r/learnprogramming, r/college, the university CS Discord,
LinkedIn, and the Google Workspace Marketplace listing from M5. Nothing
engineering-blocking. **This is the hinge: M6b's scope is decided from what happens
here.**

---

# M6b — post-launch, scoped by what the launch showed

## Phase 8 — AI: flashcard generation + SM-2 *(roadmap item 10)*

**Goal:** The highest-ROI student feature — exam prep.

**Scope:** Select notes → generate front/back pairs (memoized against a content hash,
`ocrCache.ts` pattern) → review in a spaced-repetition UI.

**The AI half is the easy half.** SM-2 is ~40 lines of well-specified arithmetic —
put it in `src/lib/sm2.ts` with a **full state-transition test table**. The real cost
is a *second app surface*: a review screen, per-user scheduling
(`users/{uid}/decks/{deckId}/cards/{cardId}` — **per-user, because two students
studying the same board have different schedules**), and a due-cards query. Budget a
week, mostly UI and data model.

**Anki `.apkg` export: cut.** It is SQLite-in-a-zip and a genuine time sink. **Ship
CSV export**, which Anki imports natively.

**Tests:** Full SM-2 transition matrix; due-cards query; generation memoization.

**Exit:** Generate a deck from a real notes board and review it across two days.

---

## Phase 9 — AI: board Q&A *(roadmap item 11)*

**Goal:** Chat scoped to a board, over its content + session history + comments.

**✅ The infrastructure is now free.** **Firestore KNN vector search is GA** —
`findNearest` supports COSINE / EUCLIDEAN / DOT_PRODUCT, combines with `where()`
filters (filters applied first, then similarity within the filtered set), returns the
computed distance, supports a distance threshold, and caps at 2048 dimensions.
`text-embedding-3-small` is 1536, so it fits. **No external vector store.**

**Scope:**
```
boards/{id}/embeddings/{elementId}
  { vector: FieldValue.vector([...]), text, elementType, contentHash, updatedAt }
```
- Embed on write, debounced, in a Function; skip when `contentHash` is unchanged.
- Query: `findNearest` filtered by board, top-k into `gpt-4o-mini`.
- Meter with `feature: "boardQa"` so it appears in the existing usage dashboard
  automatically.

**Risks & mitigations:**
- **⚠️ This is the first *unbounded* AI feature.** Summaries fire once per session;
  chat fires as often as someone types, and embeddings re-run on every meaningful
  edit to a chatty board. It needs **its own rate-limit bucket** (the M4 `aiRate`
  token-bucket mechanism) and **its own line in the plan-limits table**, or one
  enthusiastic free-tier user outspends a paying one.
- *Embedding cost on import-heavy boards* — debounce and hash-skip are what make this
  affordable; verify the skip rate in the usage log before opening it up.

**Tests:** Rules test that `embeddings` rejects client writes (Functions-only, like
`aiUsage`); retrieval relevance on a fixture board; rate-limit unit tests.

**Exit:** A real question against a real board returns a correct, cited answer, and
the cost per question is measured.

---

## Phase 10 — Browser extension *(roadmap item 2 — the pick)*

**Goal:** One additional surface, chosen because it reuses what already exists.

**⚠️ LTI 1.3 is not the pick.** It needs OIDC third-party-initiated login, JWKS
rotation, Deep Linking 2.0, Assignment & Grade Services for passback, and Names &
Roles for the roster — *plus* a partner application and an admin willing to install
it in a production LMS. The roadmap's 2–3 weeks is optimistic for a first
implementation, and the paperwork is not on a critical path you control. **M7+**,
started deliberately and early. Slack/Discord stays the runner-up.

**Scope:** Manifest V3, Chrome + Edge. Side panel wrapping the M4 embed;
drag-an-image-from-any-page onto the board; "send this page to a board" action.
Genuinely 1–2 weeks. Web Store review runs days.

**⚠️ Coupled to M5 Phase 10:** the side panel needs the **editable** embed. If M5
shipped only the read-only arm, this is view-only and much less compelling.

**Exit:** Install unpacked, open a board beside an arbitrary page, drag an image in,
and see it on the board for another user.

---

## Phase 11 — Mobile camera capture *(roadmap item 12 — descoped)*

**Goal:** "Snap a textbook page, drop it on the board, AI explains it."

**⚠️ `expo-document-scanner` does not exist.** ML Kit's document scanner is
**Android-only** (Google ships no iOS module, and it needs API 21+ / ~1.7 GB RAM);
iOS needs VisionKit separately; the third-party wrappers covering both require a
config plugin and an EAS build, and none work in Expo Go.

**Scope, descoped:** capture + crop + OCR. `expo-image-picker` is **already a
dependency** and already opens the camera; run the result through the existing M4
OCR pipeline. **Zero new native dependencies**, and it delivers the actual use case.
True auto-edge-detection is M7 polish, not a launch blocker.

**Exit:** Photograph a page on a real device, place it, and OCR it to a text element.

---

## Phase 12 — Carried from M5: math + code elements *(M5 items 10–11)*

**Math.** KaTeX emits DOM HTML and cannot render into this SVG canvas. Render LaTeX
to **SVG path data** instead — `mathjax-full` SVG output, in a `renderMath` callable,
cached by hash like `ocrCache.ts`:

```ts
export interface MathElement {
  type: "math";
  latex: string;      // editable source of truth
  svgPath: string;    // rendered output, cached
  width: number; height: number;
  x: number; y: number; scale: number;
}
```

Re-render only when `latex` changes. The element then renders as ordinary `<Path>`
nodes, so it transforms, exports to PNG/SVG/PDF, prints and gets selected **for
free** — none of which a WebView-based equation would do.

**Code.** Use Shiki's **tokenizer** (`codeToTokens()`), which returns
`{ content, color }` runs rather than HTML, and render them as `<TSpan>` runs inside
an SVG `<Text>`, one line per `dy`. ~150 lines, single code path. Bundle only the
grammars you need (`ts`, `js`, `py`, `java`, `c`, `cpp`, `sql`, `json`, `bash`).

**Do not reach for a WebView for either.** A WebView per equation is unusable at
thirty equations a board, and it opts both element types out of selection, transform,
export and print.

**Tests:** Deterministic-render tests (same LaTeX → same path data); tokenizer
snapshot per supported language.

**Exit:** Both element kinds participate in selection, transform, comment, export.

---

## Phase 13 — Carried from M5: sticky-note + remaining colour polish *(M5 items 12–13)*

8 sticky colours, 3 sizes, markdown rendering, sticky-on-shape attachment; plus
whatever of M5's colour/stroke polish did not make that month. Lowest priority in the
month; cut first.

---

## Cross-cutting verification (roadmap M6 exit criteria)

1. **DAU / WAU / MAU from analytics** — which requires Phase 1 to have shipped
   *before* Phase 7, not after.
2. Free → Pro conversion rate (any conversion is a win at this stage).
3. 100+ signups, 20+ weekly active, 3+ paying.
4. `tsc` clean; app, `functions` and `test:rules` suites green.
5. Mobile-parity pass on a real mid-range Android for every new surface.

## Dependencies & new costs to approve

| Package / cost | For | Notes |
|---|---|---|
| `posthog-js` + `posthog-react-native` | Phase 1 | Free tier, 1M events/mo |
| Chrome Web Store developer account | Phase 10 | $5 one-time |
| `mathjax-full` (functions only) | Phase 12 | Server-side SVG generation |
| `shiki` | Phase 12 | **Tokenizer only**; pin the grammar subset |

**Explicitly not adding:** an external vector database (Firestore `findNearest`
covers it), a document-scanner native module (descoped), an Anki `.apkg` writer, any
LTI library.

## Open questions for sign-off

1. **Is the M6a/M6b split accepted?** Everything else in this plan follows from it.
   If the whole list must ship in one month, something will be at 70% and the
   decision will be unattributable — say which items you would rather cut instead.
2. **What decides M6b's scope?** Recommendation: the top two requests from launch
   traffic, not this document's ordering.
3. **Does the education pilot survive the reshape?** Invite-based enrollment is a
   product decision as much as a compliance one — confirm before Phase 5.
4. **What is the actual decision rule?** "100 signups, 20 WAU, 3 paying" is written
   down; agree *now* what happens at 60/12/1, while it is still hypothetical.

## Sources

- [Search with vector embeddings — Firestore](https://docs.cloud.google.com/firestore/native/docs/vector-search)
- [Get started with Firestore vector similarity search](https://cloud.google.com/blog/products/databases/get-started-with-firestore-vector-similarity-search)
- [Document scanner — ML Kit](https://developers.google.com/ml-kit/vision/doc-scanner)
- [@infinitered/react-native-mlkit-document-scanner](https://www.npmjs.com/package/@infinitered/react-native-mlkit-document-scanner)
- [App review process — Google Workspace Marketplace](https://developers.google.com/workspace/marketplace/about-app-review)
