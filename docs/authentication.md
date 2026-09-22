# Authentication

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
- **Google Sign-In** — implemented behind the provider seam in
  `src/services/authProviders.ts` (`getProvider("google")`), using
  `expo-auth-session` / `expo-web-browser` for the native OAuth redirect.
  `isAvailable` is `Boolean` of the platform's OAuth client ID
  (`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`,
  `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` — see `.env.example`). While those three
  vars are blank, `isAvailable` is `false` and `src/components/GoogleSignInButton.tsx`
  returns `null`, so the "Continue with Google" button doesn't render at all
  rather than appearing disabled. The OAuth redirect only works in a native
  build (TestFlight / Play internal), not Expo Go.
