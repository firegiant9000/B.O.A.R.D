import {
  createUserWithEmailAndPassword,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
} from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../config/firebase";

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

  await setDoc(doc(db, "users", user.uid), {
    email: user.email,
    displayName,
    createdAt: serverTimestamp(),
  });

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
