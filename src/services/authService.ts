import {
  createUserWithEmailAndPassword,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  User,
} from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../config/firebase";
import { ensurePersonalWorkspace } from "./workspaceService";
import { seedSampleWorkspace } from "./onboardingService";

/**
 * Idempotently provisions everything a usable account needs beyond the Firebase
 * Auth record: a `users/{uid}` profile doc and a personal workspace. Both steps
 * are create-if-absent, so this is safe to call on every sign-in — which is the
 * point: social first-sign-in (Phase 11) has no separate "signup" step, so the
 * Google flow calls this to get the same personal-workspace auto-create that email
 * signup gets. Personal-workspace creation is best-effort and never blocks sign-in.
 */
export async function ensureUserProvisioned(
  user: User,
  displayName?: string
): Promise<void> {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  const isNewAccount = !snap.exists();
  if (isNewAccount) {
    await setDoc(ref, {
      email: user.email,
      displayName: displayName ?? user.displayName ?? "",
      createdAt: serverTimestamp(),
    });
  }

  // Resilient: a lagging or failed workspace write must not block sign-in — the
  // app reconciles the personal workspace lazily on the next load.
  let workspaceId: string | undefined;
  try {
    workspaceId = await ensurePersonalWorkspace(user.uid);
  } catch {
    // swallow — personal workspace is reconciled lazily client-side.
  }

  // Month 6 — sample workspace seeding (ROADMAP.md's "Sample workspace
  // seeding"; see onboardingService.ts's own header for the full design
  // rationale). Gated on `isNewAccount`, NOT on every call: this function
  // also runs on every returning Google sign-in (authProviders.ts), and an
  // established account's already-populated workspace must never be
  // retroactively seeded with sample content. `seedSampleWorkspace` itself
  // never throws (it rolls back its own partial writes internally — see its
  // header), but this stays wrapped in its own try/catch as defense in
  // depth: a populated sample workspace is a nice-to-have, never a
  // sign-in blocker.
  if (isNewAccount && workspaceId) {
    try {
      await seedSampleWorkspace(workspaceId, user.uid, displayName ?? user.displayName ?? "");
    } catch {
      // swallow — see above.
    }
  }
}

export async function signUp(
  email: string,
  password: string,
  displayName: string
) {
  const credential = await createUserWithEmailAndPassword(
    auth,
    email,
    password
  );
  const user = credential.user;

  await updateProfile(user, { displayName });

  // Profile doc + personal workspace auto-create (Phase 1).
  await ensureUserProvisioned(user, displayName);

  // Kick off email verification at signup (Phase 6). Non-fatal: if the send
  // fails (rate limit, transient), the account is still created and the user
  // can resend from the unverified banner.
  try {
    await sendEmailVerification(user);
  } catch {
    // swallow — verification can be re-triggered from the banner.
  }

  return user;
}

export async function signIn(email: string, password: string) {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

export async function signOut() {
  await firebaseSignOut(auth);
}

/** Send a Firebase password-reset email. No-ops on the UI side regardless of
 *  whether the address exists, so we don't leak which emails are registered. */
export async function sendPasswordReset(email: string) {
  await sendPasswordResetEmail(auth, email);
}

/** Resend the verification email to the currently signed-in user. */
export async function sendVerificationEmail() {
  if (!auth.currentUser) {
    throw new Error("Not signed in.");
  }
  await sendEmailVerification(auth.currentUser);
}

/** Refresh the cached user from the server so `emailVerified` reflects a
 *  verification completed in another tab/device. Returns the latest flag. */
export async function reloadUser(): Promise<boolean> {
  if (!auth.currentUser) return false;
  await reload(auth.currentUser);
  return auth.currentUser.emailVerified;
}
