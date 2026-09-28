# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

There is **no `lint` script and no top-level `build` script**. The gate is type-check + tests.

```bash
npx tsc --noEmit            # type-check the app (NOT functions — see below)
npm test                    # Jest, app + src only
npm run test:coverage       # enforces the 60% line/statement floor on src/services
npm test -- path/to/file.test.ts          # single file
npm test -- -t "name of the test"         # single test by name
```

Cloud Functions are a **separate npm project** with their own lockfile and toolchain:

```bash
npm run functions:build     # tsc in functions/ — the only thing that type-checks functions/
npm run functions:test      # Jest in functions/
npm run functions:serve     # build, then firebase emulators (functions + firestore)
```

Firestore/Storage security-rules tests run against the emulator and **require JDK 21+**
(firebase-tools v15's emulator runtime):

```bash
npm run test:rules
```

Running the app: `npm start` (or `npm run android` / `ios` / `web`).

`.github/workflows/ci.yml` is the authority on what must pass — three independent jobs:
`tsc --noEmit` + `test:coverage --ci`, `test:rules`, and a `functions/` build + test.

## Architecture

Expo / React Native (expo-router, file-based routing) on Firebase, with three TypeScript
surfaces that do not share a toolchain:

| Surface | Root | Type-checked by |
|---|---|---|
| App | `app/`, `src/` | root `npx tsc --noEmit` |
| Cloud Functions | `functions/` | `npm run functions:build` only |
| Browser extension | `web/extension` | neither (excluded) |

**The root `tsconfig.json` excludes `functions` and `web/extension`.** A change under
`functions/` that breaks types will pass `npx tsc --noEmit` and fail CI. Always run
`npm run functions:build` when you touch that tree.

Path alias: `@/*` → `src/*`.

### Data flow

All Firestore access lives in `src/services/*Service.ts` — components and screens call a
service, never the Firebase SDK directly. `src/config/firebase.ts` is the single place the
SDK is initialized; it resolves config from `EXPO_PUBLIC_FIREBASE_*` env first, falling back
to `expo.extra.firebase` in `app.json` (the committed dev project).

Two React contexts carry global state: `AuthContext` and `WorkspaceContext`.
**`WorkspaceContext.activeWorkspaceId` scopes the boards and sessions surfaces** — multi-tenancy
is enforced by that scoping plus `firestore.rules`, and cross-workspace isolation is a hard CI
gate (`test:rules`). Treat any new collection as needing a rules test.

### Cloud Functions

`functions/src/callable/` holds the callable entry points (board/class/session/workspace
creation, the AI features, Stripe checkout, embed-token mint/exchange). Supporting layers:
`ai/` (prompt assembly, provider, rate limiting, caches), `billing/` (Stripe + plan limits),
`embed/` (JWT mint/exchange for embedded boards), `triggers/` (embeddings, poll tally).

AI runs through a **server-side gateway** so no provider key sits on the device.

### Feature flags

`src/lib/featureFlags.ts` gates every AI feature on a build-time `EXPO_PUBLIC_*` env var,
**default OFF**. The AI features additionally only work when `AI_GATEWAY_ENABLED` is on —
they ride the same gateway. Flags are inlined by Expo at build time, so flipping one means a
rebuild, not a restart. `.env.example` documents every variable.

## Gotchas

- **`jest.config.js` `transformIgnorePatterns` is load-bearing and fragile.** shiki, its
  `@shikijs/*` grammars, and the unist/hast/micromark stack they pull in are pure ESM and must
  stay admitted, or tests fail with "Cannot use import statement outside a module". The config
  spreads `jest-expo`'s own `transform` rather than retyping it, and adds an `.mjs` entry the
  preset lacks. Read the comments in that file before editing it.
- Coverage thresholds apply to `src/services/**` only, not the whole tree.
- Branch naming: `feature/`, `fix/`, `chore/` + description.
