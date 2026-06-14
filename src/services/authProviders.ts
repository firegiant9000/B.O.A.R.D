/**
 * Social auth provider seam (Phase 6 seam → Phase 11 Google implementation).
 *
 * Call sites stay decoupled from the implementation: a screen asks
 * `getProvider("google").isAvailable` and only renders the button when it is true,
 * then calls `signIn()` to run the flow. `isAvailable` is driven by whether the
 * platform's OAuth client ID is configured for this build (see CLIENT_IDS), so the
 * button auto-hides in Expo Go / unconfigured builds rather than throwing.
 *
 * Native note: the OAuth redirect only works in a native build (the reverse-client
 * URL scheme is registered there). This must be verified on TestFlight / Play
 * internal, not Expo Go — see docs/month-3-phases.md Phase 11 verification.
 */
import { Platform } from "react-native";
import {
  GoogleAuthProvider,
  signInWithCredential,
  User,
} from "firebase/auth";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import { auth } from "../config/firebase";
import { ensureUserProvisioned } from "./authService";

// Dismisses the in-app browser and resolves the pending session when the app is
// reopened via the OAuth redirect. Safe no-op on native cold start; must run at
// module load.
WebBrowser.maybeCompleteAuthSession();

export type SocialProviderId = "google";

export interface SocialAuthProvider {
  id: SocialProviderId;
  /** Whether this provider is wired up and configured in the current build. */
  isAvailable: boolean;
  /** Begin the provider's sign-in flow, resolving to the Firebase user. */
  signIn(): Promise<User>;
}

const GOOGLE_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
};

// Per-platform OAuth client IDs from the Google Cloud Console, injected at build
// time — EXPO_PUBLIC_* vars are inlined into the bundle by Expo. Left blank until
// the project's credentials exist, so the provider reports unavailable rather than
// rendering a button that 400s. See .env.example.
const CLIENT_IDS = {
  ios: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  android: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
  web: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
};

/** Resolve the OAuth client ID for the current platform, falling back to web. */
function platformClientId(): string | undefined {
  if (Platform.OS === "ios") return CLIENT_IDS.ios ?? CLIENT_IDS.web;
  if (Platform.OS === "android") return CLIENT_IDS.android ?? CLIENT_IDS.web;
  return CLIENT_IDS.web;
}

async function signInWithGoogle(): Promise<User> {
  const clientId = platformClientId();
  if (!clientId) {
    throw new Error("Google Sign-In is not configured in this build.");
  }

  // App scheme ("boardapp") is registered natively; Expo builds the reverse-client
  // redirect from it. Google must have this redirect URI whitelisted for the client.
  const redirectUri = AuthSession.makeRedirectUri({ scheme: "boardapp" });

  // Random nonce binds the returned ID token to this request (replay protection);
  // Google echoes it inside the id_token and Firebase validates the audience.
  const nonce = Crypto.randomUUID();

  const request = new AuthSession.AuthRequest({
    clientId,
    scopes: ["openid", "profile", "email"],
    redirectUri,
    responseType: AuthSession.ResponseType.IdToken,
    extraParams: { nonce },
    usePKCE: false,
  });

  const result = await request.promptAsync(GOOGLE_DISCOVERY);

  if (result.type !== "success") {
    if (result.type === "cancel" || result.type === "dismiss") {
      throw new Error("Google Sign-In was cancelled.");
    }
    throw new Error("Google Sign-In failed. Please try again.");
  }

  const idToken = result.params.id_token;
  if (!idToken) {
    throw new Error("Google Sign-In did not return an ID token.");
  }

  const credential = GoogleAuthProvider.credential(idToken);
  const { user } = await signInWithCredential(auth, credential);

  // First Google sign-in has no separate signup step, so provision the profile doc
  // + personal workspace here to match email signup (Phase 1 / Phase 11). Idempotent
  // on returning sign-ins.
  await ensureUserProvisioned(user);

  return user;
}

const googleProvider: SocialAuthProvider = {
  id: "google",
  isAvailable: Boolean(platformClientId()),
  signIn: signInWithGoogle,
};

const providers: Record<SocialProviderId, SocialAuthProvider> = {
  google: googleProvider,
};

export function getProvider(id: SocialProviderId): SocialAuthProvider {
  return providers[id];
}
