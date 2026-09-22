# Deep linking and sharing

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
