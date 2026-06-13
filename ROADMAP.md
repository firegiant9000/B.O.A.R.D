# B.O.A.R.D — 6-Month Product Roadmap

**Author:** Arlo Kharod
**Drafted:** 2026-05-12
**Team size assumption:** 1 primary developer (you), occasional second contributor
**Status:** Working draft — revisit at end of each phase

---

## 1. Executive Summary

B.O.A.R.D is currently a working real-time collaborative whiteboard built in React Native / Expo + Firestore, originally scoped for a CMPS 357 final project. The codebase is clean, the architecture is reasonable, and the feature surface (drawing, text, presence, sharing, scheduled sessions, friend system, AI session summaries) is well above what most student projects ship.

**The core question:** is this a marketable product as-is, or does it need a pivot?

**Verdict:** It is **not** marketable today. As a horizontal "Miro/FigJam/Excalidraw clone" it is well behind the incumbents and has no moat. But the project does have two genuinely differentiating ingredients that nobody is bundling well right now:

1. **Cross-platform mobile-first real-time collaboration** (iOS + Android + web from one codebase — Miro/FigJam are web-first; Notability is iPad-only).
2. **Session-scoped AI summarization** (start session → collaborate → end → auto-generated notes). Excalidraw and Miro don't do this; Notability doesn't have real-time collab.

The recommended path is a **focused pivot toward classroom / study-group collaboration**, exploiting the fact that the app was already built around the "session" primitive. This is also the market you have direct empathy for (senior CS student, group projects). The roadmap below is built around that thesis but explicitly preserves the option to repivot at the end of Month 3 if the validation work fails.

**Two cross-cutting constraints apply through every phase:**

1. **Mobile stays a first-class target — not a downgraded sibling of the web.** The app was born cross-platform; that is a real moat against Miro/FigJam (web-first) and Excalidraw (single-user). The moment B.O.A.R.D becomes "web with a mediocre mobile mode," that advantage is gone. Every monthly deliverable below must verify on a real mid-range Android device, not just an emulator and not just a MacBook browser.
2. **The product must meet users where they already work.** A standalone whiteboard people have to remember to open will lose to a board that shows up next to the Google Doc / Zoom call / Canvas course / Notion page they are already in. Integration surfaces — share sheets, embeds, meeting-app SDKs, LMS plug-ins, browser extensions — are not nice-to-haves; they are how the wedge actually reaches users. The plan threads integration work through Months 2, 4, 5, and 6.

---

## 2. Current State Evaluation

### 2.1 Strengths

- **Clean architecture.** Services layer (`pathService`, `boardService`, `sessionService`, `presenceService`, `aiService`, `friendService`, `notificationService`) is well-separated. Adding features will not require a rewrite.
- **TypeScript strict mode is on.** Refactors will be safer than typical RN apps.
- **Cross-platform actually works.** Expo Router, react-native-web, and a SVG-based canvas mean one codebase ships to iOS, Android, and web.
- **Real-time path sync works end-to-end** via Firestore `onSnapshot`. Presence with "Active Xm ago" indicators is a nice touch.
- **CI runs `tsc --noEmit` on PRs.** Type regressions caught pre-merge.
- **The "session" primitive is the right abstraction** for what makes this product different — scheduled, time-bounded collaboration with an artifact (board state) at the end.

### 2.2 Weaknesses

- **Zero tests.** No Jest config, no `__tests__`. Every change is a manual regression.
- **No offline support.** No `enableIndexedDbPersistence`, no service worker. Network drop = frozen app. Hard blocker for classroom Wi-Fi reality.
- **Drawing performance has no throttling.** PanResponder fires per frame, every point goes to Firestore, no batching, no coalescence. Will not scale to 10+ concurrent drawers.
- **Eraser doesn't actually erase.** It paints white over strokes. Underlying paths still exist in Firestore — storage bloat + broken undo + broken export.
- **OpenAI API key lives client-side**, stored in `users/{uid}/private/apiKeys` and AsyncStorage. Fine for a demo, untenable for a paid product. Must move to a Cloud Function.
- **Push notifications only work inside Expo Go.** No EAS Build configured. Standalone iOS/Android can't receive session notifications.
- **No multi-tenancy.** No org/workspace concept. Every board is a sibling under `/boards`. Cannot bill, cannot do classroom rosters, cannot do org-level admin.
- **No plan/quota fields.** Free vs paid gating has no hooks anywhere in the data model.
- **No error boundary.** Unhandled promise rejections crash the app.
- **Silent error swallowing** in several services (`.catch(() => {})` in presence, empty catch blocks in `pathService`). Issues will be invisible in production.
- **Vision-summary work is WIP** (per commit `984a3aa`). `captureSvgAsPng` is web-only; mobile sessions can't feed images into the AI summary.
- **Invite codes use `Math.random()`** — not a security issue at small scale, but should move to `crypto.getRandomValues` before any public launch.

### 2.3 Competitive position

| Competitor | Strength | Why B.O.A.R.D can't beat them head-on |
|---|---|---|
| **Miro / FigJam** | Mature feature surface, enterprise sales | Years of engineering, sales team, integrations |
| **Excalidraw** | Free, open-source, simple, beloved | You can't out-free free |
| **Notability** | Best-in-class iPad drawing | Native pencil support, single-user focus |
| **Google Jamboard** | Was free, integrated with Workspace | Discontinued — there is a real gap here |
| **Notion / Lark whiteboards** | Bundled into a larger suite | You're not a suite |

**The opening:** there is no good real-time collaborative whiteboard built around **scheduled, time-bounded sessions with automatic artifacts** for **students and small teams** that **works cross-platform** and **costs less than enterprise tools**. That is the wedge.

---

## 3. Strategic Options

### Option A — Generic SaaS whiteboard
Position against Miro/FigJam at a lower price point. **Don't do this.** No moat, no story, no advantage. You will lose on features and lose on sales motion.

### Option B — Classroom / study-group collaboration (Recommended)
Position as: "the whiteboard built for study sessions and group projects." Lean into the `session` primitive, ship AI summaries that are actually good, add classroom-specific features (rosters, attendance, shareable session recordings, assignment-submission snapshots).
- **Buyer:** students directly (freemium), and later: course instructors / TAs / departments.
- **Price:** $0 free / $4-6 per user / month / Pro / $TBD per seat for institution.
- **Moat:** the session model + AI session artifacts + cross-platform + price.

### Option C — Specialized pivot (interview prep, design sprints, agile retros)
Same engine, narrower wedge. e.g. "the whiteboard for technical interview pair-programming" — built-in timer, prebuilt scratch templates, AI summary that becomes a debrief.
- Risk: narrower market means harder to grow organically; needs more sales effort to seed.
- Reward: less competition, clearer messaging.

**Recommendation: Option B**, with a hedge — at the end of **Month 3** you will have enough data (10-20 real users) to decide whether to keep going on B or repivot to C. The work in Months 1-3 is mostly infrastructure that benefits all three options anyway.

---

## 4. The 6-Month Plan

Each month has: **goal**, **scope**, **explicit out-of-scope**, **verification**, **risks**, **exit criteria**. Don't move on to the next month until exit criteria are met.

The plan is structured as three two-month phases:

- **Phase 1 (Months 1-2): Harden.** Make the existing product actually shippable.
- **Phase 2 (Months 3-4): Differentiate.** Build the wedge (sessions + AI + multi-tenancy).
- **Phase 3 (Months 5-6): Monetize.** Ship a paid plan and acquire real users.

> **Heads up:** the monthly scope items below are dense. Detailed engineering rationale, alternate options, and the deep technical context for each theme live in the appendices at the end of this doc:
> - **Appendix A — Canvas & Drawing Engine Deep Dive** (coordinate model, element schema, rendering pipeline, conflict resolution, perf budgets)
> - **Appendix B — AI Feature Roadmap Deep Dive** (model choices, cost targets, accuracy expectations, server vs client split)
> - **Appendix C — Collaboration Features Catalog** (everything beyond strokes: cursors, comments, reactions, presence, notifications, sharing)
> - **Appendix D — Mobile-Native Capabilities Catalog** (Apple Pencil, S-Pen, palm rejection, widgets, document scanner, native gestures)
> - **Appendix E — Education / Study-Group Vertical Catalog** (instructor flows, classroom features, content, compliance)
> - **Appendix F — Feature Backlog (M7–M12+)** (things that intentionally don't fit in 6 months but are worth tracking)
>
> When a monthly scope item feels under-specified, jump to the appendix — that's where the "how" lives.

---

### Month 1 — Hardening + Foundations ✅ COMPLETE

**Goal:** Make the app survive contact with real users on real networks.

**Status:** Delivered across 7 phases, all merged to `main` (PR #89). Full
retrospective — what shipped, senior-call deviations, and carry-forward items —
lives in [`docs/month-1-phases.md`](docs/month-1-phases.md). Summary below.

**Shipped:**
1. ✅ **Drawing perf + correctness** — 30 Hz input coalescing + RDP simplification before the Firestore write; persisted per-path `bbox`. (`src/lib/simplify.ts`, `pathService`)
2. ✅ **Offline support** — `persistentLocalCache` + multi-tab manager, connectivity detection, offline banner. (`src/config/firebase.ts`, `OfflineBanner.tsx`)
3. ✅ **Error handling baseline** — top-level `ErrorBoundary`, `errorReporting.ts` seam replacing silent catches.
4. ✅ **Tests** — Jest + `@testing-library/react-native`; 16 suites / 140 tests; 60% global gate enforced in CI.
5. ✅ **Pan + zoom + coordinate model** — board-space/viewport contract, `react-native-gesture-handler`, 10–800% zoom, `ENABLE_PAN_ZOOM` flag. (`src/lib/viewport.ts`, `useViewport.ts`)
6. ✅ **Viewport culling** — R-tree-free bbox cull with 200px margin ring, throttled re-eval. (`src/lib/culling.ts`)
7. ✅ **Board snapshot / checkpoint** — client-side compaction every 500 writes; cold-load accelerator + M5 version-history substrate. (`snapshotService.ts`)
8. ✅ **Selection primitive** — single-element tap-select via `useSelection` slice, bbox/handles, delete; **real eraser** (stroke deletion, not white paint). (`hitTest.ts`, `SelectionOverlay.tsx`)

**Exit criteria:**
- ✅ All scope items merged to `main`.
- ✅ Eraser works correctly (erase → refresh → stays erased).
- ✅ ≥ 60% service coverage via `jest --coverage`.
- ⚠️ **Sentry dogfood exception — NOT met.** The seam is in place but the real
  `@sentry/react-native` SDK needs a DSN + native (EAS) build. **Carried into
  Month 2** (see M2 Phase 1 below; tracked as issue #3).

**Open carry-forward into later months:** real Sentry SDK (M2), selection
unification on text (M2), on-device Android perf baseline numbers (M2+),
Cloud-Function snapshot compaction + pruning (M5). Details in
[`docs/month-1-phases.md`](docs/month-1-phases.md) § Carry-forward.

---

### Month 2 — Production Readiness + Auth Polish

**Goal:** Make the app installable from the actual app stores (or installable as a real PWA) by anyone, not just Expo Go users.

**Status:** Code-complete on `feature/month-2-production-readiness`; remaining work
is device/store verification, not implementation. Phase-by-phase record lives in
[`docs/month-2-phases.md`](docs/month-2-phases.md). All 12 scope items have shipped
code; `tsc --noEmit` is clean and the suite is green (28 suites / 306 tests). Two
items are deferred by design (see below). The exit criteria are **not yet met** —
they depend on signed builds, store credentials, and real devices.

**Implementation status (this branch):**
- ✅ **Code-complete (all 12 scope items):** EAS profiles + Sentry SDK (1), push
  for standalone builds (2), PWA manifest/SW/install prompt (3), auth polish —
  reset + email verification (4), secrets hygiene + crypto codes (5), deep links /
  Universal+App Links / share intake (6), shape tools (7), multi-select + group
  transforms (8), clipboard (9), keyboard shortcuts (10), background templates
  (11), first-class image elements (12).
- ⏸️ **Deferred by design:** **Google Sign-In → M3** (behind the `authProviders`
  seam; needs `expo-auth-session` + Phase-2 native OAuth redirect, can't be
  verified without a native build). **Group/ungroup → later** (needs a persistent
  `groupId` data-model primitive, out of a shortcuts phase).

**Remaining to close Month 2 (verification + store ops — nothing code-blocked on a dev machine):**
1. **Apple Developer Program enrollment** ($99/yr) — serial dependency; gates
   TestFlight, APNs, and the iOS link/share verifications. Start day one.
2. **Signed builds:** Android `.aab` → Play internal testing track; iOS → TestFlight.
3. **Sentry dogfood exception** (carried from M1, issue #3) — throw a deliberate
   exception on a standalone build, confirm it lands in the Sentry dashboard.
4. **Push on real devices** — FCM (Android) + APNs (iOS) credentials wired via EAS;
   confirm a session notification fires on ≥ 1 standalone iOS and ≥ 1 Android.
5. **Universal/App Links — swap the placeholder domain.** The native association is
   now declared (`ios.associatedDomains` + an Android `autoVerify` `VIEW` intent
   filter in `app.json`) against the `boardapp.example.com` placeholder. Replace it
   with the real domain in `app.json`, `EXPO_PUBLIC_LINK_DOMAIN`, and the two
   `public/.well-known/` association files (Apple Team ID + EAS SHA-256), then verify
   a `https://<domain>/b/<inviteCode>` tap opens the app and joins on both platforms.
6. **Share-INTO-app receiver — wired, needs on-device verification.** `expo-share-intent`
   (approved) provides the Android `SEND` reader + generated iOS Share Extension via its
   config plugin; `_layout.tsx` routes a shared image to the `/share` board-picker, which
   places it through the Phase 9 pipeline. Runs in an EAS build only — verify "share a PNG
   from Photos → lands on the chosen board" on real iOS + Android.
7. **Lighthouse** against the served PWA build — confirm > 80 perf / > 90 a11y;
   exercise the install prompt.
8. **Auth round-trips on a real account** — password-reset email + verification tap-through.
9. **Mobile-parity gate (canvas Phases 7–12):** on a real mid-range Android, exercise
   each canvas feature, run the perf check vs `docs/perf-baseline.md`, and attach a
   screenshot to the PR.
10. **Manual hardware-key hooks** — the config plugin no-ops on SDK 55 Swift/Kotlin
   templates; add the AppDelegate/MainActivity hooks by hand at prebuild (README).

**Known limits carried forward (intentional, tracked for M3+):** Storage objects
orphaned on group-delete/clear-board; z-order is per-layer (paths < shapes < text),
not global; non-uniform resize of an already-rotated shape is approximate; the board
doc isn't subscribed, so background-template / title changes reach other members on
next load, not live.

**Scope:**
1. **EAS Build setup**
   - Configure `eas.json`. Preview + production profiles.
   - Generate signed Android `.aab`. Internal testing track on Google Play.
   - TestFlight build for iOS (requires Apple Developer Program — $99/year — budget for this now).
   - Document the build commands in README.
2. **Push notifications outside Expo Go**
   - Wire up FCM (Android) and APNs (iOS) tokens via EAS credentials.
   - Update `notificationService` to use Expo Push API correctly with EAS-issued tokens.
   - Test session notifications fire on standalone builds.
3. **Web as a real PWA**
   - Add `manifest.json`, service worker, install prompt.
   - Performance audit (Lighthouse > 80 on perf, > 90 on a11y).
4. **Auth UX cleanup**
   - Add password reset flow (Firebase Auth supports it; UI doesn't expose it).
   - Add Google Sign-In via `expo-auth-session`. Major UX win for students.
   - Email verification — display unverified banner, send verify email on signup.
5. **Secrets hygiene**
   - Move Firebase config to env vars via `expo-constants` extra. Keep dev config committed; production config injected at build time.
   - Swap `Math.random` invite-code generation for `crypto.getRandomValues`.
6. **Mobile-first integration primitives**
   - **iOS / Android share-sheet handler.** Users can share an image, PDF, or link from any other app into B.O.A.R.D and have it land as a placed element on a chosen board (or a fresh quick-board). Wire via `expo-sharing` / `expo-intent-launcher` and the iOS Share Extension.
   - **Universal Links (iOS) + App Links (Android).** A URL like `https://<domain>/b/<inviteCode>` opens the installed app on tap, or falls through to the web app — no manual code entry, no copy-paste friction.
   - Document the deep-link schema (`boardapp://board/{id}?session={id}`) and lock it down now — it's the contract every Phase 2/3 integration will lean on.
7. **Shape tools (rectangle, ellipse, line, arrow)**
   - SVG primitives with start/end resize handles. Arrows include arrowhead style picker (none / classic / dot / circle / open).
   - Shapes have fill (with alpha), stroke color, stroke width, dashed/dotted stroke options.
   - **Snap-to-grid** toggle (8px / 16px / 24px). **Smart guides** — when dragging a shape near another, show a 1px guide line if edges align (8px tolerance).
   - Hold Shift to constrain: square (rect), circle (ellipse), 45° angle (line).
8. **Multi-select + group transforms**
   - Drag a marquee rectangle on empty canvas to select multiple elements. Shift-click to add/remove from selection. Cmd/Ctrl-A selects all in viewport.
   - Group operations on selection: move, delete, recolor, duplicate, change stroke width, send-to-back / bring-to-front.
   - Selection bounding box has 8 resize handles + a rotate handle. Resize is uniform-scale; non-uniform if Alt held.
   - Use an R-tree (the `rbush` npm package) for spatial hit-testing — keeps marquee selection O(log n) even with thousands of elements.
9. **Clipboard: copy / paste / duplicate**
   - Cmd/Ctrl+C / Cmd/Ctrl+V / Cmd/Ctrl+D. Same in-app or across boards within the same workspace.
   - On web: integrate with the system Clipboard API so you can paste **images from outside the app** (screenshots, photos) directly onto the board.
   - Pasted images are auto-uploaded to Firebase Storage, downscaled to ≤ 2048px on the longer edge, and become `Image` elements on the board.
   - Duplicate places the copy 16px offset down-right from the original.
10. **Keyboard shortcuts (web + Bluetooth keyboards on iPad/Android)**
    - Tool switches: `P` pen, `E` eraser, `T` text, `R` rectangle, `O` ellipse, `L` line, `A` arrow, `S` select, `H` pan-hand, `N` sticky note.
    - Actions: Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z redo, Cmd/Ctrl+A select-all, Cmd/Ctrl+D duplicate, Cmd/Ctrl+G group, Cmd/Ctrl+Shift+G ungroup, Delete/Backspace delete, Escape deselect, Space-drag pan, `1` fit-to-content, `2` 100%, `+`/`-` zoom in/out.
    - `?` opens a keyboard cheat-sheet modal. Discoverability is half the value.
11. **Background templates**
    - Per-board setting: blank / grid (8mm) / dot grid / lined (notebook) / isometric / coordinate plane (math axes).
    - Rendered as a non-interactive SVG layer behind everything; scales with zoom.
    - Useful for students: lined for notes, dot grid for sketching diagrams, coordinate plane for math.
12. **Image elements (first-class)**
    - Insert from device gallery, camera, share sheet (M2 item 6), system clipboard, or drag-and-drop on web.
    - Stored in Firebase Storage, referenced by URL in the element doc. Original + thumbnail variants.
    - Resize / rotate / move via standard selection handles. Crop is M5 polish.

**Out of scope:** Cloud Functions. Billing. AI work. Comments (M3). Live cursors (M4). Voice notes / math equations (M5).

**Verification:**
- Install Android `.aab` on a real phone outside Expo Go, receive a session notification.
- TestFlight install works on iOS.
- `lighthouse --view` on the web PWA build clears the thresholds.
- Share a PNG from the iOS Photos app into B.O.A.R.D and confirm it lands on a board. Same flow on Android.
- Tap a `https://<domain>/b/<inviteCode>` link from a chat app on both iOS and Android, confirm it opens the native app and joins the board.

**Risks:**
- iOS submission could stall on review for the AI / generated-content features. Mitigation: hold AI off the production track until Month 4.
- Google Sign-In on Expo bare workflow has historical pain. Budget 3 days; if blocked, defer to Month 3.

**Exit criteria:**
- App is installable on Google Play (closed test track), TestFlight, and web.
- Push notifications confirmed delivered on at least one standalone iOS and one standalone Android device.
- You can hand a TestFlight link to a friend and they can sign in with Google.

---

### Month 3 — Multi-tenancy + Workspaces

**Goal:** Restructure the data model so the product can support multiple isolated groups (study groups, classes, teams) under one account, with roles.

This is the foundation for everything in Phase 2 and 3. **Do not skip it. Do not defer it. It gets harder every month you wait.**

**Scope:**
1. **Workspace model**
   - New Firestore collection `/workspaces/{wsId}` with: `name`, `ownerId`, `members: { uid: role }`, `plan`, `createdAt`.
   - Roles: `owner`, `admin`, `member`, `viewer`.
   - Personal workspace auto-created on signup.
2. **Board belongs to a workspace**
   - Add `workspaceId` to `boards`. Migration script for existing data (write a one-off Node script using Admin SDK).
   - Update queries: list boards filters by `workspaceId`.
   - Update `firestore.rules` to gate via workspace membership rather than board.members directly (board.members becomes a sub-set of workspace members granted access to that specific board).
3. **Workspace switcher in UI**
   - Persistent dropdown in the top bar.
   - "Create workspace" flow.
   - Invite members to a workspace (email-based; reuse existing invite-code primitive).
4. **Sessions inherit workspace**
   - `session.workspaceId`. Used later for usage metering.
5. **Hooks for plan-gating**
   - Add `plan: 'free' | 'pro' | 'edu'` to workspace.
   - Add `checkQuota(workspaceId, resource)` helper used by `createBoard`, `createSession`, etc. — returns true today for everyone, but the choke point exists.
6. **Per-board roles (layered on top of workspace roles)**
   - Roles: `editor`, `commenter`, `viewer`. Workspace `viewer` cannot exceed `commenter` on any board; workspace `member` defaults to `editor` on workspace-owned boards.
   - Stored as `boards/{id}.roles: { uid: role }`. Defaults inherited from workspace membership; per-board overrides are explicit.
   - UI: a "Share & permissions" modal replaces the current share modal — single dialog covers invite link, who has access, role, and revoke.
   - Use case: share a finished study-guide board read-only with classmates outside the workspace; let your TA comment but not edit.
7. **Comments + threads anchored to canvas elements**
   - Anchor a comment to a stroke, shape, text, sticky, or image. Comment indicator (numbered pin) renders near the anchored element.
   - Threaded replies. Resolve / reopen. Mark unread on viewer side.
   - Stored as `boards/{id}/comments/{commentId}` with `anchorElementId`, `replies[]`, `resolved: bool`.
   - Realtime via `onSnapshot`. Notifications on reply / @mention in M3-item-9.
8. **Activity feed (workspace + board scoped)**
   - Append-only log: "Arlo created Board X", "Scott commented on element Y", "Session Z ended with 4 participants", "Maria upgraded the workspace to Pro" (later).
   - Powers a "Recent activity" panel on the workspace home and a per-board history sidebar.
   - Foundation for the M5 board-version-history feature (paths from snapshot + activity log = ability to scrub a board through time).
9. **@mentions + notification routing**
   - Type `@` in a comment, autocomplete from workspace members. Mention persists as a structured token (not just text).
   - On mention: push notification + in-app notification + email digest (daily) for users who opt in.
   - Notification preferences live on the user doc; sensible defaults (push on mention, email digest daily).
10. **Workspace home / dashboard**
    - First screen after sign-in (replaces the current bare boards list).
    - Sections: pinned boards, recent boards, upcoming sessions, recent activity, workspace members.
    - Mobile parity: same content reorganized vertically; "pinned" + "upcoming sessions" are the above-the-fold cards.

**Out of scope:** Actually enforcing quotas. Stripe. AI. New canvas drawing tools (those landed in M2). Live cursors (M4).

**Verification:**
- Manual: create two workspaces, confirm boards in workspace A are not visible in workspace B even with crafted URLs.
- Firestore rules unit tests (use `@firebase/rules-unit-testing`) — at minimum cover: cross-workspace read denied, member read allowed, viewer write denied.
- **Mobile UX check:** workspace switcher reachable in ≤ 2 taps on a small phone screen (iPhone SE / 5.5" Android). If it isn't, the design isn't done.
- Re-run the M1 perf baseline on Android — confirm the workspace query / membership-check changes did not regress time-to-first-paint of a board.

**Risks:**
- This is the highest-risk month. The migration is invasive and could break the existing app for testers. Mitigation: run on a `feature/workspaces` branch, ship to a staging Firebase project, only flip prod after a week of internal use.
- Firestore rules complexity grows fast — keep the helper functions tight, add rules tests.

**Exit criteria:**
- Two test users, each in two workspaces, can collaborate within a workspace and cannot see the other's boards.
- Migration script runs successfully on a snapshot of prod data.
- Firestore rules tests pass in CI.

**Mid-point gut check (end of Month 3):**
- How many real users have you seeded outside your class? Target: 10-20.
- Are the AI summaries (still in WIP) something users *want*? Talk to 5 people.
- If the answer is "no, they want X instead" — repivot to Option C now, while the architecture is still flexible.

---

### Month 4 — The Wedge: Sessions + AI

**Goal:** Make the session experience the reason someone chooses B.O.A.R.D over Excalidraw.

**Scope:**
1. **Cloud Function for AI**
   - Move OpenAI calls to a Firebase Cloud Function. The function holds the API key, is rate-limited per workspace, and writes the summary back to the session doc.
   - Delete the `users/{uid}/private/apiKeys` flow. Migrate any existing keys with a notice.
   - Add a per-workspace monthly summary budget (e.g. 10 free, then quota gate).
2. **Session lifecycle UX**
   - Pre-session lobby: who's joining, board preview, agenda field.
   - In-session: timer, "raise hand" / reactions, optional voice (defer to Month 5 if too big — use stock WebRTC via something like Daily.co's free tier if time).
   - Post-session: AI summary, exportable session recap (PDF), shareable read-only board URL.
3. **AI summary v2**
   - Fix mobile snapshot capture (currently web-only). Use `react-native-view-shot` for native, send image + extracted text to the Cloud Function.
   - Two summary modes: short ("TL;DR") and detailed (action items, decisions, open questions).
   - Show the summary as a structured artifact, not a blob of text.
4. **Session history**
   - New tab: "Past sessions" with summary, snapshot thumbnail, attendees, duration.
   - This is the daily-driver value prop. A student who studied for 3 finals via the app sees three nicely-organized recap cards.
5. **Embeddable boards (foundation for every later integration)**
   - **Read-only iframe embed:** `<iframe src="https://<domain>/embed/b/<boardId>?token=…">`. Anyone with a signed link can view a board inside a blog post, a Notion page, a Confluence doc, or a course page. No auth needed.
   - **Editable embed:** same URL pattern with an `embedToken` (signed JWT) that asserts identity from the host app — used in Month 5 for the meeting-app integration and in Month 6 for the LMS / browser-extension options.
   - **Embed-mode UI flag:** strips chrome (tabs, profile menu) so the board fills the parent frame. Same React tree, conditional rendering.
   - This single deliverable unblocks Zoom Apps, Notion embeds, Canvas LTI, and a browser extension. Build it once; integrate it everywhere.
6. **Live cursors of other users**
   - Render every active user's pointer position in real time with their name, color, and tool icon. FigJam / Figma / Google Docs UX is the reference.
   - Throttled to ~20Hz on the writer side; subscribers see ~10-15Hz after network jitter. Cursor positions write to a `boards/{id}/cursors/{uid}` doc, not the path collection — keeps the noisy traffic off the persisted-state listeners.
   - On Firestore being too laggy at scale (likely by mid-M4): drop in **Ably** or **Liveblocks** free tier as a side-channel for ephemeral data (cursors, presence, reactions) while keeping Firestore for persisted state.
7. **"Follow user" mode**
   - Pick a user from the presence avatars → your viewport tracks theirs (camera follows their pan/zoom). Visual indicator "Following Scott."
   - Killer for teaching: "watch me draw this." Killer for study-group catch-up: "show me where you're stuck."
   - Tapping the canvas exits follow mode.
8. **AI: shape recognition + auto-perfect**
   - When the user finishes a stroke that resembles a primitive (rectangle, circle, triangle, arrow, line), show a discreet "perfect it?" affordance. Tap to replace the rough stroke with a clean shape.
   - Implement client-side via geometry rules: vertex extraction, angle classification, RANSAC-style circle fit. No model needed for v1 — `simplify-js` + a 100-line heuristic gets 80% of the way.
   - Per-user toggle: "always auto-perfect," "ask each time," "never."
9. **AI: handwriting OCR (board-aware)**
   - Select a region of strokes → run through OpenAI gpt-4o-mini vision (or Google Cloud Vision OCR — cheaper, less context-aware) → result is a new editable text element placed at the same location.
   - Particularly valuable for iPad/Apple Pencil users taking handwritten notes.
   - Caching: result memoized against a hash of the path IDs so re-running is free.
10. **AI: "explain selection"**
    - Select strokes / text / both / image → command "explain this" → returns a structured explanation as a new text block placed next to the selection.
    - Different prompt path from session summaries; small scope, fast feedback (≤ 5s).
    - For STEM use: "explain this equation," "what's wrong with this proof," "summarize my notes."
11. **AI: text → diagram (Mermaid-style)**
    - Sidebar prompt: "draw a flowchart for how HTTPS handshake works" → AI returns Mermaid syntax → rendered as native B.O.A.R.D shapes (nodes, edges, labels) that are then editable.
    - Limit v1 to: flowcharts, sequence diagrams, class diagrams, mind-maps, simple network diagrams.
    - Mermaid → B.O.A.R.D conversion is a one-time renderer module; keep it under `src/lib/mermaid-to-board.ts`.
12. **AI quota management + cost telemetry**
    - Per-workspace monthly AI usage budget (with free / Pro / Edu tiers). Surfaced in a workspace settings page.
    - Per-request cost logging into Firestore (model, token count, $ estimate). Powers the M5 plan-gating decisions.
    - Hard daily spending cap on the OpenAI account itself, set in the OpenAI dashboard.

**Out of scope:** Billing. Real voice/video (covered indirectly by the M5 meeting-app integration). Templates. Voice notes, math equations, code blocks (M5). Flashcard generation, board Q&A (M6).

**Verification:**
- Have a real 30-minute study session with a friend. End-to-end: schedule → notify → join → collaborate → end → summary appears → both can view it tomorrow.
- AI summary cost-per-session benchmark: < $0.02 average. (Track via OpenAI dashboard.)

**Risks:**
- AI quality. GPT-3.5 summaries of mostly-drawings are bad. Force the user to add text / agenda items; bias the AI prompt toward structured output (JSON schema).
- Cloud Function cold starts on the free tier. Acceptable for v1.

**Exit criteria:**
- 5+ real sessions completed by users outside the core team.
- Average user-reported summary quality rating ≥ 3.5/5 (just ask them).
- OpenAI key fully removed from client.

---

### Month 5 — Monetization Infrastructure

**Goal:** Be able to charge money.

**Scope:**
1. **Stripe integration**
   - Stripe Checkout for self-serve upgrade. Use Firebase's official Stripe extension if available (it is — `firestore-stripe-payments`). This saves 1-2 weeks of plumbing.
   - Webhook → workspace.plan updated on successful payment.
   - Customer portal for cancellation / payment-method changes.
2. **Plan gating, enforced**
   - Free: 1 workspace, 5 boards, 3 sessions / month, 5 AI summaries / month, max 4 collaborators per board.
   - Pro: $5/user/month — unlimited boards, sessions, AI; up to 25 collaborators; session recordings retained 90 days.
   - Edu: $TBD/seat — bulk-priced for instructors with their class roster; only sell this manually for now (don't build self-serve).
   - `checkQuota` from Month 3 becomes a real gate. Surface upsell modals on hit.
3. **Usage dashboard**
   - For the workspace owner: how many sessions this month, how much AI used, how close to plan limits.
4. **Onboarding polish**
   - First-run tutorial. Sample board with a 90-second walkthrough.
   - Empty-state CTAs that point at value (not "you have 0 boards" — "Schedule your first study session →").
5. **Pricing page**
   - Hosted on the same domain. Honest copy. Show the free tier first.
6. **First meeting-app integration (the headline integration for launch)**
   - **Pick one:** Zoom Apps SDK *or* Google Meet add-ons — whichever has the better solo-dev DX in 2026 (Zoom historically has more docs; Meet add-ons are newer but lower review friction). Do **not** split scope across both. The loser becomes a stretch goal for Month 7+.
   - The integration is a thin shell around the M4 embeddable board: the meeting platform loads `https://<domain>/embed/b/<boardId>` inside its panel, passes an auth token, and the user can collaborate on a board without leaving the call. End the call → AI summary is in the user's session history when they reopen the app.
   - Submit to the platform marketplace early in the month — review queues run 1–4 weeks. Don't gate launch on approval; ship a self-hosted manual-install version (unlisted) in parallel.
7. **Presenter mode (Pro-tier feature)**
   - Board owner / session host enters presenter mode. Toggle in the session header.
   - Side effects: everyone else's viewport locks to follow the presenter's (overrides individual follow choices); drawing disabled for non-presenters (configurable); a "presenting" banner appears for the audience.
   - Pause / resume — presenter steps away without dropping everyone out.
   - Use cases: a tutor walking through a problem; a TA hosting office hours; a study-group lead reviewing an exam.
8. **Laser pointer / spotlight tool**
   - Temporary marker that follows the active user's cursor for 2 seconds then fades. Non-persistent (does not write to Firestore path collection — uses the live-cursor side channel from M4).
   - Hotkey on web (`L`). Press-and-hold for continuous laser; quick-tap for a single "ping."
   - Sells the presenter use case; trivial implementation if M4 cursor channel is solid.
9. **Voice notes attached to elements (Pro-tier)**
   - Record up to 60s of audio attached to a stroke, sticky, text, or image. Tap a speaker icon on the element to play.
   - Storage: Firebase Storage. Audio format: AAC (m4a) for size; ~80KB per 10s.
   - Transcription deferred to M6 (covered by board Q&A AI work).
   - Use case: "leave a voice note explaining why this proof works" — async tutoring at its lowest-friction.
10. **Math equation rendering (KaTeX)**
    - Special text-element mode: type LaTeX, render as a math equation. Toggle via `$$` wrap or a dedicated "math" tool button.
    - Critical for STEM students. KaTeX is small (~280KB gzipped), fast, fully client-side, MIT-licensed.
    - Equations are still single text elements — they participate in selection, transform, comment, AI summary.
11. **Code blocks with syntax highlighting**
    - Paste or type code into a "code" element. Auto-detect language (or pick from a menu). Render with Shiki (preferred — Monaco-quality themes) or Prism.
    - Use case: CS group projects discussing code on a board next to a flowchart of the algorithm.
    - Element-level "copy code" action.
12. **Color + stroke polish (Pro-tier feel)**
    - Custom color picker with hex input, alpha slider, recent-colors row, swatch palette per workspace.
    - 6 stroke widths (was 3) plus a continuous width slider for the eyedropper crowd.
    - **Eyedropper tool** — sample color from any element on the canvas.
    - Highlighter pen (semi-transparent, wide stroke, multiply blend mode).
    - Marker pen variant (thicker, harder edges) and a calligraphy variant (width responds to direction).
13. **Sticky-note polish**
    - 8 colors, 3 sizes (small/medium/large), markdown rendering (bold, italic, lists, links).
    - Pinnable to a position or attachable to another element (sticky-on-shape).
14. **Free-vs-Pro upsell surfaces**
    - When a user hits a gate (6th board, 4th session this month, 6th AI call), show an inline upsell modal: "You've used your free quota. Upgrade for $5/mo." Direct link to Stripe checkout. Skip on first attempt; harder push on second.
    - Pro-only feature affordances (presenter, voice notes, math, code, custom palette) show a subtle "Pro" badge in the tool picker for free users; click → upgrade modal.

**Out of scope:** Anything not on the path to "user gives me money." LMS integration (M6). Templates (M6). Flashcards / board Q&A (M6).

**Verification:**
- End-to-end Stripe test: free account, upgrade with `4242 4242 4242 4242`, confirm `workspace.plan == 'pro'`, downgrade, confirm gate kicks back in.
- Onboarding usability test: hand the app to one friend who's never seen it, no instructions, time-to-first-board.

**Risks:**
- App Store / Play Store rules around in-app payment. If you sell anything that unlocks app features, Apple wants its 30%. **Mitigation:** sell Pro on the web only initially. iOS/Android users can still pay via web Stripe, then their mobile app reflects the upgrade on next login. (This is what Notion, Slack, Spotify all do.)
- Pricing is a guess. Be willing to change it in Month 6 based on conversion data.

**Exit criteria:**
- One paying customer that is not you, your co-developer, or a family member.
- All five free-tier gates actually enforced.

---

### Month 6 — Growth + Decide

**Goal:** Get to 100 active users and decide whether to keep going.

**Scope:**
1. **Education vertical push**
   - Build an instructor-facing flow: import a class roster (CSV), create a board per assignment, see all students' work in one grid.
   - Reach out to 5 instructors at your university — TAs, lab leaders, study-group organizers. Offer free Edu tier for the semester in exchange for feedback.
2. **Pick ONE second integration (driven by what M5 users actually asked for)**
   - **Option A — Canvas LTI 1.3 integration:** instructors install B.O.A.R.D into a course, students authenticate via LTI, boards appear inline as assignments and grades sync back. Highest leverage for the education pivot; 2–3 weeks of work, plus partner-application paperwork.
   - **Option B — Browser extension (Chrome + Edge):** toolbar button opens a quick-board side panel next to whatever the user is reading; drag an image from any web page onto the board; "send this Doc/Notion page to a board" action. Strongest fit if M5 surfaced "I want to whiteboard alongside docs and articles, not only meetings." 1–2 weeks of work.
   - **Option C — Slack / Discord app:** post a board snapshot to a channel, get DM'd a join link, end-of-session summary auto-posts. Lighter than LTI, smaller education leverage, but huge for study-group word-of-mouth in CS Discords.
   - **Do not build more than one.** Picking is the work; building is the easy part. Decide by the first week of the month.
3. **Templates** *(see item 7 below for the full template library scope)*
4. **Analytics + experiment harness**
   - PostHog or Amplitude free tier. Track: signup, first board created, first session scheduled, first session completed, first AI summary, first paid upgrade, integration-install events for whichever surfaces you shipped.
   - You can't optimize what you don't measure.
5. **SEO / content**
   - Three blog posts: "Best whiteboard for study groups in 2026," "How to use B.O.A.R.D for X" (X = group project planning, exam review, design jam).
   - Honest dev-log post about building it as a student. The integration story ("works inside Zoom / inside your LMS / inside your browser") is the headline.
6. **Launch**
   - ProductHunt, Hacker News (Show HN), r/learnprogramming, r/college, your university's CS Discord, LinkedIn, and — critically — the Zoom App Marketplace / Canvas Partner directory / Chrome Web Store page from your M5 / M6 integration.
   - Pick one launch date and aim everything at it.
7. **Template library v2 (15-20 templates)**
   - **Study templates:** Cornell notes, flashcard deck, mind-map, spaced-repetition planner, exam-review grid (topics × confidence), study-streak tracker.
   - **CS / engineering templates:** sprint planner, code-review checklist, system-design canvas, design-doc structure, sequence-diagram canvas, ERD canvas.
   - **Classroom templates:** lab-report template, lecture-notes layout, group-brainstorm with zones, peer-review canvas, weekly project Kanban.
   - **Meeting templates:** retro (start/stop/continue), 1:1 agenda, daily-standup board, decision log.
   - Each template ships as a JSON board export under `src/templates/`. New-board flow shows them in a gallery.
   - Templates are a content-marketing wedge: each gets an indexable landing page (`/templates/cornell-notes`) with a 30-second walkthrough video.
8. **Quizzes + polls (engagement primitive)**
   - Drop a poll widget on the board: question, 2-6 options, optional anonymous mode. Members tap to vote; live result bars update in real time.
   - Quiz mode: multiple polls in sequence with a "show answer" reveal. Useful for study quizzes and instructor checks-for-understanding.
   - Powers M6 dot-voting use case for design retros too.
9. **Reactions + dot voting on elements**
   - React to any element with 👍 / ❤️ / ❓ / ⭐ / 💡 — counts visible on the element corner.
   - Dot-voting mode (host-toggled): each user gets N votes, drops them on elements, host can sort/cluster by vote count. Classic retro / design-sprint mechanic.
10. **AI: flashcard generation**
    - Select a region of notes → generate flashcard pairs (front/back) → review in a built-in spaced-repetition UI (SuperMemo SM-2 algorithm; small, well-studied).
    - Export to Anki `.apkg` format for power users.
    - Killer for exam-prep. Single highest-ROI student feature you can build.
11. **AI: board Q&A (chat with your board)**
    - Sidebar chat panel scoped to a single board. "When did we cover backpropagation?" "What's the deadline for the design doc?" "Summarize Maria's contributions."
    - Indexes board content + session history + comments. Uses embeddings (`text-embedding-3-small`) cached per element; chat answers via gpt-4o-mini with retrieved context.
    - Foundation: same RAG pattern can later expand to workspace-wide Q&A as a Pro feature.
12. **Mobile camera capture / document scanner**
    - On mobile, "+ → Scan a document" launches the camera with edge-detection (`expo-document-scanner` or VisionKit on iOS, ML Kit on Android).
    - Output: rectified PNG placed on the board, plus optional OCR'd text element below it.
    - Use case: snap a textbook page, drop it on the study board, AI explains a passage.
13. **Print + export polish**
    - Export a board to: PNG (with viewport / fit-content options), PDF (multi-page tiling for large boards), SVG (vector, lossless).
    - "Print this board" → PDF on web; native print on mobile.
    - Important for instructors who want hard copies and students who want to study offline.
14. **Onboarding tutorial + sample workspace**
    - First-run: an interactive 90-second tutorial that walks through draw → shape → invite → schedule session → end session → see AI summary.
    - Sample workspace seeded with: a study-session example board, a finished session with AI summary, a class-roster mock.
    - Cuts time-to-first-aha-moment from 5 min to under 60s. The single biggest funnel improvement available pre-launch.

**Out of scope:** New canvas tools, fancy AI features, anything not driving the funnel.

**Verification:**
- DAU / WAU / MAU pulled from analytics.
- Conversion rate from free → Pro (any conversion at all is a win at this stage).

**Exit criteria + decision point:**
- 100+ signups, 20+ weekly active, 3+ paying.
- Either: keep going with the same wedge → write the Month 7-12 plan with confidence.
- Or: numbers don't support it → repivot using everything you've built. The infra (workspaces, billing, real-time collab, Cloud Functions) is reusable for any collaboration product. The pivot cost is weeks, not months.
- Or: it's working but it's not fun → open-source it, write a great README, put it on your résumé, ship something else. This is a legitimate outcome.

---

## 5. Tooling, Infra, and Budget

| Item | Cost | When needed |
|---|---|---|
| Apple Developer Program | $99/yr | Month 2 |
| Google Play Developer | $25 one-time | Month 2 |
| Domain (e.g. `board.app` is taken — pick something) | $10-30/yr | Month 2 |
| EAS Build (production plan, optional but recommended once charging) | $0-19/mo | Month 2 |
| Firebase Spark (free tier) | $0 | Months 1-4 |
| Firebase Blaze (pay-as-you-go) | < $20/mo at low usage | Month 5 onward |
| Firebase Storage (images, voice notes, snapshots) | included in Blaze | Month 2 onward |
| Cloud Functions (AI + embed token mint + Stripe webhook) | included in Blaze | Month 4 onward |
| OpenAI API (summary + Tier-1 AI features) | ~$5-30/mo at MVP scale | Month 4 |
| Google Cloud Vision API (cheap OCR fallback) | $0-5/mo at MVP | Month 4 |
| Whisper API (voice transcription, M6) | $0.006/min audio | Month 6 |
| Ably / Liveblocks free tier (live cursors side-channel) | $0 (free tier ~3M msg/mo) | Month 4 |
| Stripe | 2.9% + $0.30/txn | Month 5 |
| Sentry free tier (5k errors/mo) | $0 | Month 1 |
| PostHog free tier (1M events/mo) | $0 | Month 6 |
| Android test device (Pixel 6a or Galaxy A — used) | $150-250 one-time | Month 1 |
| Mid-tier iPad (used, M1+) | $250-400 one-time | Month 2 or later (Pencil testing) |
| Zoom Apps Marketplace listing | $0 | Month 5 |
| Chrome Web Store developer account | $5 one-time | Month 6 (if extension option) |
| Canvas Partner / LTI tools application | $0 | Month 6 (if LTI option) |
| **Estimated total Year 1, solo, lean execution** | **~$500-900** | |

This is a viable solo budget. The biggest cost risks are Firebase (if you accidentally leave a hot listener or unbounded query) and OpenAI (if AI quota gates leak). Both have hard spending caps — set them on day one, not when the bill arrives.

**Cost guardrails to set in Month 1, before any of this matters:**
- Firebase: budget alert at $5 / $20 / $50; hard cap at $100.
- OpenAI: monthly hard cap at $50 (raise as you scale).
- Google Cloud (Vision API + any auxiliary): budget alert at $5 / $20; hard cap at $50.
- Ably / Liveblocks: monitor message volume weekly; the free tier blows up fast if cursor throttling regresses.

---

## 6. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Solo dev burnout | High | Project dies | Cap weekly hours, take one full weekend off / month, write a journal entry monthly on whether you still enjoy this |
| Firebase cost spike from real-time listeners | Medium | $$ surprise | Spending alerts at $5/$20/$50; add listener lifecycle logging in Month 1 |
| iOS App Store rejection on AI content | Medium | 2-4 wk delay | Pre-launch: read the App Store guidelines on generated content; mark AI-generated artifacts as such |
| GPT-3.5 summaries are bad | High | AI is the wedge; if it's bad, no wedge | Force structured input (agendas, text notes), benchmark against gpt-4o-mini, charge for AI to subsidize the upgrade if needed |
| Workspace migration breaks production users | Medium | Trust loss | Run on staging for a week, communicate downtime, snapshot Firestore before migrating |
| Apple/Google in-app purchase requirement | Medium | Forced 30% take or feature changes | Sell on web first; mobile reflects entitlement |
| The market doesn't want this | Medium | Pivot or shelve | The Month 3 gut-check exists for this reason |
| Co-developer leaves halfway | Medium | Slower velocity | Keep all design context in docs/, not in heads; pair on the workspace migration so two people understand it |
| Mobile parity silently regresses (web-first habit) | **High** | Kills the differentiator | Real Android device on the desk, not just emulator; mobile screenshot in every PR description; M1 perf baseline runs against Android in CI if possible |
| Integration platform review queues (Zoom App, Canvas Partner, Chrome Web Store) | Medium | 1–4 wk delay on the M5 / M6 launch | Submit early in the month, not at the end; ship unlisted / manual-install in parallel so launch isn't gated on approval |
| Integrating against APIs that change | Medium | Rework in M7+ | Wrap every third-party SDK behind a thin adapter in `src/integrations/`; never call platform SDKs from UI code |
| Embed-mode introduces an auth path that bypasses normal rules | Medium | Security incident | Embed tokens are short-lived signed JWTs minted by a Cloud Function; never expose long-lived tokens; rules-test the embed path |
| Scope creep within a month (the appendices make it tempting) | **High** | Month overruns, momentum loss | Treat the appendices as **reference**, not a checklist. Monthly scope is what's in section 4. Anything in an appendix that didn't make the month is by definition a Year-2 item until the month is over. |
| AI summary quality regression as you swap models | Medium | Wedge weakens | Snapshot 10 representative session transcripts/boards in M4; re-run any model change against them; require human approval before flipping the default model |
| Ephemeral side-channel (Ably / Liveblocks) free tier blows up | Medium | Cursors stop working / surprise bill | Throttle cursor writes server-side; monitor message volume weekly; design with a Firestore fallback so the feature degrades, not breaks |
| Element schema churn breaks old boards | Medium | Trust loss + manual fixups | Every new `type` lands behind a schema-version flag on the board; readers handle missing fields with defaults; migrations are explicit Cloud Functions |
| Voice/audio storage costs creep | Low-Medium | Surprise bill | Hard cap voice notes at 60s × 50 per board; transcode to AAC on upload; auto-delete voice notes 90 days after a free-tier board's last edit |

---

## 7. Success Metrics by Phase

| Phase | Hard metric | Soft metric |
|---|---|---|
| End of Month 2 | App on TestFlight + Play (closed) + PWA | Five non-team users have signed up |
| End of Month 3 | Workspaces in prod, rules tested | Ten non-team users; have talked to 5 about needs |
| End of Month 4 | AI summary cost < $0.02/session avg | Twenty real sessions completed by non-team users |
| End of Month 5 | One real paying customer | Five active workspaces |
| End of Month 6 | 100 signups, 20 WAU, 3 paying | A clear yes/no on whether to keep going |

If you miss two consecutive monthly hard metrics, stop adding features and spend a week on user interviews. Building features against the wrong problem is the most expensive mistake at this stage.

---

## 8. What This Plan Deliberately Leaves Out

- **Live video / voice built in-house.** Real-time A/V is a tarpit. The M5 meeting-app integration *is* the A/V story — let Zoom / Meet handle pixels and audio while B.O.A.R.D handles the board.
- **Native pencil / pressure sensitivity (Apple Pencil-specific gestures).** Cool, but a Phase 4 problem. Cross-platform parity matters more right now than iPad-only polish.
- **Building every integration at once.** M5 ships exactly one meeting integration; M6 ships exactly one additional surface (LTI *or* extension *or* Slack/Discord). Splitting attention across three half-built integrations is the failure mode here.
- **A desktop Electron app.** The web PWA is already installable. Electron is a Year-2 conversation, not a 6-month one.
- **Mobile app store ASO.** Web + the headline integration are the acquisition channels until you have signal worth optimizing.
- **Open-source community building.** Maybe later. For now it would split your attention.
- **A second product / consulting / agency work.** Don't.

---

## 9. Immediate Next Actions (This Week)

1. Read this doc, push back on anything you disagree with, commit a v2.
2. Open a GitHub milestone for Month 1. Create issues for: throttling, eraser fix, offline persistence, error boundary, Sentry setup, Jest setup, **Android perf baseline**.
3. **Get a mid-range Android test device.** Pixel 6a or Galaxy A-series, $150–250 used. This is the single best dollar-per-decision spend in the whole project — every monthly mobile-verification step assumes it's on your desk.
4. Decide: solo, or actively recruit the second contributor now? If recruiting, write a one-paragraph "what this is and what I need" pitch and send it to two people this week. Their first useful contribution is likely the embed/integration work in M4–M5; bias the pitch toward someone who's curious about platform SDKs.
5. Create a staging Firebase project. You'll need it by Month 3, but standing it up now is cheap.
6. Pick a product name. "B.O.A.R.D" / "BOARD" is too generic for SEO and trademark. Spend an hour on this, not a week.
7. Skim the Zoom Apps SDK docs and the Google Meet add-ons docs for ~30 minutes each. You don't need to decide between them until M5, but knowing which has the better DX shapes the M4 embed contract.

---

*This plan is a hypothesis, not a contract. Reread it at the end of every month. Update it when reality contradicts it. The goal is not to execute this exact roadmap — it is to ship a product worth shipping by November 2026.*

---

# Appendix A — Canvas & Drawing Engine Deep Dive

The canvas is the product. Everything else (sessions, AI, integrations, billing) is wrapper around it. This appendix is the engineering contract for how the canvas evolves across all six months.

## A.1 Coordinate model

- **Board space** is the canonical coordinate system. Infinite plane, no defined origin (boards center on `(0, 0)` for new boards, but elements can sit anywhere). Units are abstract "board units" — typically interpreted as pixels at 100% zoom.
- **Screen space** is what the user touches. The viewport `{ x, y, scale }` maps board → screen: `screen = (board - { x, y }) * scale`.
- **Every element** stores coordinates in **board space**. Render pipeline applies the viewport transform once at the top of the SVG tree (`<g transform="translate(...) scale(...)">`).
- **All hit-testing, snapping, bounding boxes, and AI region selection** operate in board space. Never convert to screen space until paint time.
- **Zoom range:** 10% to 800%. Below 10% renders simplified glyphs (icons-for-elements) — a Year-2 polish item.

## A.2 Element type taxonomy

The element model evolves across the plan. Each new month adds element types — keep the schema discriminated by `type`:

| Type | Introduced | Stored fields (beyond `id`, `bbox`, `createdBy`, `createdAt`, `updatedAt`) |
|---|---|---|
| `path` | exists today | `points: { x, y, t? }[]`, `color`, `strokeWidth`, `tool` (pen \| eraser \| highlighter \| marker) |
| `text` | exists today | `text`, `x`, `y`, `width`, `height`, `fontSize`, `color`, `markdown: bool` |
| `sticky` | exists today | `text`, `x`, `y`, `size` (s/m/l), `color`, `markdown: bool` |
| `shape` | M2 | `shape` (rect \| ellipse \| line \| arrow \| triangle), `x`, `y`, `width`, `height`, `rotation`, `fill`, `stroke`, `strokeWidth`, `dashed`, `arrowheadStart`, `arrowheadEnd` |
| `image` | M2 | `storagePath`, `thumbnailPath`, `x`, `y`, `width`, `height`, `rotation`, `naturalWidth`, `naturalHeight`, `alt` |
| `comment-anchor` | M3 | `anchorElementId`, `offsetX`, `offsetY`, `commentId` (refs `comments/{id}`) |
| `connector` | M4 (stretch) | `fromElementId`, `toElementId`, `routing` (straight \| orthogonal \| curve), `style` |
| `math` | M5 | `latex: string`, `x`, `y`, `width`, `height`, `displayMode` |
| `code` | M5 | `code: string`, `language`, `theme`, `x`, `y`, `width`, `height` |
| `voice-note` | M5 | `storagePath`, `duration`, `transcript?`, `anchorElementId?`, `x`, `y` |
| `poll` | M6 | `question`, `options: { id, label }[]`, `votes: { uid: optionId }`, `anonymous`, `x`, `y` |
| `flashcard-deck` | M6 | `cards: { front, back, ease, dueAt }[]`, `x`, `y` |

Every element doc should have a `bbox` field (precomputed bounding box in board space). Without it, multi-select, viewport culling, and AI region operations become O(n) on point arrays.

## A.3 Selection model

- `selection: { ids: Set<string>, anchor: 'elements' | 'region' | 'lasso' }`. Lives in a `useSelection` hook, **not** inside the canvas component (so toolbar / comments / AI can read it).
- Single-element selection (M1): tap → set.
- Marquee selection (M2): drag-on-empty → set to intersecting bbox.
- Lasso (Year-2 polish): freehand selection region; useful for picking strokes out of a dense diagram.
- **Selection transforms** (M2): bounding-box of the union of selected elements; resize handles scale all elements uniformly; rotation handle rotates around centroid.
- **Locked elements** (Year-2): `locked: true` on an element prevents selection / transform without an explicit "unlock" — useful for background templates and instructor-pinned anchors.

## A.4 Rendering pipeline

Each frame:

1. Compute viewport bbox from `{ x, y, scale }` + screen size.
2. Filter elements through R-tree spatial index → candidate set whose bbox intersects viewport.
3. Sort by `zIndex` (default to `createdAt`).
4. Render to SVG (`<g transform>` at viewport, one `<path>` / `<rect>` / etc. per element).
5. Render selection overlay (handles, comment pins, live cursors) in a separate top-layer SVG group — never re-render the element tree when only selection changes.
6. Background template renders in a `<g>` *behind* everything; cheap because it's CSS-pattern-style geometry, not per-element.

**Hard rule:** never re-render the element tree when only ephemeral state (cursor positions, selection, hover) changes. Split into stable / ephemeral SVG layers. This is the single biggest perf lever — a single missed split can drop you from 60fps to 15fps with 5 active cursors.

## A.5 Persistence & sync model

- **Today:** one Firestore doc per element, real-time subscription via `onSnapshot`. Simple, works, but writes are per-stroke and listeners fan out per-user.
- **M1 evolution:** add per-write throttling, per-board snapshot doc (every 500 writes, compact prior paths into a single doc), bbox indexing.
- **M3 evolution:** add per-board roles → rules need to check both workspace and board roles.
- **M4 evolution:** ephemeral state (cursors, reactions, hover) moves to a **side channel** (Ably / Liveblocks free tier, or Firebase Realtime Database) so the cost-bearing `paths` subcollection doesn't get hammered with cursor jitter.
- **Year-2 evolution:** investigate **CRDTs (Yjs)** for the canvas element layer. Yjs is well-suited to free-form whiteboard state, has React bindings, and provides true offline-first conflict resolution. But it adds operational complexity (needs a sync server — y-websocket or Liveblocks) — defer until concurrent-edit conflicts are actually biting users.

**Conflict policy v1 (M1–M6):** last-write-wins per element field. Two users editing the same text element will see flicker. Acceptable for v1; document the limitation.

## A.6 Performance budgets

These are the targets the canvas must hit on the M1 Android baseline device. They are the regression gates for every later canvas change.

| Metric | Target | Reason |
|---|---|---|
| Time-to-first-paint, board with 500 strokes | ≤ 1.5s | "Open and start working" feel |
| Dropped frames during 30s continuous draw | ≤ 5% | Strokes feel smooth, not laggy |
| Time-to-paint after pan/zoom | ≤ 1 frame (16ms) | Pan should never stutter |
| Firestore writes / second during sustained draw | ≤ 10 | Cost control |
| Listener count per active user | ≤ 5 | (paths, notes, text, presence, cursors) |
| Memory footprint (RN heap, 1000-element board) | ≤ 100MB | Keeps low-end Android viable |
| JS thread responsiveness (worst-case input → render) | ≤ 100ms | UI never feels frozen |

## A.7 Drawing-tool catalog (target state by end of M6)

- Pen (default, smooth)
- Eraser (real deletion, M1)
- Highlighter (semi-transparent, wide, multiply blend — M5)
- Marker (thicker, harder edges — M5)
- Calligraphy pen (width responds to direction — M5)
- Pressure-aware pen (Apple Pencil / S-Pen — Year-2)
- Shape primitives: rectangle, ellipse, line, arrow, triangle (M2)
- Text (exists, polish M2)
- Sticky note (exists, polish M5)
- Image (M2)
- Eyedropper (M5)
- Snap-to-grid toggle (M2)
- Smart guides (M2)
- Math equation (M5)
- Code block (M5)
- Connector / smart-line (M4 stretch)
- Frame / section (Year-2 — Miro-style group container)
- Table (Year-2)
- Voice-note attachment (M5)
- Poll / quiz widget (M6)
- Flashcard-deck widget (M6)

---

# Appendix B — AI Feature Roadmap Deep Dive

AI is the wedge that separates B.O.A.R.D from Excalidraw and the cross-platform mobile angle is the wedge that separates it from Miro. Underbuild AI and the product is a me-too.

## B.1 Architecture: server-side, always

**All AI calls go through Cloud Functions, not the client.** The client never holds an OpenAI / Anthropic / Google API key. This was a hard blocker noted in the M0 audit; the M4 work moves it server-side. Beyond security, it lets you:

- Centrally rate-limit per workspace.
- Swap models without shipping a client update.
- Cache responses (especially embeddings) without exposing the cache key.
- Bill per-AI-call when needed.

## B.2 Tier 0 — Already in the codebase

- **Session summary** (text + optional vision) — exists today, client-side key, GPT-3.5 / gpt-4o-mini.
- **M4 work:** move to Cloud Function, add structured-output prompting (return JSON with `tldr`, `actionItems[]`, `openQuestions[]`, `decisions[]`), benchmark cost vs quality.

## B.3 Tier 1 — Ships in M4

| Feature | Model | Avg cost / call | Notes |
|---|---|---|---|
| Shape recognition | Client-side (no model) | $0 | Pure geometry; gpt-4o-mini fallback for ambiguous cases |
| Handwriting OCR | gpt-4o-mini vision *or* Google Cloud Vision | $0.001–0.01 | Cloud Vision is cheaper per call but less context-aware; default to Cloud Vision, escalate to gpt-4o-mini if confidence low |
| "Explain selection" | gpt-4o-mini | $0.002–0.01 | Output capped at ~200 tokens; structured "concept / explanation / example" sections |
| Text → diagram | gpt-4o-mini | $0.005–0.02 | Mermaid output; B.O.A.R.D parses and converts to native elements |

Quality targets:
- OCR: 95%+ accuracy on typed-text-equivalent handwriting at "normal" size. Anything below 80% suggests retrying with a vision-tuned prompt.
- Shape recognition: 90%+ on the four primitives (rect/ellipse/triangle/arrow). False-positive better than false-negative — user can always reject.
- Text → diagram: subjective. Validate by asking 5 users whether the output is "useful as a starting point" — yes/no.

## B.4 Tier 2 — Ships in M5–M6

| Feature | Model | When |
|---|---|---|
| Voice-note transcription | Whisper API | M6 (alongside board Q&A) |
| Flashcard generation | gpt-4o-mini | M6 |
| Board Q&A (RAG) | text-embedding-3-small + gpt-4o-mini | M6 |
| Improved session summary (vision + transcript fusion) | gpt-4o + Whisper | M6 |

**Board Q&A architecture (M6):**

- Index: each element gets an embedding on create/update via Cloud Function trigger. Stored in a `boards/{id}/embeddings/{elementId}` doc.
- Retrieval: query embedding → top-K cosine-similar element embeddings → fetch their full content.
- Generation: gpt-4o-mini with retrieved context + question.
- Caching: chat threads stored per board; multi-turn supported within a thread.

## B.5 Tier 3 — Year-2 backlog

- Personalized study suggestions ("you've been weak on derivative rules — practice these").
- Generative diagram art (turn rough sketch + prompt into polished illustration).
- Multi-modal tutoring (the AI watches you work and offers Socratic hints).
- Cross-board plagiarism similarity check (instructor view).
- Auto-curriculum generation from a syllabus PDF.
- Voice-driven canvas commands ("draw a flowchart for X").

## B.6 Cost / quota model

Free tier: 5 AI calls / month across the whole workspace.
Pro tier: 100 calls / month soft-capped, then $0.05 per overage call.
Edu tier: 50 calls / student / month, with workspace-level usage dashboard for instructors.

Per-call cost budget: aim for $0.02 average across all AI features (Tier 0–2). Anything above $0.05 should be Pro-only.

## B.7 Failure modes & mitigations

| Failure | Mitigation |
|---|---|
| Model returns hallucinated content (esp. board Q&A) | Always cite source element IDs in the answer; user can click to verify |
| OCR misreads handwriting | Confidence threshold; below 70%, show "low-confidence" badge and ask user to confirm |
| Diagram generation produces nonsense | Mermaid syntax validation step; on parse failure, retry once with stricter prompt |
| Cost spike | Hard daily caps in OpenAI / Google dashboards; per-workspace soft caps in Firestore |
| Model deprecated | Adapter pattern in `src/server/ai/` — model name is one config change |
| OpenAI / Google outage | Fail gracefully, queue the request, retry with exponential backoff, surface "AI is degraded" banner |

---

# Appendix C — Collaboration Features Catalog

Everything that makes the product feel "alive" with multiple people on it. The drawing tools are the substrate; these features are the social layer.

## C.1 Presence + identity

- **Active member avatars** in the board header (exists, polish in M3).
- **Live cursors** with name + color + tool icon (M4).
- **"Active now" / "Active Xm ago"** indicators (exists).
- **User profile cards** on cursor-hover or avatar-click — name, role, recent activity (M3).
- **Per-user color** assigned at workspace-join; consistent across boards, comments, cursors.
- **Status emoji** ("📚 studying", "🍵 break", "🤝 open to help") — Year-2 polish, free.

## C.2 Reactions + ephemeral signals

- **Reactions on elements** (👍 ❤️ ❓ ⭐ 💡) — M6.
- **Reaction broadcast** — tap an emoji that floats from your cursor and fades over 2s. FigJam-style. Costs nothing, adds a ton of liveness. Year-2 polish.
- **Cursor chat** — press `/` and type, your message appears next to your cursor for 5 seconds. Year-2 polish but very high "wow" per LOC.
- **Laser pointer** (M5 — covered in plan).
- **Spotlight** — host points at a region, everyone's viewport briefly pulses there. M5 stretch.

## C.3 Comments + async discussion

- **Anchored comments** on elements with threaded replies + resolve (M3).
- **@mentions** with notification routing (M3).
- **Comment statuses:** open, resolved, archived.
- **Comment filters:** unread, mentions, mine, resolved.
- **Inline replies in notifications:** reply to a board comment directly from the in-app notification (Year-2).
- **Comment-only mode:** workspace `viewer` role gets read + comment but no edit (M3).
- **Voice comments** (audio attachment to a comment thread) — Year-2.

## C.4 Permissions + sharing

- **Workspace roles:** owner, admin, member, viewer (M3).
- **Per-board roles:** editor, commenter, viewer (M3).
- **Share by link:** anyone with link can view (or comment, or edit) — token-scoped, expirable (M3 polish).
- **Public read-only embed:** signed URL, no auth, for blog / docs embeds (M4).
- **Per-element locking** — lock an element so non-host can't move/delete it (Year-2).
- **Per-element ownership** — text owned by author, only author + admin can delete (partially exists; codify in M3).

## C.5 Notifications

- **In-app notification feed** — bell icon, unread badge (M3).
- **Push notifications:** session reminders (exists, polish M2), @mention, comment reply (M3), session ended with AI summary ready (M4).
- **Email digest** — daily summary of activity in your workspaces (M3, opt-in).
- **Notification preferences:** per-event-type toggle, quiet hours, do-not-disturb.

## C.6 Activity awareness

- **Workspace activity feed** (M3) — what changed in the last 24h.
- **Per-board history sidebar** — list of recent changes with avatar + delta.
- **Version history / scrub-through-time** (M5 polish, built on M1 snapshots) — drag a timeline slider, board renders as it looked at any point in the past.
- **Restore a previous version** (Year-2).

## C.7 Multi-board organization (workspace UX)

- **Pinned boards** (M3).
- **Folders / tags** for boards within a workspace — Year-2.
- **Search** across boards in a workspace (text content + comments + AI-indexed) — Year-2.
- **Favorite / star** boards (M3).
- **Archive** boards (M3).

---

# Appendix D — Mobile-Native Capabilities Catalog

Mobile parity is non-negotiable per the cross-cutting constraints. This appendix is the catalog of *mobile-specific* affordances that go beyond "the web app works on a phone." Some land in the 6-month plan; many are Year-2 polish that nonetheless need to be designed for now.

## D.1 Stylus support

- **Apple Pencil pressure** → stroke width modulation. Implementable via `PencilKit` bridge or `react-native-skia` if the canvas migrates off SVG. Year-2.
- **Apple Pencil tilt** → calligraphy-pen variant (width responds to tilt angle). Year-2.
- **Double-tap on Pencil** → switch between pen and eraser (system gesture). Year-2.
- **S-Pen pressure** (Samsung) → same model as Apple Pencil. Year-2.
- **Palm rejection** — when a pencil is detected, ignore touch input from fingers. Critical for tablet usability. Year-2.
- **Hover** (Apple Pencil + iPad Pro M2 / Galaxy Tab S9+) → tool preview before stroke. Year-2 polish.

## D.2 Native gestures

- **Two-finger pan + pinch zoom** — M1.
- **Three-finger swipe undo / four-finger redo** (iPad system gesture) — M1 cheap win.
- **Long-press for context menu** on any element — M2.
- **Drag-and-drop from system into B.O.A.R.D** — drag an image from Photos onto the canvas. iPadOS supports this natively for any drop target. M2.
- **Drag-and-drop from B.O.A.R.D out** — drag an element onto a Mail compose or Notes. iPadOS supports it. Year-2.

## D.3 Capture surfaces

- **iOS / Android share-sheet receiver** — M2 (in plan).
- **Mobile camera capture / document scanner** — M6 (in plan).
- **Screenshot capture button** — full-board or selected-region export as PNG to Photos. M5 polish.
- **Audio recording** for voice notes — M5 (in plan).
- **AR / camera overlay drawing** — Year-2 stretch (e.g., "annotate the real world").

## D.4 Home-screen + lock-screen presence

- **iOS home-screen widget** — "today's session" card with one-tap join. Year-2.
- **Android home-screen widget** — same. Year-2.
- **iOS Live Activities / Dynamic Island** — while a session is active, show it in the Dynamic Island with elapsed time and a tap-to-join target. Year-2.
- **Lock screen widget** (iOS 16+ / iOS 17) — countdown to next session. Year-2.
- **Quick action shortcut** (3D Touch / long-press app icon) — "New board," "Join with code," "Today's session." M6 polish.

## D.5 Background + lifecycle

- **Background save** — drawing during a phone call or app switch persists when you return. Verify M1.
- **Lock-screen passcode for the app** — Year-2; useful for shared family iPads.
- **Auto-lock workspace** — admin can require re-auth after N minutes of background. Year-2.

## D.6 Offline + sync

- **First-class offline** — read & draw on a board while offline; writes queue and flush on reconnect (M1).
- **Per-board offline pinning** — explicitly mark boards for offline availability; others lazy-load. Year-2.
- **Conflict UI** — if offline edits collide with someone else's online edits, show a "merge / discard / keep mine" choice on reconnect. Year-2 stretch.

## D.7 Mobile-only UX patterns

- **Floating action button (FAB)** — quick-tool switcher on phone; collapses toolbar to a single tappable affordance. M2 polish.
- **Bottom sheet for property editing** — selecting an element shows its properties in a swipe-up bottom sheet, not a desktop-style right rail. M2.
- **Compact toolbar** auto-collapses on small screens; tap to expand. M2.
- **Mini-map** in the corner of the board on tablet sizes (≥ 768px width) — M5 polish.

---

# Appendix E — Education / Study-Group Vertical Catalog

The recommended pivot is classroom / study-group collaboration. This appendix is the catalog of vertical-specific features and content that make the wedge real.

## E.1 Student-side features

- **Pomodoro timer** built into the session header — 25-min focus blocks + 5-min breaks (M5 polish).
- **Study streak / gamification** — daily streaks for completing sessions, weekly minutes-studied stat (Year-2).
- **Focus mode** — hide social UI (presence, reactions, comments) while studying alone (M5 polish).
- **Calendar sync** — connect Google Calendar / Apple Calendar; sessions appear on the user's calendar (M5 stretch).
- **Recurring sessions** — "every Monday 7pm" with auto-created session docs (M5 stretch).
- **Group goal tracker** — workspace-level progress bars ("we're 60% through the syllabus") — Year-2.
- **"Who's free now?"** availability matrix across friends/workspace members (Year-2).
- **Quiet hours / DND** — no notifications between user-set times (M5).

## E.2 Instructor-side features

- **Class roster import** — CSV upload, manual entry, or LTI roster sync (M6).
- **Cohort views** — see all student boards for an assignment in one grid (M6).
- **Anonymous student boards** — students submit without their name visible to peers (Year-2; sensitive).
- **Grading overlay** — teacher marks up a student board with a different-color pen + rubric checklist (Year-2).
- **Submission inbox** — assignments due → list of submitted boards → bulk grade (Year-2).
- **Office-hours queue** — students join a queue, instructor pulls one at a time into a 1:1 board (Year-2).
- **Plagiarism / similarity check** across student boards (Year-2; sensitive — gate carefully).
- **Live polls / quick checks** during a lecture (M6).
- **Q&A box** — students drop questions on a board; instructor answers asynchronously (M6 via comments).
- **Hand-raise** — student presses raise-hand; instructor sees ordered list (Year-2; integrates with presenter mode).

## E.3 Content & templates

- **Cornell notes layout** — pre-divided regions: cues / notes / summary (M6).
- **Mind-map** — central node + radial branches, drag to expand (M6).
- **Flashcard deck** template + study UI (M6 — in plan).
- **Lab report** — title, hypothesis, procedure, results, conclusion zones (M6).
- **Code review canvas** (M6).
- **Sequence-diagram canvas** (M6).
- **Coordinate plane** template — math axes with snap-to-grid (M6, also a background option).
- **Periodic table reference card** (Year-2).
- **Music staff** template (Year-2).
- **Citation generator** — drop a DOI or URL, get a formatted citation (APA/MLA/Chicago) as a text element. Year-2.
- **Math symbol palette** — quick-insert common math glyphs without LaTeX (M5 alongside KaTeX).

## E.4 Compliance + safety

- **FERPA awareness** — US student-data privacy law. Required if selling to K-12 / universities. M6 due-diligence; full compliance is a Year-2 lift (encrypt at rest, data-residency, audit logs).
- **COPPA** — if any user under 13, you need parental-consent flows. Default policy: **B.O.A.R.D is 13+** until COPPA compliance lands (Year-2). State this in the ToS.
- **Content moderation** — instructor can soft-delete student submissions; report-abuse path on every public board. M6 baseline.
- **Anonymous reporting** — student can flag a board for instructor review without revealing their identity. Year-2.

## E.5 Pricing for education

- **Free** — students; 1 workspace, light quotas (already in plan).
- **Pro for individual students** — $4-5/mo for unlimited (already in plan).
- **Edu — per-instructor or per-seat** — pricing TBD; aim for $1-3 per student per month, sold to the instructor / department, **not** student-pays.
- **Institutional** — site license for a department or campus; manual sales, Year-2.

## E.6 Go-to-market for education

- **Free for instructors who bring their class.** Best growth lever; the instructor brings 30-50 students with one signup.
- **University CS Discord seeding** — your own institution is the beachhead.
- **r/professors and r/teachers** — where instructors actually ask "what tool should I use for X."
- **EdSurge / EdTech Hub** content placements (Year-2).
- **Conference presence** — SIGCSE (CS education), ISTE (general edtech). Year-2.

---

# Appendix F — Feature Backlog (M7–M12 and beyond)

Things that intentionally do *not* fit in 6 months but are worth tracking. Each entry is a one-line hook; flesh out when its time comes.

## F.1 Canvas / drawing

- Apple Pencil pressure + tilt + double-tap-to-switch-tool
- S-Pen support on Samsung tablets
- Palm rejection
- Skia-based renderer (replaces SVG for native — fixes the perf ceiling at ~5000 elements)
- Frames / sections (Miro-style group containers)
- Connectors that auto-route around shapes (orthogonal pathfinding)
- Tables (resizable rows/cols, cell editing)
- Lasso selection
- Per-element locking
- Element layers / z-order management UI
- Crop tool for images
- Color-bucket fill for closed shapes
- Vector pen (curves with Bezier handles)
- Drawing rulers + protractor + measurement
- Mini-map navigator
- Bookmarks / saved viewport positions
- Section / region naming with auto-table-of-contents
- Markdown rendering in text elements with full formatting toolbar
- Spell-check on text elements
- Element animations (fade-in, pulse — for presentations)
- Per-element link (click to navigate to another board or URL)

## F.2 Collaboration

- Cursor chat (FigJam-style)
- Reaction broadcasts (floating emoji from cursor)
- Voice rooms in-board (Daily.co / LiveKit integration if not relying on Zoom)
- Approvals / sign-offs on a board state
- Inline reply to comments from notifications
- Per-element ownership rules
- Status emoji per user
- "Who's working on what" awareness panel
- Shared clipboard across workspace members
- Spectator mode (read-only with no presence indicator)

## F.3 AI / ML

- Personalized study suggestions
- Generative diagram art (text → polished illustration)
- Multi-modal tutoring (Socratic hint engine)
- Cross-board similarity / plagiarism check
- Auto-curriculum generation from a syllabus PDF
- Voice-driven canvas commands
- Real-time meeting transcription with speaker diarization
- Translation of text elements
- Smart layout / auto-arrange selection
- Auto-tagging of board content (concept extraction)
- AI-suggested templates ("based on this content, try the Cornell notes template")

## F.4 Mobile-native

- iOS home-screen widget + Live Activity
- Android home-screen widget + glance API
- Lock-screen quick actions
- iOS Today extension
- Apple Watch companion (start session, see attendees)
- Wear OS companion
- iPad multi-window support
- Stage Manager / Split View tuning
- Background drawing (continue stroke during multitasking)
- AR drawing overlay

## F.5 Education vertical

- Anonymous student submissions
- Grading rubric overlay
- Submission inbox + bulk grade
- Office-hours queue
- Cohort analytics for instructors
- Plagiarism / similarity check
- LTI 1.3 deep linking + grade passback
- Canvas / Blackboard / Moodle / Schoology integrations
- Google Classroom integration
- Microsoft Teams for Education integration
- Hand-raise + ordered queue
- Breakout rooms (sub-board spawning during a session)
- Class participation analytics
- Recurring weekly study schedule generator

## F.6 Enterprise + team

- SSO (Google Workspace, Microsoft 365 / Entra ID, Okta, generic SAML)
- SCIM provisioning
- Audit logs (Year-2 for FERPA compliance also)
- Custom branding (logo, colors)
- Custom domain (`board.acme.edu`)
- Data residency (EU / US choice)
- Role-based access control beyond editor/commenter/viewer
- Org admin dashboard with usage analytics
- DLP / sensitivity classification on boards
- API tokens + webhooks for org-level automation
- BAA (HIPAA) for medical-education customers

## F.7 Data / power user

- Public REST API for boards (CRUD, search, export)
- Webhooks (board-created, session-ended, AI-summary-ready)
- Zapier / Make integration
- IFTTT triggers
- Export to Miro / FigJam / Excalidraw JSON (one-way conversion)
- Import from Excalidraw JSON (pull users away)
- Import from PDF (with AI element extraction)
- Programmatic templating (generate boards from a script)
- Embed analytics for blog/docs embeds

## F.8 Performance & scale

- CRDT (Yjs) for canvas state with y-websocket / Liveblocks sync
- WebSocket primary, Firestore as durable backup
- Per-board sharding for very large workspaces
- CDN-fronted board snapshot delivery
- Service Worker pre-caching of recent boards
- Skia-based native renderer
- Element bbox quad-tree (replaces R-tree at 10k+ elements)
- Differential sync for snapshot updates

## F.9 Accessibility

- Full screen reader support (VoiceOver / TalkBack)
- High-contrast mode
- Color-blind-safe default palette
- Keyboard-only navigation for all canvas operations
- Adjustable text scaling that respects system settings
- Voice control for tool switches
- Captions for voice notes
- Alt-text on image elements

## F.10 Trust & safety

- Account deletion (GDPR right to erasure)
- Data export (GDPR right to portability)
- Report-abuse workflow with moderator queue
- Cross-board content scan for abuse signals
- IP allow-listing for institutional accounts
- 2FA / TOTP
- Passkey / WebAuthn login
- Anomaly detection (logins from new geography, mass-export)

---

*End of roadmap. Print it, file it, revisit at the end of every month. The plan changes; the discipline of having one doesn't.*
