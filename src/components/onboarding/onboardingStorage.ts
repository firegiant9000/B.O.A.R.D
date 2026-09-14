import AsyncStorage from "@react-native-async-storage/async-storage";

// Month 5 — first-run onboarding tutorial (ROADMAP.md item 4). Completion is
// persisted per-uid, not globally: this app runs on shared classroom tablets
// (WorkspaceContext's `activeKey(uid)`, pinnedBoards' (uid, workspaceId) key),
// so a global flag would mean the second person to sign in on a device never
// sees the tutorial. Keying by uid means each account gets it once, on its
// own first sign-in, regardless of who used the device before.

const key = (uid: string) => `@board/onboardingComplete:${uid}`;

/** True once this uid has finished (or skipped) the onboarding tutorial. */
export async function hasCompletedOnboarding(uid: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(key(uid));
    return raw === "1";
  } catch {
    // Fails open to "not completed" (matches pinnedBoards' fail-to-empty
    // convention) — worst case a storage error shows the tutorial an extra
    // time, never suppresses it for a user who hasn't seen it.
    return false;
  }
}

/** Record that this uid has finished (or skipped) the onboarding tutorial. */
export async function markOnboardingComplete(uid: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key(uid), "1");
  } catch {
    // Best-effort; a failed persist just means the tutorial may show again.
  }
}
