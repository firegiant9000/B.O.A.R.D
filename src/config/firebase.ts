import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";
import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * Firebase config resolution (Month 2, Phase 1 — secrets hygiene).
 *
 * Source order, highest precedence first:
 *   1. `EXPO_PUBLIC_FIREBASE_*` env vars — injected at build time (EAS) for the
 *      production project, so prod credentials never live in source control.
 *   2. `expo.extra.firebase` in app.json — the committed dev/default project.
 *
 * Note: the Firebase web `apiKey` is a public client identifier, not a secret
 * (access is gated by Firestore/Storage rules), so committing the dev value is
 * fine. Moving it to config is about hygiene and per-environment swapping.
 */
const extraFirebase =
  (Constants.expoConfig?.extra?.firebase as
    | Record<string, string>
    | undefined) ?? {};

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? extraFirebase.apiKey,
  authDomain:
    process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? extraFirebase.authDomain,
  projectId:
    process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? extraFirebase.projectId,
  storageBucket:
    process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ??
    extraFirebase.storageBucket,
  messagingSenderId:
    process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ??
    extraFirebase.messagingSenderId,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? extraFirebase.appId,
};

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  throw new Error(
    "Firebase config missing. Set expo.extra.firebase in app.json or the " +
      "EXPO_PUBLIC_FIREBASE_* env vars (see .env.example)."
  );
}

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

/**
 * Firestore with offline persistence (Phase 6).
 *
 * Web: enable IndexedDB-backed persistence via the modern `persistentLocalCache`
 * API (the imperative `enableIndexedDbPersistence` the roadmap names is deprecated
 * in firebase v9+). The multi-tab manager lets several tabs share one cache instead
 * of the single-tab lock that would otherwise reject extra tabs. If persistence is
 * unavailable (private mode, unsupported browser), fall back to the in-memory cache
 * so the app still loads.
 *
 * Native: this project uses the *firebase JS SDK* (not @react-native-firebase), and
 * the JS SDK has no IndexedDB on React Native — it uses an in-memory cache. Writes
 * made while offline still queue and flush on reconnect within a session; durable
 * cross-launch persistence on native would require @react-native-firebase (deferred
 * to a later milestone). So "native is default-on" only holds for @react-native-firebase,
 * not here — `getFirestore` gives us the in-session memory cache, which is what we get.
 */
function createDb() {
  if (Platform.OS === "web") {
    try {
      return initializeFirestore(app, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      });
    } catch {
      // Already initialized, or persistence unsupported — memory cache is fine.
      return getFirestore(app);
    }
  }
  return getFirestore(app);
}

export const db = createDb();

/**
 * Firebase Storage (Phase 9 — image elements). Originals (downscaled to ≤ 2048px)
 * and thumbnails live under `boards/{boardId}/images/{imageId}/`; reads/writes are
 * gated by board membership in `storage.rules`. Uses the bucket from the resolved
 * Firebase config above, so it follows the same dev/prod env swap.
 */
export const storage = getStorage(app);
