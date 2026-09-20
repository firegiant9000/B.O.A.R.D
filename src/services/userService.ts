import { httpsCallable } from "firebase/functions";
import { functions } from "../config/firebase";

// The client seam for the user directory (Month 6).
//
// There is exactly one operation here, and it is a Cloud Function call rather
// than a Firestore query on purpose. `firestore.rules` denies `list` on
// `/users`: that collection carries `email`, its old `allow read: if
// isSignedIn()` covered `list` as well as `get`, and an embed identity
// (`exchangeEmbedToken`) is a real signed-in Firebase session — so anyone
// holding a public read-only embed link could have run
// `getDocs(collection(db, "users"))` and walked off with every registered
// address. No narrower rule could have kept the query client-side: Firestore
// rules see a query's `limit`/`offset`/`orderBy` and never its `where` clauses,
// so "allow the email-equality query, deny the dump" is not expressible.
//
// This module exists so the three features that need an email lookup —
// `friendService.sendFriendRequest`, `boardService.addMemberByEmail` and
// `workspaceService.addMemberByEmail` — share one binding to the callable
// rather than three, which is also what stops the normalization from drifting
// apart again (friendService used to skip the lowercase/trim the other two
// applied). Normalization itself now lives server-side; see
// functions/src/callable/lookupUserByEmail.ts.
//
// Reading a single profile by id is NOT here: `allow get` is still open to any
// signed-in user, so a `getDoc(doc(db, "users", uid))` stays a plain Firestore
// read wherever a display name is rendered.

/** Everything the directory discloses about another user. Mirrors
 *  `UserDirectoryEntry` in functions/src/callable/lookupUserByEmail.ts — the
 *  function returns these three fields and nothing else, deliberately. */
export interface DirectoryUser {
  uid: string;
  displayName: string;
  email: string;
}

/**
 * Resolves an email address to a user, or `null` when no account matches.
 *
 * Case and surrounding whitespace do not matter: the callable normalizes
 * server-side, so callers should pass whatever the user typed rather than
 * pre-normalizing (three call sites pre-normalizing in three slightly different
 * ways is the bug this replaced).
 *
 * Rejects only on a genuine failure — unauthenticated, a blank address, or a
 * transport error. "No such user" is `null`, not a throw, so every caller's
 * existing `not_found` branch keeps working unchanged.
 */
export async function lookupUserByEmail(email: string): Promise<DirectoryUser | null> {
  const callable = httpsCallable<{ email: string }, DirectoryUser | null>(
    functions,
    "lookupUserByEmail"
  );
  const { data } = await callable({ email });
  return data ?? null;
}
