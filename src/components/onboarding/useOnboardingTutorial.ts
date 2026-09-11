import { useCallback, useEffect, useState } from "react";
import { hasCompletedOnboarding, markOnboardingComplete } from "./onboardingStorage";

// Month 5 — decides *when* the first-run tutorial shows; OnboardingTutorial
// itself only renders the steps it's told to. Kept out of the screen (screens
// under app/ can't be render-tested here — see OnboardingTutorial.tsx) so the
// show/hide decision is covered by a real test against real storage.

export interface OnboardingTutorialState {
  /** True once the per-uid flag has been checked and the tutorial should show. */
  visible: boolean;
  /** Mark the tutorial complete (skip or finish) and hide it. Idempotent. */
  dismiss: () => Promise<void>;
}

export function useOnboardingTutorial(uid: string | null): OnboardingTutorialState {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!uid) {
      setVisible(false);
      return;
    }
    let cancelled = false;
    hasCompletedOnboarding(uid).then((done) => {
      if (!cancelled) setVisible(!done);
    });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  const dismiss = useCallback(async () => {
    setVisible(false);
    if (uid) await markOnboardingComplete(uid);
  }, [uid]);

  return { visible, dismiss };
}
