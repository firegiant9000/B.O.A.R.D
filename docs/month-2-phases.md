# Month 2 — Production Readiness + Auth Polish: Phased Implementation Plan

> **Status:** Planning. Branch `feature/month-2-production-readiness` cut from
> `main` (post-PR-#89). No prior M2 branches or PRs exist.
> **Roadmap source:** ROADMAP.md → Month 2 (scope items 1–12).
> **Carry-forward folded in:** M1 §1 (real Sentry SDK), M1 §2 (selection
> unification on text), M1 §3 (Android perf baseline numbers).

**Goal (from roadmap):** Make the app installable from the actual app stores
(or as a real PWA) by anyone — not just Expo Go users — and bring auth, secrets,
and the core canvas tool set up to a shippable bar.

---

## Investigation: current state by layer

What exists today (verified against the tree on this branch):

- **Build / distribution:** No `eas.json`, no `app.config`-level env wiring.
  `app.json` only. Push notifications work in Expo Go only (roadmap weakness).
- **Auth:** `authService.ts` exposes only `signUp` / `signIn` / `signOut`.
  No password reset, no Google provider, no email-verification surface.
- **Secrets:** Firebase config is **hardcoded** in `src/config/firebase.ts`
  (`apiKey: "AIzaSy…"`). Invite/join codes use `Math.random()` in
  `boardService.ts:39` and `sessionService.ts:25`.
- **Web/PWA:** No `manifest.json`, no service worker, no install prompt.
- **Deep links:** No Universal Links / App Links, no documented URI scheme.
- **Canvas element schema** (`src/types/index.ts`): `DrawPath`, `TextNote`,
  `TextElement`, plus snapshot types. **No `shape` or `image` element types.**
- **Selection:** `useSelection` slice exists (M1) for paths; text keeps its
  bespoke `selectedTextId` path (M1 carry-forward §2). No multi-select, no
  group transforms, no spatial index.
- **Error reporting:** `errorReporting.ts` is a console-only seam; the real
  `@sentry/react-native` SDK is not installed (M1 carry-forward §1).

## Required changes by layer

- **Data model:** add `shape` and `image` element types to `src/types/index.ts`
  + Firestore docs (`bbox` already convention from M1); Firebase **Storage**
  for image originals/thumbnails (and later paste uploads).
- **Services:** `authService` gains reset/verify/Google; `boardService` /
  `sessionService` swap to crypto codes; new `imageService` (upload/downscale);
  `notificationService` updated for EAS-issued FCM/APNs tokens.
- **Native config:** `eas.json`, iOS associated domains + Share Extension,
  Android intent filters + App Links, FCM/APNs credentials, Sentry native SDK.
- **Web:** PWA manifest + service worker + install prompt; Lighthouse pass.
- **Canvas/UI:** shape tools, marquee/group transforms (rbush), clipboard,
  keyboard shortcuts, background-template render layer, image elements.

## Risks and mitigations (M2-specific)

- **Google Sign-In on Expo has historical pain.** Roadmap budgets 3 days; if
  blocked, defer to M3. Isolate behind a provider adapter so deferral is clean.
- **iOS review may stall on generated content.** AI is deliberately held off the
  production track until M4 — keep it out of the M2 build.
- **Store-credential setup (APNs/FCM) is fiddly and serial.** It gates push
  testing; start the Apple Developer Program enrollment ($99/yr) on day one.
- **New dependencies need approval** (CLAUDE.md). See the list at the bottom —
  do not add them silently.
- **Mobile-parity gate still in force** (M1 cross-cutting): every canvas-touching
  phase (7–12) needs a real-Android measurement/screenshot in its PR, measured
  against `docs/perf-baseline.md`.

## Test plan

- Service-layer unit tests extended for new `authService` / `imageService` /
  crypto-code paths (keep the 60% global gate green).
- Manual store/device verification per the roadmap's Verification block
  (`.aab` install + push, TestFlight, Lighthouse thresholds, share-sheet,
  Universal/App Link tap-through).
- Canvas phases add geometry unit tests (shape bbox, hit-test, snap/guide math,
  RDP unaffected) + on-device perf check.

---

## Phased plan

Two tracks run through M2: a **distribution/auth track** (Phases 1–6) and a
**canvas-expansion track** (Phases 7–12). They are largely independent, so the
canvas track can proceed in parallel by a second contributor. Within each track
the order is dependency-driven. Recommended single-developer order is the phase
numbering below.

### Phase 1 — Secrets hygiene ✅ COMPLETE *(roadmap item 5)*
**Why first:** smallest, lowest-risk, and the env-var work is a prerequisite for
clean EAS build profiles in Phase 2.

**Shipped:**
- Firebase config moved to `expo.extra.firebase` in `app.json` (committed dev
  config), read in `firebase.ts` with `EXPO_PUBLIC_FIREBASE_*` env overrides for
  build-time production injection. `.env.example` documents the prod vars.
  Throws early if config is absent.
- New `src/lib/secureRandom.ts` (`randomCode`, rejection-sampled, no modulo bias).
  `boardService` / `sessionService` code generators now route through it.
- **Cross-platform RNG gap closed:** Web Crypto (`crypto.getRandomValues`) is
  used on web/Node/Jest; **`expo-crypto.getRandomBytes`** on React Native, since
  Hermes has no global Web Crypto. A `Math.random` last-resort fallback reports
  once if neither is available. (Added dependency: `expo-crypto ~55.0.15` — the
  one new dep this phase, approved.)
- **Verified:** `tsc --noEmit` clean; full suite 17/17 (147 tests, incl. new
  `secureRandom.test.ts`); coverage holds above the 60% gate.
- **Depends on:** nothing. **Unblocks:** Phase 2.

### Phase 2 — EAS Build + real Sentry SDK *(roadmap item 1; M1 carry-forward §1)*
**Why here:** every store/native capability downstream (push, links, share
extension) needs signed native builds and EAS credentials.
- Configure `eas.json` (preview + production profiles). Document build commands
  in README.
- Generate signed Android `.aab` → Google Play internal testing track.
  TestFlight build for iOS (requires Apple Developer Program — enroll now).
- **Fold in M1 carry-forward §1:** swap `errorReporting.ts` from the console seam
  to `@sentry/react-native` + DSN now that a native build exists. This finally
  closes the **unmet M1 exit criterion** (dogfood exception in Sentry) — re-meet
  it here (issue #3).
- **Verify:** `.aab` installs on a real Android outside Expo Go; TestFlight
  install works; a deliberately-thrown dogfood exception appears in the Sentry
  dashboard.
- **Depends on:** Phase 1. **Unblocks:** Phases 3, 4.

### Phase 3 — Push notifications outside Expo Go *(roadmap item 2)*
- Wire FCM (Android) + APNs (iOS) tokens via EAS credentials.
- Update `notificationService` to use the Expo Push API with EAS-issued tokens.
- **Verify:** a session notification fires on at least one standalone iOS and one
  standalone Android device.
- **Depends on:** Phase 2.

### Phase 4 — Deep-link schema + Universal/App Links + share sheet *(roadmap item 6)*
**Why grouped:** all three are native-config + a shared URI contract; the schema
must be locked here because every Phase 2/3 integration leans on it.
- **Lock the deep-link schema:** `boardapp://board/{id}?session={id}` — document
  it in README; it is a stable contract.
- Universal Links (iOS associated domains) + App Links (Android intent filters):
  `https://<domain>/b/<inviteCode>` opens the installed app, else falls through
  to web.
- iOS Share Extension + Android share intent: share an image/PDF/link from any
  app into B.O.A.R.D, landing as a placed element on a chosen or fresh board
  (`expo-sharing` / `expo-intent-launcher`). Placement reuses the Phase 9 image
  pipeline where the shared item is an image.
- **Verify:** tap a `https://<domain>/b/<inviteCode>` link from a chat app on iOS
  and Android → opens native app, joins board. Share a PNG from Photos → lands on
  a board (both platforms).
- **Depends on:** Phase 2 (native build); image-placement path coordinates with
  Phase 9.

### Phase 5 — Web as a real PWA ✅ COMPLETE *(roadmap item 3)*
**Why parallelizable:** pure web track, no native dependency.

**Shipped:**
- `public/manifest.json` (standalone display, theme `#2563eb`, app icon as
  `any` + `maskable`), linked from the new `app/+html.tsx` web document head.
- Hand-rolled `public/sw.js` service worker — **zero new deps** (no Workbox /
  metro SW plugin, so no CLAUDE.md approval gate). Network-first for navigations
  + the JS bundle, cache-first for `/icons/*`, offline shell fallback; versioned
  by `CACHE_VERSION`. Registered from `+html.tsx` after `load`.
- `src/components/PWAInstallPrompt.tsx` — web-only `beforeinstallprompt` banner,
  mounted in `app/_layout.tsx`; renders `null` on native and on iOS Safari
  (which installs via Share → Add to Home Screen, covered by the apple-* meta).
- **Output-mode fix:** `+html.tsx` is ignored under the default SPA `"single"`
  output, so set `expo.web.output: "static"` in `app.json`. This prerenders each
  route's HTML shell (helps the Lighthouse perf score) and applies the custom
  head. All routes export cleanly — confirms the `_layout` top-level side effects
  are render-safe in Node.
- README gains a "Progressive Web App (PWA)" section + verify commands.
- **Verified:** `tsc --noEmit` clean; full suite 19/19 (176 tests); `expo export
  -p web` succeeds with all routes prerendered and manifest/SW/icons/.well-known
  in the build output. **Outstanding (manual, needs a browser):** run
  `lighthouse` against the served build to confirm **> 80 perf / > 90 a11y** and
  exercise the install prompt — automated tooling can't clear those here.
- **Depends on:** Phase 1 (env config). Independent of the native phases.

### Phase 6 — Auth UX cleanup ✅ RESET + VERIFY SHIPPED (Google deferred to M3) *(roadmap item 4)*
**Decision:** Google Sign-In is **deferred to M3** per the documented fallback —
it needs the `expo-auth-session` / `expo-web-browser` deps (pending approval) and
the native OAuth redirect config from Phase 2 (not yet complete), and can't be
verified without a native build. Reset + verify shipped now; both are dep-free
and have no Phase 2 dependency.

**Shipped:**
- **Password reset:** `authService.sendPasswordReset` (`sendPasswordResetEmail`).
  New `app/(auth)/forgot-password.tsx`, linked from the login screen via a
  "Forgot password?" link. Confirmation is shown regardless of whether the email
  is registered (no account-enumeration leak).
- **Email verification:** `sendEmailVerification` fires at signup (non-fatal on
  failure, resendable). `authService.sendVerificationEmail` / `reloadUser`;
  `AuthContext` now surfaces `emailVerified` + `resendVerification` / `reloadUser`
  (reload pushes the fresh flag into state since `onAuthStateChanged` doesn't
  re-fire on `reload`). New `UnverifiedEmailBanner` mounted above the tabs with
  Resend / "I've verified" actions; app stays usable while unverified. Register
  screen shows a post-signup "verify your email" notice.
- **Google seam:** `src/services/authProviders.ts` — stable `SocialAuthProvider`
  interface; `getProvider("google").isAvailable === false` until M3. No deps
  added, no OAuth wired — the implementation drops in behind the seam.
- **Verified:** `tsc --noEmit` clean; full suite 19/19 (182 tests, +6 new
  `authService` cases); coverage 85.6% global (`authService.ts` 100%), holds
  above the 60% gate. **Outstanding (manual, needs a device/build):** reset email
  round-trip and verification tap-through on a real account.

- **Deferred to M3:** Google Sign-In via `expo-auth-session`, behind the seam
  above. **Depends on:** Phase 2 (native redirect config).

---

### Phase 7 — Shape tools ✅ COMPLETE (interactive resize deferred to Phase 8) *(roadmap item 7)*
**Why first in the canvas track:** adds the `shape` element type that selection,
transforms, and clipboard then operate on.

**Decision:** per the Phase 7/8 seam, Phase 7 ships shape **creation + styling +
tap-select**; all interactive resize/rotate handles fold into Phase 8's transform
unification (the plan listed "start/end resize handles" here but Phase 8 owns the
8-handle + rotate + group-transform system — splitting it avoids throwaway work).

**Shipped:**
- New `ShapeElement` type (`rect | ellipse | line | arrow | triangle`) in
  `src/types/index.ts` per Appendix A.2: `x,y,width,height,rotation,fill,stroke,
  strokeWidth,dashed,arrowheadStart,arrowheadEnd` + persisted `bbox`. rect/ellipse/
  triangle store a normalized box; line/arrow store a signed start→end vector.
- `src/services/shapeService.ts` — `shapes` subcollection CRUD + ordered realtime
  subscription, mirroring the `textElements` pattern. bbox computed at write,
  recomputed on read for legacy/partial docs.
- `src/lib/shapes.ts` — pure board-space geometry: `shapeBbox` (rotation-aware,
  stroke/arrowhead inflation), `snapValue`/`snapPoint`, `constrainDraft`
  (square / 45°), `computeGuides` (edge/center alignment, 8px tol), `trianglePoints`,
  `arrowheadPoints`, `hexToRgba`. **Fully unit-tested** (`shapes.test.ts`, +18 cases).
- Rendering in the SVG element tree (`DrawingCanvas`): rect/ellipse/line/polygon
  primitives + arrowheads (classic / open / dot / circle), dashed strokes, a live
  draft preview during the creation drag, and 1px smart-guide lines.
- `ShapeOptionsBar` (contextual, mounts only with the shape tool): primitive picker,
  fill (alpha), dash, snap-to-grid cycle (off/8/16/24), arrowhead-style cycle.
  Stroke color/width reuse the main `Toolbar`; the shape tool joins it as a 5th tool.
- Board wiring: drag-to-create (snap + shift-constrain + smart-guide nudge),
  shapes participate in tap-select (bbox/segment hit-test), the `SelectionOverlay`,
  viewport culling, fit-to-content, recolor-on-select, clear-board, and
  Delete/Backspace removal.
- **Verified:** `tsc --noEmit` clean; full suite 20/20 (200 tests); coverage gate
  green. **Outstanding (mobile-parity gate, needs a device):** draw each primitive
  → persist → refresh on real Android + the on-device perf check vs
  `docs/perf-baseline.md`, plus a screenshot in the PR.
- **Depends on:** M1 coordinate model (done). **No new deps.**

### Phase 8 — Selection unification + multi-select + group transforms ✅ COMPLETE (shipped in two passes) *(roadmap item 8; M1 carry-forward §2)*
**Decision (Phase 7/8 seam, continued):** the heaviest, highest-regression slice —
the interactive **8 resize handles + rotate handle** and the scale/rotate math
for freehand point-arrays — was split into a **Pass 2**. Pass 1 shipped the full
selection model + every group op that doesn't need a transform handle, so it was a
small, reviewable change set that the resize work then built on.

**Shipped (Pass 2):**
- **8 resize handles + rotate handle** on `SelectionOverlay`, each a `PanResponder`
  reporting board-space deltas (screen px ÷ zoom). Corner handles scale **uniformly**
  by default, **non-uniform with Alt** (web); edge handles scale one axis; the rotate
  handle (with stem) spins the group about its center.
- **Transform math** (`src/lib/transform.ts`, unit-tested): `scalePointAbout`,
  `rotatePointAbout`, `scaleBoundsAbout`, and SVG `resizeMatrix` / `rotateMatrix`
  builders. Each handle drag is one similarity transform recomputed from the
  pre-drag snapshot every frame (no accumulation drift), clamped to a positive
  minimum scale (no flipping this pass).
- **Applied to every element kind on commit:** paths rotate/scale each point
  (bbox recomputed); box shapes orbit their center + accumulate `rotation`;
  line/arrow rotate the start point + vector (no rotation field); text scales
  position/size/fontSize and gains a new migration-tolerant **`rotation`** field,
  rendered via a `transformOrigin: center` rotate in `TextElementView`.
- **Live preview** is a single SVG transform string on the selected elements
  (`translate` for the Pass-1 move, `matrix` for resize/rotate) plus an equivalent
  derived preview for text + the overlay box, so the whole group tracks together;
  geometry is baked + batch-persisted only on release. **Known limit:** non-uniform
  resize of an *already-rotated* shape is approximate (scales in unrotated axes);
  uniform scale + rotation are exact for all kinds.
- **Verified:** `tsc --noEmit` clean; full suite 23/23 (**237 tests**); services
  coverage 87.7% lines, above the 60% gate. **Outstanding (mobile-parity gate):**
  on-device resize/rotate of mixed selections (incl. text) + perf check + PR
  screenshot, same as Pass 1.

**Shipped (Pass 1):**
- **M1 carry-forward §2 closed:** the bespoke `selectedTextId` state is gone;
  `useSelection` is now the single source of truth for **all** element kinds
  (paths, shapes, text). Only the inline text-edit lifecycle (`editingTextId`)
  stays local. The slice gained `setMany` / `addMany` / `remove` / `count`.
- **Multi-select:** marquee rubber-band on empty canvas (additive with Shift),
  Shift-click toggle (canvas + text), and Cmd/Ctrl-A select-all (web).
- **rbush** R-tree (`src/lib/spatialIndex.ts`) over every visible element's bbox,
  rebuilt on visible-set change, queried during the marquee drag for O(log n)
  hit-testing. (Added dep: `rbush@4` + `@types/rbush`, approved; jest's
  `transformIgnorePatterns` extended for its ESM + `quickselect`.)
- **Group ops:** move (drag the selection body; live offset via a render-time
  translate, committed in one batch per collection), delete, recolor (stroke for
  paths, stroke+fill for shapes, color for text), stroke-width, duplicate (16px
  down-right), and z-order bring-to-front / send-to-back.
- New persisted, migration-tolerant `z` field on all three element types
  (absent ⇒ 0, tiebroken by `createdAt`); visible layers now render z-sorted.
  **Known limit:** z-order is *per-layer* (paths < shapes < text render order is
  fixed) — a global render-merge is out of scope.
- New batch service helpers (`batchUpdate*` / `batchDelete*` for paths/shapes/
  text), 500-op chunked; new `src/lib/transform.ts` (translate/marquee math,
  fully unit-tested). `SelectionOverlay` now shows the group union box + a
  counter-scaled action bar (duplicate / front / back / delete).
- **Verified:** `tsc --noEmit` clean; full suite 23/23 (**230 tests**, +30 incl.
  new `transform` / `spatialIndex` / `shapeService` suites and extended
  `useSelection` / `pathService`); services coverage 87.7% lines, holds above the
  60% gate. **Outstanding (mobile-parity gate, needs a device):** marquee + group
  move/duplicate/z-order on real Android, persist + refresh, and the on-device
  perf check with thousands of elements vs `docs/perf-baseline.md` + a PR
  screenshot.
- **Followed by Pass 2 (now shipped, see below):** the 8 resize handles + rotate
  handle; uniform scale (non-uniform with Alt); scale/rotate applied to
  paths/shapes/text around the group anchor.
- **Depends on:** Phase 7 (shapes exist to select). **New dep:** `rbush`.

### Phase 9 — Image elements (first-class) ✅ COMPLETE *(roadmap item 12)*
**Why before clipboard:** clipboard image-paste (Phase 10) and the Phase 4 share
sheet both reuse this upload/placement pipeline.

**Shipped:**
- New `ImageElement` type (`src/types/index.ts`) per Appendix A.2: `storagePath,
  thumbnailPath, x, y, width, height, rotation, naturalWidth, naturalHeight, alt`
  + persisted `bbox`/`z`. **Two fields beyond the appendix —** `url` /
  `thumbnailUrl` (resolved download URLs) — are persisted alongside so the SVG
  renderer has an `href` with no async lookup per element (download URLs are
  bearer tokens, no broader than the Firestore read a member already has).
- `src/services/imageService.ts` — `images` subcollection CRUD + ordered realtime
  subscription + 500-op `batchUpdate*`/`batchDelete*`/`clearBoard*`, mirroring
  `shapeService`. `uploadImage` pushes full + thumbnail to Firebase **Storage**
  under `boards/{boardId}/images/{imageId}/` (client-generated id keys both the
  folder and the doc, so the doc is written once after the uploads resolve and
  never appears half-formed in the stream); `saveImage` duplicates by reusing the
  source's storage objects (no re-upload). bbox computed at write, recomputed on
  read for legacy/partial docs.
- `src/lib/images.ts` — pure geometry: `imageBbox` (rotation-aware AABB),
  `fitWithin` (≤ 2048px / 256px downscale math), `placementBox` (aspect-fit,
  viewport-centered). **Fully unit-tested** (`images.test.ts`).
- `src/lib/imagePicker.ts` — platform pick + prepare seam: **native** uses
  `expo-image-picker` (gallery/camera) + `expo-image-manipulator` (resize +
  JPEG-compress full + thumb, read into Blobs); **web** uses a hidden file input +
  offscreen `<canvas>` downscale (zero native modules). Returns `null` on
  cancel/permission-deny.
- Rendering in the SVG element tree (`DrawingCanvas`): images render **beneath**
  strokes/shapes/text (so annotations sit on top), rotation-aware, and
  participate in the live group-transform preview.
- Board wiring: toolbar image button (native → gallery/camera action sheet; web →
  file dialog), insert places the image aspect-fitted + centered on the current
  viewport and auto-selects it; images join tap/marquee select, the spatial
  index, viewport culling, fit-to-content, move/resize/rotate (Phase 8 handles),
  duplicate, delete, z-order, select-all, and clear-board.
- **Rules:** new `storage.rules` (board-member-gated read/write, 10 MB image-only
  upload ceiling) + new Firestore `images` rule. **Also closed a latent gap:**
  Phase 7/8 `shapes` had no Firestore rule — added here.
- **Verified:** `tsc --noEmit` clean; full suite **25/25 (256 tests**, +19 new in
  `images` / `imageService`); coverage 88.2% global, `imageService.ts` 100% lines,
  above the 60% gate. **Outstanding (manual, needs a device/build):** insert from
  gallery + camera on real iOS/Android, persist + refresh, Storage-rules
  enforcement, and the mobile-parity perf check + PR screenshot vs
  `docs/perf-baseline.md`.
- **Known limits:** group-delete / clear-board remove only the Firestore docs;
  the underlying Storage objects are left orphaned (a Cloud-Functions janitor is
  out of M2 scope). Single-`deleteImage` does clean Storage but isn't on the board
  delete path. Drag-and-drop / paste of external images on web is wired through
  the same `prepareWebFile` pipeline but lands in **Phase 10** (clipboard).
- **Depends on:** Phase 8 (selection handles); coordinates with Phase 4.
  **New deps (approved):** `expo-image-picker`, `expo-image-manipulator` (+ camera/
  photos permission config in `app.json`). Firebase **Storage** must be enabled on
  the project + `storage.rules` deployed.

### Phase 10 — Clipboard: copy / paste / duplicate ✅ COMPLETE (web-first; native OS-clipboard deferred to Phase 11) *(roadmap item 9)*
**Decision:** every *verifiable* deliverable (copy/paste within + across boards,
external screenshot paste on web) ships with **zero new deps** — the in-app store
covers cross-board, and the web `paste` event + the Phase 9 `prepareWebFile`
pipeline cover external images. `expo-clipboard` (native OS-clipboard interop) is
**deferred to Phase 11**, which owns native hardware-keyboard capture — without it
native copy/paste can't even be triggered, so it can't be verified this phase.
Cross-board image paste **reuses** the source board's Storage object (no
re-upload), matching the Phase 9 duplicate behavior (known limit below).

**Shipped:**
- New `src/lib/clipboard.ts` — a **module-level** store (survives board-to-board
  navigation, which is what "across boards in the same workspace" means, since
  each board screen remounts). Holds kind-tagged payloads with identity stripped
  (`id`/`createdAt`/`boardId`/`userId`/`bbox`); paste re-stamps the destination
  board + the pasting user and the services recompute `bbox`. Pure
  `offsetClipItem` (per-kind geometry translate) + cascading `nextPasteOffset`
  (16px → 32px → … so a run of pastes fans out). **Fully unit-tested**
  (`clipboard.test.ts`, +10 cases).
- **Copy (Cmd/Ctrl+C)** gathers the mixed selection across all four kinds.
  **Paste (Cmd/Ctrl+V)** recreates onto the *current* board via the existing
  `savePath`/`saveShape`/`saveTextElement`/`saveImage` services and selects the
  copies; images reuse the source Storage objects through `saveImage` (no
  re-upload). **Duplicate (Cmd/Ctrl+D)** binds the pre-existing 16px-offset
  `handleDuplicateSelected`.
- **Web external image paste:** a DOM `paste`-event handler (the only place
  `clipboardData` is readable) routes a clipboard image Blob through
  `prepareWebFile` → `uploadImage` → `image` element; non-image pastes fall back
  to the in-app clipboard. `insertImageFrom` + this path now share a single
  `uploadPreparedImage` (place aspect-fitted + centered on the viewport, select).
- **Verified:** `tsc --noEmit` clean; full suite **26/26 (266 tests)**; coverage
  gate green. **Outstanding (manual, needs a browser/device):** copy/paste within
  and across two boards; paste an external screenshot on web → lands as an image;
  mobile-parity perf check + PR screenshot vs `docs/perf-baseline.md`.
- **Known limit:** cross-board image paste references the *source* board's
  Storage object (renders via the persisted bearer-token download URL); deleting
  the source board orphans the pasted image — consistent with the Phase 9
  group-delete/clear-board Storage-orphan limit. Native key bindings (incl.
  Bluetooth keyboards) + `expo-clipboard` OS-clipboard interop land in Phase 11.
- **Depends on:** Phases 8 + 9. **No new deps** (`expo-clipboard` deferred to
  Phase 11).

### Phase 11 — Keyboard shortcuts ✅ COMPLETE (group/ungroup deferred) *(roadmap item 10)*
**Why late:** every tool/action it binds must already exist.

**Decision:** the reserved letter set `P E T R O L A S H N` maps cleanly to **5
tools** (P pen, E eraser, T text, S select, **H new Hand/pan tool**) + **5 shape
kinds** (R rect, O oval/ellipse, L line, A arrow, N triaNgle). **group/ungroup is
deferred** — selection is ephemeral and there is no persistent group primitive, so
`⌘/Ctrl+G` would be a dead key; true grouping is a data-model feature (`groupId` +
selection/transform changes) in its own right, out of a shortcuts phase per this
plan's own "bind actions that already exist" rationale.

**Shipped:**
- **Pure resolver** `src/lib/shortcuts.ts` — a single key-chord → action table
  (tools, shapes, undo/redo, select-all/copy/paste/duplicate, delete, deselect,
  z-order, zoom in/out/100%/fit, help) + the cheat-sheet data derived from the same
  source. **Fully unit-tested** (`shortcuts.test.ts`, +24 cases). Suppresses all
  shortcuts while editing text; modifier combos win over bare tool keys.
- **Hand tool** added to the `Tool` union + `Toolbar` (`H`). `DrawingCanvas` gains a
  `panMode` prop: a single-finger drag pans (+ fling) in screen-space instead of
  drawing. **Space-drag** is the transient web equivalent (held → temporary pan,
  released → restores the tool).
- **Unified wiring** `src/hooks/useShortcuts.ts`: web binds DOM keydown/keyup (and
  lets the browser `paste` event keep ownership of Cmd/Ctrl+V so an OS-clipboard
  image is still caught); native binds `react-native-key-command`. Both normalize
  to one `KeyChord` and route through `resolveShortcut`. Replaced the three bespoke
  per-key web `useEffect`s in `board/[id].tsx` (delete / select-all / copy /
  duplicate, and the Shift/Alt tracker) with one dispatch map.
- **`?` cheat sheet** (`ShortcutsCheatSheet.tsx`) toggled from the resolver,
  rendering the platform-correct modifier glyph (⌘ on Apple, Ctrl elsewhere).
- **Native (deps approved):** `react-native-key-command` behind a `.native`/`.web`
  `hardwareKeys` seam (web is a no-op — DOM handles it); ambient type decl in
  `types/`; `expo-clipboard` behind an `osClipboard` seam for native external-image
  paste (reuses the Phase 9 pipeline via new `prepareNativeImageUri`); Expo config
  plugin `plugins/withHardwareKeyCommands.js` injects the AppDelegate/MainActivity
  hooks during prebuild. The plugin **guards every injection** — it no-ops with a
  warning on SDK 55's Swift/Kotlin templates rather than risk breaking a prebuild;
  those need the hooks added by hand (documented in README).
- **Jest fix:** the new native dep ships a `jest` field in its `package.json` that
  hijacked test discovery; pinned with `modulePathIgnorePatterns`.
- **Verified:** `tsc --noEmit` clean; full suite **27/27 (290 tests**, +1 suite /
  +24); `expo export -p web` succeeds with all routes prerendered (confirms the web
  seam imports no native module). **Outstanding (needs a device/build):** Bluetooth-
  keyboard capture on iOS/Android (incl. the manual Swift/Kotlin hooks + on-device
  config-plugin verification), native OS-clipboard image paste, and the mobile-
  parity perf check + PR screenshot vs `docs/perf-baseline.md`.
- **Depends on:** Phases 7–10 (the actions exist). **New deps (approved):**
  `react-native-key-command`, `expo-clipboard`.

### Phase 12 — Background templates ✅ COMPLETE *(roadmap item 11)*
**Why last / parallelizable:** isolated render layer, no dependency on the other
canvas work.

**Shipped:**
- New `BackgroundTemplate` type (`blank | grid | dots | lined | isometric |
  coordinate`) + optional, migration-tolerant `Board.backgroundTemplate` in
  `src/types/index.ts` (absent ⇒ `blank`).
- `src/lib/backgrounds.ts` — pure, board-space geometry: each template is one
  repeating tile (`patternSpec`) plus `visibleBoardBounds` (viewport → visible
  board rect, padded). The isometric tile uses `height = width·tan30°` so its
  ±30° diagonals tile seamlessly across seams; the coordinate plane reuses the
  grid tile and adds emphasized x/y axes as an overlay. **Fully unit-tested**
  (`backgrounds.test.ts`, +16 cases).
- Rendering (`DrawingCanvas` → `BackgroundLayer`): a single SVG `<Pattern>`
  (Appendix A.4's "CSS-pattern-style geometry") tiled over a cover rect, mounted
  as the **first child of the viewport-transformed `<g>`** so it sits behind
  every element and scales with zoom. Stroke width / dot radius are `1/scale`
  board units, so lines stay ~1px on screen at any zoom. Non-interactive: all
  gestures are owned by the parent GestureDetector, never by SVG nodes.
- `BackgroundPicker` modal opened from a new header grid-icon button; selection
  is **optimistic local patch + persist**. Member-set value gated by a widened
  `firestore.rules` board-update allow-list (`members`/`updatedAt`/
  `backgroundTemplate`); `boardService` reads (validated) + writes the field.
- **Verified:** `tsc --noEmit` clean; full suite **28/28 (306 tests**, +1 suite /
  +16); `expo export -p web` succeeds with all routes (incl. `/board/[id]`)
  prerendered — confirms the new SVG layer is render-safe in Node.
- **Known limit:** the board doc isn't subscribed (same as title/admin), so a
  template change reaches other members on their next load, not live.
  **Outstanding (mobile-parity gate, needs a device):** each template renders +
  scales under zoom + never intercepts input on real Android, plus the on-device
  perf check vs `docs/perf-baseline.md` and a PR screenshot.
- **Depends on:** M1 coordinate model (done). **No new deps** (`Pattern`/`Defs`
  are core `react-native-svg`).

---

## Out of scope (from roadmap)
Cloud Functions. Billing. AI work. Comments (M3). Live cursors (M4). Voice notes
/ math equations / code blocks (M5).

## Exit criteria (from roadmap Month 2)
- App installable on Google Play (closed test), TestFlight, and web.
- Push confirmed delivered on ≥ 1 standalone iOS and ≥ 1 standalone Android.
- A friend can open a TestFlight link and sign in with Google.
- *(Re-met here, was open from M1):* Sentry dashboard receives a dogfood
  exception (Phase 2).

## Dependencies requiring approval (CLAUDE.md: no new deps without sign-off)
The roadmap names these; flagging for explicit approval before install:
`eas-cli` (dev), `@sentry/react-native`, `expo-sharing`, `expo-intent-launcher`,
`expo-auth-session` (Google), `rbush`, `expo-image-picker`, `expo-clipboard`,
plus a web PWA service-worker plugin (e.g. `@expo/metro-runtime` /
Workbox-based). Firebase **Storage** must also be enabled on the project (it is
budgeted in the roadmap from M2 onward).
