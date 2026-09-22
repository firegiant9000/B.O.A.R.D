# Build and release

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
