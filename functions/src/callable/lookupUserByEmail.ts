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
// What this function does NOT claim: it is not an anti-enumeration gate. An
// ACCOUNT HOLDER can still probe one address at a time and learn whether it
// has an account, exactly as the invite form has always let them. What it
// removes is the BULK read — the whole address book in one query — and it caps
// the disclosure per probe at the three fields below. Rate-limiting or
// restricting probes to a caller's own workspaces would be a separate change;
// do not describe this one as closing that.
//
// That parity argument holds ONLY for account holders, which is why the
// handler below refuses embed identities outright. An embed identity has no
// invite form, no friend search and no account — it has never had the
// per-probe capability this function would otherwise hand it, so "exactly as
// the invite form has always let them" is simply false of that caller. It is
// also the exact population the `/users` `allow list: if false` tightening
// was written to take this capability away from (see firestore.rules'
// `/users` comment), so admitting it here would hand back through a callable
// what the rule had just closed — unbounded, unlogged, one address at a time.
// None of the three call sites is reachable from an embed session, verified
// rather than assumed: `app/board/[id].tsx` renders `BoardHeader` (and with
// it `BoardUserBar`'s friend request and the share/invite affordance) only
// under `!embedMode`, and the workspace invite lives in `WorkspaceSwitcher`
// on the tab routes an embed session never reaches. So the refusal costs no
// feature; it removes a capability nothing legitimate was using.
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
 *  Auth (src/services/authService.ts#ensureUserProvisioned), so what this
 *  fixes is the three call sites disagreeing with EACH OTHER: `Bob@X.Z` used
 *  to find Bob through an invite and nobody through friend search.
 *
 *  QUALIFIED DELIBERATELY. Whether a lowercased query always matches the
 *  stored value depends on whether Firebase Auth itself canonicalises
 *  `user.email` to lowercase, and that is NOT documented upstream — the Admin
 *  SDK reference describes `UserRecord.email` only as "the user's primary
 *  email, if set", and the Auth guides say nothing about case handling.
 *  Unverified means unverified: do not restate this as "nothing regresses".
 *
 *  What follows if Auth does NOT canonicalise: a record stored as `Bob@X.Z`
 *  becomes unfindable here, because the query is lowercased and Firestore's
 *  `==` is case-sensitive. That outcome is not NEW for invite-by-email —
 *  `boardService`/`workspaceService` already lowercased before querying and
 *  already had it — but it IS new for friend search, which previously passed
 *  the raw string through and so could still match such a record by exact
 *  spelling. Making the third call site agree therefore trades one
 *  inconsistency for one narrower, uniform failure mode, knowingly.
 *
 *  Closing it properly means normalising the STORED side too — writing
 *  `user.email?.toLowerCase()` in `ensureUserProvisioned` plus a backfill for
 *  existing documents. That is a separate change with a migration attached;
 *  do not describe this function as having done it. */
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
  // An embed identity satisfies the check above — `exchangeEmbedToken` mints a
  // genuine custom token for the bearer of a PUBLIC read-only embed link, and
  // BOTH of its claim branches set `embed: true` — so `req.auth` alone is not
  // "an account holder". Refused here rather than gated in rules, because this
  // handler runs on the Admin SDK and rules never see it. See the module
  // header for why this costs no feature.
  if (req.auth.token?.embed === true) {
    throw new HttpsError(
      "permission-denied",
      "This link cannot look up people by email address."
    );
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
