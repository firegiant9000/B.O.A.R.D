/**
 * Social auth provider seam (Phase 6).
 *
 * Google Sign-In is intentionally deferred to M3: it requires the
 * `expo-auth-session` / `expo-web-browser` dependencies (pending approval) and
 * the native OAuth redirect configuration that only lands with the Phase 2 EAS
 * build. Rather than wire a half-working flow, we expose a stable adapter
 * interface here so the implementation drops in behind it without touching call
 * sites: a screen asks `getProvider("google").isAvailable` and only renders the
 * button when it flips true.
 */
import { User } from "firebase/auth";

export type SocialProviderId = "google";

export interface SocialAuthProvider {
  id: SocialProviderId;
  /** Whether this provider is wired up in the current build. */
  isAvailable: boolean;
  /** Begin the provider's sign-in flow, resolving to the Firebase user. */
  signIn(): Promise<User>;
}

const googleProvider: SocialAuthProvider = {
  id: "google",
  isAvailable: false,
  async signIn(): Promise<User> {
    throw new Error(
      "Google Sign-In is not available in this build (deferred to M3)."
    );
  },
};

const providers: Record<SocialProviderId, SocialAuthProvider> = {
  google: googleProvider,
};

export function getProvider(id: SocialProviderId): SocialAuthProvider {
  return providers[id];
}
