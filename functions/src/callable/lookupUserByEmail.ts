import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";

// Month 6 — the email → user lookup behind invite-by-email (boards and
// workspaces) and friend search, moved server-side.
//
// It moved because `/users/{uid}` is no longer listable. That rule used to be a
// bare `allow read: if isSignedIn()`, which covers `list` as well as `get`, so a
// single `getDocs(collection(db, "users"))` returned the whole directory — and
// these documents carry `email` (src/services/authService.ts writes it on
// signup). The caller who makes that a real disclosure rather than a
// theoretical one is an EMBED identity: `exchangeEmbedToken` signs the bearer of
// a PUBLIC read-only embed link into a genuine Firebase Auth session, so
// `request.auth != null` is satisfied by anyone who has ever been handed such a
// link.
//
// The narrower rule that would have kept the lookup client-side does not exist.
// Firestore security rules expose only `request.query.limit`, `.offset` and
// `.orderBy` — never the `where` clauses — so no predicate can admit "the
// email-equality query" while refusing an unfiltered dump. Either `list` stays
// open to everyone, or the lookup moves here. It moved here.
//
// What this function does NOT claim: it is not an anti-enumeration gate. A
// signed-in caller can still probe one address at a time and learn whether it
// has an account, exactly as the invite form has always let them. What it
// removes is the BULK read — the whole address book in one query — and it caps
// the disclosure per probe at the three fields below. Rate-limiting or
// restricting probes to a caller's own workspaces would be a separate change;
// do not describe this one as closing that.
//
// Normalization lives here, in one place, and that fixes a live inconsistency
// rather than merely tidying one: `boardService.addMemberByEmail` and
// `workspaceService.addMemberByEmail` lowercased and trimmed before querying,
// while `friendService.getUserByEmail` did neither — so `Bob@X.Z` found Bob
// through an invite and found nobody through friend search. All three now go
// through `normalizeLookupEmail`.
//
// Deploy-ordered like the three create callables: this must be live BEFORE the
// firestore.rules `list` deny, or all three features start throwing permission
// errors. See the warning at the top of firestore.rules.

export interface LookupUserByEmailRequest {
  email: string;
}

/** Everything a caller gets back about another user, and deliberately all of
 *  it. The three call sites consume exactly these three fields
 *  (src/services/friendService.ts, boardService.ts, workspaceService.ts);
 *  returning the stored document instead would rebuild inside this function the
 *  very leak the `list` deny closed, one probe at a time. Anything a future
 *  caller needs should be added here explicitly, with a reason. */
export interface UserDirectoryEntry {
  uid: string;
  displayName: string;
  email: string;
}

/** `null` for "no such user" rather than a `not-found` throw: every call site
 *  already has a `not_found` branch that predates this function, and a throw
 *  would turn a routine outcome into an error banner at each of them. */
export type LookupUserByEmailResponse = UserDirectoryEntry | null;

/** Injected so the handler unit-tests without Firestore, matching the
 *  handleCreateWorkspace / handleCreateBoard pattern. `data` is the raw stored
 *  document — this collection is client-written, so the handler treats every
 *  field as untrusted rather than typing it into a tidy profile shape here. */
export interface LookupUserByEmailDeps {
  findByEmail(
    email: string
  ): Promise<{ uid: string; data: Record<string, unknown> } | null>;
}

/** The one normalization point for directory lookups — and it normalizes the
 *  QUERY only. The stored side is `user.email` written verbatim from Firebase
 *  Auth (src/services/authService.ts#ensureUserProvisioned), so this fixes the
 *  three call sites disagreeing with each other, not a stored record whose
 *  case differs from Auth's. That was already true of the two call sites that
 *  lowercased before querying; nothing regresses by making the third agree. */
export function normalizeLookupEmail(raw: string): string {
  return raw.toLowerCase().trim();
}

export async function handleLookupUserByEmail(
  req: CallableRequest<LookupUserByEmailRequest>,
  deps: LookupUserByEmailDeps
): Promise<LookupUserByEmailResponse> {
  // Checked before anything reads the directory: an unauthenticated caller must
  // not be able to turn this into an open oracle over every registered address.
  if (!req.auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign in to look up a user.");
  }

  const { email } = req.data ?? ({} as LookupUserByEmailRequest);
  // `typeof` rather than truthiness: a non-string `email` (a number, an object,
  // an array) would otherwise reach `.toLowerCase()` and throw an `internal`
  // 500 instead of the `invalid-argument` a malformed request deserves.
  if (typeof email !== "string" || !email.trim()) {
    throw new HttpsError("invalid-argument", "An email address is required.");
  }

  const normalized = normalizeLookupEmail(email);
  const match = await deps.findByEmail(normalized);
  if (!match) return null;

  // Projected field by field, never spread. A spread would forward whatever
  // else the document happens to carry — which is the failure mode this whole
  // function exists to prevent, and it would arrive silently the day someone
  // adds a field to the profile document.
  return {
    uid: match.uid,
    // `""` rather than `undefined`: a user document with no `displayName` is
    // ordinary (social sign-in before the profile step), and `undefined` is not
    // representable in a callable's JSON response anyway.
    displayName:
      typeof match.data.displayName === "string" ? match.data.displayName : "",
    // Echoes the STORED address when it is a string, so a caller sees the
    // canonical spelling rather than whatever they typed; falls back to the
    // normalized query value for a corrupt record, which is the value that
    // matched.
    email: typeof match.data.email === "string" ? match.data.email : normalized,
  };
}

export const lookupUserByEmail = onCall(
  (req: CallableRequest<LookupUserByEmailRequest>) => {
    const db = getFirestore();
    return handleLookupUserByEmail(req, {
      findByEmail: async (email) => {
        // `limit(1)` because every caller wants one user. Duplicate emails are
        // not supposed to exist (Firebase Auth enforces uniqueness upstream),
        // and the previous client query took `docs[0]` off an unbounded result
        // for the same reason — this just stops paying for the rest.
        const snap = await db
          .collection("users")
          .where("email", "==", email)
          .limit(1)
          .get();
        if (snap.empty) return null;
        const d = snap.docs[0];
        return { uid: d.id, data: d.data() as Record<string, unknown> };
      },
    });
  }
);
