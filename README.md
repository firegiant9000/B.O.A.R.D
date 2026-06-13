# CollabBoard — CMPS 357 Final Project (Team 2)

A real-time collaborative whiteboard and study-session app built with React Native / Expo.

**Team:** Arlo Kharod · Scott Williams

[![Review Assignment Due Date](https://classroom.github.com/assets/deadline-readme-button-22041afd0340ce965d47ae6ef1cefeee28c7c493a6346c4f15d667ab976d596c.svg)](https://classroom.github.com/a/oHRMfboi)

---

## Features

- **Real-time drawing** — pen, eraser, stroke-width, and color picker synced across all users via Firestore
- **Text elements** — tap to place, resize via corner handles, delete (owner or admin)
- **Undo / Redo** — per-client history; redo stack cleared on new stroke
- **Sticky notes** — floating notes overlay with per-note delete (owner or admin)
- **Session scheduling** — create study sessions with title, date, time, and duration; push notifications via Expo
- **AI session summaries** — generate a GPT-3.5-based summary of board content at session end (requires OpenAI key)
- **Friend system** — add friends by email, accept/reject requests, see friend status on shared boards
- **Board sharing** — invite collaborators via 6-digit code or share link
- **User presence** — see who is currently on the board with "Active Xm ago" indicators
- **Admin controls** — board creator can clear the board, start sessions, and manage any element
- **Block user** — hide another user's drawings and notes locally

---

## Setup

### Prerequisites

- Node.js 18+
- [Expo Go](https://expo.dev/client) installed on your phone (iOS or Android), or an Android/iOS emulator

### 1. Clone and install

```bash
git clone https://github.com/School-of-Computing-and-Informatics/cmps-357-sp26-final-project-cmps357-team2.git
cd cmps-357-sp26-final-project-cmps357-team2
npm install
```

### 2. Firebase configuration

The app uses the shared team Firebase project. The config is already set in `src/config/firebase.ts` — no changes needed for graders.

To use your own Firebase project instead:

1. Go to [Firebase Console](https://console.firebase.google.com) → Create project
2. Enable **Authentication** (Email/Password provider)
3. Enable **Firestore Database** (start in test mode, then apply `firestore.rules`)
4. Enable **Storage** (Phase 9 image elements) and apply `storage.rules`:
   `firebase deploy --only storage` — board-member-gated read/write under
   `boards/{boardId}/images/{imageId}/`. Image originals are downscaled to
   ≤ 2048px client-side before upload; a 256px thumbnail is generated alongside.
5. Copy your project config into `src/config/firebase.ts`:
   ```ts
   const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "...",
   };
   ```
6. Deploy indexes: `firebase deploy --only firestore:indexes`

### 3. Run the app

```bash
npx expo start
```

- **Expo Go (phone):** scan the QR code in the terminal
- **Android emulator:** press `a`
- **iOS simulator:** press `i`
- **Web:** press `w`

### 4. Add your OpenAI API key (for AI summaries)

1. Open the app → **Profile** tab → **AI Settings**
2. Paste your `sk-...` key and tap the checkmark
3. The key persists across restarts via AsyncStorage — each user needs their own key

---

## Production builds (EAS)

Standalone store/device builds are produced with [EAS Build](https://docs.expo.dev/build/introduction/).
Two profiles are defined in `eas.json`:

| Profile | Output | Use |
|---|---|---|
| `preview` | Android APK / non-simulator iOS, `internal` distribution | Install directly on a device (outside Expo Go); TestFlight internal |
| `production` | Android `.aab` / iOS store build, auto-incrementing version | Google Play track + App Store / TestFlight |

```bash
# one-time
npm install -g eas-cli          # or use npx eas-cli ...
eas login

# builds
eas build --profile preview --platform android      # APK for direct install
eas build --profile preview --platform ios          # TestFlight
eas build --profile production --platform android    # .aab for Google Play
eas build --profile production --platform ios        # App Store / TestFlight
```

iOS builds require enrollment in the Apple Developer Program. Android signing
credentials are managed by EAS on first build.

### Environment & secrets

Production builds read configuration from `EXPO_PUBLIC_*` env vars (see
`.env.example`); set them as EAS secrets rather than committing them:

```bash
eas secret:create --name EXPO_PUBLIC_SENTRY_DSN --value "https://...@sentry.io/..."
eas secret:create --name SENTRY_AUTH_TOKEN --value "..."   # source-map upload (build-time only)
```

### Error reporting (Sentry)

Runtime errors route through `src/lib/errorReporting.ts`. When
`EXPO_PUBLIC_SENTRY_DSN` is set (standalone builds), exceptions and the top-level
ErrorBoundary forward to [Sentry](https://sentry.io); in local dev / Expo Go the
seam falls back to console logging. Set the Sentry org/project in the
`@sentry/react-native` config plugin (`app.json`) for source-map upload.

## Authentication

Email/password auth runs through Firebase, wrapped by `src/services/authService.ts`
and exposed app-wide via `AuthContext` / `useAuth`.

- **Sign up / in / out** — standard email + password.
- **Password reset** — "Forgot password?" on the login screen opens
  `app/(auth)/forgot-password.tsx`, which sends a Firebase reset email. The
  confirmation is shown regardless of whether the address is registered, so the
  UI never discloses which emails have accounts.
- **Email verification** — a verification email is sent at signup (non-fatal if
  it fails; resendable). While `emailVerified` is false, an
  `UnverifiedEmailBanner` shows above the tabs with **Resend** and **I've
  verified** (the latter calls `reloadUser`, since `onAuthStateChanged` does not
  re-fire on `reload`). The app stays usable while unverified.
- **Google Sign-In — deferred to M3.** It needs `expo-auth-session` /
  `expo-web-browser` (pending dependency approval) and the native OAuth redirect
  config from the Phase 2 EAS build. A provider seam lives in
  `src/services/authProviders.ts` (`getProvider("google").isAvailable === false`)
  so the implementation drops in behind a stable interface without touching call
  sites.

## Deep linking & sharing

The link schema is a **stable contract** — `src/lib/deepLinks.ts` is its single
source of truth (builders + parser). Do not hand-format these strings elsewhere.

| Form | Shape | Notes |
|---|---|---|
| Custom scheme | `boardapp://board/{boardId}?session={sessionId}` | Works today via the `scheme` in `app.json`; no extra native config. The optional `?session=` opens that session after the board loads. Notification taps also use this. |
| Universal / App Link | `https://<domain>/b/{inviteCode}` | Opens the installed app on tap (else falls through to web). Lands on the `app/b/[code].tsx` route, which resolves the code → board and routes into the existing join gate. |

### Enabling the https links (domain required — not yet provisioned)

The `boardapp://` scheme flow and the `/b/{code}` route work now. The native
association config for the https form is **already declared** in `app.json`
(`ios.associatedDomains` + an Android `autoVerify` `VIEW` intent filter), using the
`boardapp.example.com` **placeholder host**. To go live, swap the placeholder for
your real domain in three places that must all agree, then rebuild:

1. Set the runtime domain: `eas secret:create --name EXPO_PUBLIC_LINK_DOMAIN --value "board.yourdomain.com"` (read by `deepLinks.ts` when building invite URLs).
2. Replace `boardapp.example.com` in `app.json` — both `ios.associatedDomains`
   and the Android `VIEW` intent filter `host`.
3. Host the association files (templates in `public/.well-known/`, served at the
   web root): fill `apple-app-site-association` with your Apple Team ID and
   `assetlinks.json` with the EAS Android signing SHA-256 (`eas credentials`).
4. Rebuild (native config + associated-domain verification only take effect in an
   EAS build).

### Share sheet (share INTO B.O.A.R.D)

Sharing an image **into** B.O.A.R.D is wired end-to-end via `expo-share-intent`:

- **OS receiver:** the `expo-share-intent` config plugin (in `app.json`) registers
  the Android `SEND` / `SEND_MULTIPLE` filters (image, text) and generates the iOS
  Share Extension. `app/_layout.tsx` consumes its hook (`useShareIntentContext`).
- **Routing:** a shared **link/text** is parsed through the deep-link contract
  (`classifyShare` → `handleSharedItem`) and navigated inline. A shared **image** is
  stashed (`src/lib/pendingShare.ts`) and the user is sent to the `/share`
  board-picker (`app/share.tsx`).
- **Placement:** the picker downscales each image (`imagePicker.prepareNativeImageUri`)
  and calls `placeSharedItem`, which uploads + creates the `image` element via the
  Phase 9 pipeline. Images land near the board origin (cascaded for a multi-image
  share) and can be repositioned.

The receiver runs in an **EAS build only** (not Expo Go / web), so the share-a-PNG
flow is verified on-device. `expo-sharing` / `expo-intent-launcher` remain
**outbound** APIs and are unrelated to this inbound path.

---

## Progressive Web App (PWA)

The web build is installable. Everything is served from `public/` (copied to the
web build root) plus the document `<head>` in `app/+html.tsx`:

| Piece | File | Notes |
|---|---|---|
| Web app manifest | `public/manifest.json` | Name, icons, `standalone` display, theme color. Linked from `+html.tsx`. |
| Service worker | `public/sw.js` | Hand-rolled (no Workbox dependency). Network-first for navigations + the JS bundle, cache-first for `/icons/*`; offline navigation falls back to the cached shell. Bump `CACHE_VERSION` when editing it. |
| Install prompt | `src/components/PWAInstallPrompt.tsx` | Web-only banner driven by `beforeinstallprompt`; renders `null` on native and on iOS Safari (which installs via Share → Add to Home Screen, covered by the `apple-*` meta tags). |
| Document head | `app/+html.tsx` | `lang="en"` (a11y), manifest/theme links, apple meta, registers the SW. Web-only — never bundled into native. Requires `web.output: "static"` in `app.json` (set in Phase 5); under the SPA `"single"` output Expo ignores `+html.tsx`. |

> **Why static output:** `+html.tsx` only applies when `app.json` sets
> `expo.web.output: "static"` (server-rendered HTML). This also prerenders each
> route's HTML shell, which improves first-paint and the Lighthouse performance
> score. It does not affect the native iOS/Android builds. Components must be
> render-safe in Node (guard `window`/`document` access behind effects or
> `Platform.OS === "web"`), as the export run verifies.

### Verify

```bash
npx expo export -p web              # outputs the static web build to dist/
npx serve dist                      # or any static server (SW needs http(s), not file://)
npx lighthouse http://localhost:3000 --view
```

Thresholds (Month 2 exit bar): **performance > 80, accessibility > 90**. The
install prompt fires in a Chromium browser once the installability criteria are
met (served over https/localhost, manifest + SW registered).

> **Icons:** the manifest currently points at the 1024×1024 `assets/icon.png`
> (copied to `public/icons/`) for both `any` and `maskable` purposes. A larger
> icon satisfies the smaller-size requirements; add dedicated 192/512 cuts if you
> want tighter control over the maskable safe-zone.

---

## Keyboard shortcuts

The board canvas is fully keyboard-drivable (Phase 11). Bindings resolve through a
single pure table (`src/lib/shortcuts.ts`); the in-app `?` cheat sheet is rendered
from the same source, so it can't drift from what's wired.

| Keys | Action |
| --- | --- |
| `P` `E` `T` `S` `H` | Pen · Eraser · Text · Select · Hand (pan) |
| `R` `O` `L` `A` `N` | Rectangle · Oval · Line · Arrow · Triangle (switches to the shape tool) |
| `⌘/Ctrl` + `Z` / `⇧Z` (or `Y`) | Undo / Redo (paths only — see limits) |
| `⌘/Ctrl` + `A` `C` `V` `D` | Select all · Copy · Paste · Duplicate |
| `⌘/Ctrl` + `]` / `[` | Bring to front / Send to back |
| `Delete` / `Backspace` | Delete selection |
| `Esc` | Deselect |
| `⇧` + `1` / `⌘/Ctrl` + `0` | Zoom to fit / Zoom to 100% |
| `⌘/Ctrl` + `+` / `−` | Zoom in / out |
| `Space` + drag | Temporary pan (the Hand tool is the persistent equivalent) |
| `?` | Toggle the shortcuts cheat sheet |

Shortcuts are suppressed while editing a text element so the field gets normal
keystrokes. On web they bind to DOM keyboard events (Cmd/Ctrl+V flows through the
browser's `paste` event so an OS-clipboard image is still caught).

### Keyboard shortcuts (native)

Bluetooth-keyboard support on iOS/Android uses
[`react-native-key-command`](https://github.com/Expensify/react-native-key-command),
which needs native hooks forwarded from the app shell. The Expo config plugin
`plugins/withHardwareKeyCommands.js` injects them automatically during prebuild
**for the Objective-C / Java app templates** documented by the library. Expo SDK 55
generates a **Swift `AppDelegate` and Kotlin `MainActivity`**, for which the plugin
logs a warning and leaves the files untouched (so it never breaks a prebuild) — add
the forwarding by hand on those templates:

- iOS (`AppDelegate.swift`): expose `keyCommands` / `handleKeyCommand(_:)` →
  `HardwareShortcuts.sharedInstance()`.
- Android (`MainActivity.kt`): forward `onKeyDown` →
  `KeyCommandModule.getInstance().onKeyDownEvent(keyCode, event)`.

Native key capture and OS-clipboard image paste (`expo-clipboard`) require a real
build + a hardware keyboard to verify; they cannot be exercised in Jest or on web.

---

## Project Structure

```
app/
  (auth)/           Login and registration screens
  (tabs)/           Main tab UI (boards, schedule, profile)
  board/[id].tsx    Canvas screen (drawing, text elements, presence)
  session/          Session creation and edit screens
  +html.tsx         Web document head (PWA manifest/meta, SW registration)
public/             Served at web root: PWA manifest, service worker, icons, .well-known/
src/
  components/       Reusable UI components
  contexts/         AuthContext (global auth state)
  hooks/            useAuth and other custom hooks
  services/         All Firestore access (boardService, pathService, sessionService, ...)
  types/            TypeScript interfaces
firestore.rules     Security rules
firestore.indexes.json  Composite index definitions
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React Native + Expo (TypeScript) |
| Routing | expo-router (file-based) |
| Auth | Firebase Authentication (email/password) |
| Database | Cloud Firestore (NoSQL, real-time) |
| Drawing | react-native-svg |
| AI | OpenAI GPT-3.5 (user-supplied key) |
| Notifications | Expo Push Notifications |

---

## Known Limitations

- **Per-client redo stack** — redo is local only. If another user draws while you have items in your redo stack, redo may re-add paths visually out of order. Accepted trade-off for scope.
- **OpenAI key is per-device** — the key is stored in AsyncStorage and is not synced to Firestore. Each user must enter their own key.
- **Push notifications require Expo Go (until Phase 3)** — standalone EAS builds now exist (`eas.json`), but FCM/APNs credential wiring for standalone push lands in Month 2 Phase 3. Until then notifications only work inside Expo Go with a valid push token registered.
- **No offline support** — all reads and writes require an active network connection. Failures surface as dismissible error banners.
- **Eraser removes full strokes** — Firestore stores paths as point arrays (not raster), so the eraser deletes entire strokes rather than pixel regions.
- **Session participants** — participants are friends-only; there is no public session discovery or open join link.
- **Undo/redo is path-only** — `⌘/Ctrl+Z` undoes the last stroke (the existing path-history mechanism); shapes/text/images are not yet on the undo stack.
- **No group/ungroup** — selection is ephemeral and there is no persistent group primitive, so `⌘/Ctrl+G` is intentionally unbound. Grouping is a data-model feature (a persistent `groupId` + selection/transform changes) deferred beyond the Phase 11 shortcuts work.

---

## Presentation Demo Script

### Before the demo
- Two devices/emulators logged in (admin account + participant account)
- A test board already created on the admin account
- Both accounts are friends
- OpenAI key configured on admin device

### Step-by-step flow

**1. Real-time drawing**
- Admin: open a board, draw strokes in different colors and widths
- Participant: join the board via the invite code in the Share modal
- Observe strokes appear in real time on the participant device
- Admin: undo → stroke disappears on both devices; redo → it comes back

**2. Text elements**
- Admin: select the T tool, tap the canvas → a text box appears
- Type text, resize using the corner handles
- Tap the trash icon (appears when selected) → element removed from all clients

**3. Presence**
- Participant: admin's avatar appears in the board header
- Tap the avatar → modal shows "Active just now" and friend/add-friend status

**4. Session scheduling**
- Admin: tap the Session button in the board header
- Fill in title, board, date, and time → create
- Both devices receive a push notification
- Navigate to Schedule tab → session shows in Upcoming

**5. AI summary**
- Mark the session as Ended from the Schedule tab
- Session moves to Past → tap "Generate AI Summary"
- Summary populates on the session card
- Force-close the app and reopen → summary is persisted (Firestore write confirmed)

**6. Friends**
- Profile tab → Add Friend by email
- Accept on the other device → both appear in each other's friends list

---

## Branch Naming

- `feature/description` — new features
- `fix/description` — bug fixes
- `chore/description` — infrastructure, docs, cleanup
