import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { Platform } from "react-native";

// TODO: Replace with your Firebase project config
// Get these values from Firebase Console > Project Settings > Your Apps
const firebaseConfig = {
  apiKey: "AIzaSyAJFFIUWRaydXbhEjgdln4IfHfynJVfJK0",
  authDomain: "board-6b415.firebaseapp.com",
  projectId: "board-6b415",
  storageBucket: "board-6b415.firebasestorage.app",
  messagingSenderId: "1077801569891",
  appId: "1:1077801569891:web:e1b872528ab64cd9cdb256",
};

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
