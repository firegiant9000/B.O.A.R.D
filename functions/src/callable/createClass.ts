import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import { generateInviteCode } from "./createBoard";

// Month 6 — education pilot (invite-based class enrollment + instructor
// cohort grid). ROADMAP.md's "Education pilot — reshaped": university-level
// only, K-12 explicitly out of scope. Invite-based self-enrollment ONLY — a
// student redeems `joinCode` with their OWN account, so this module never
// collects a name, email, date of birth, or minor-status field for anyone,
// and there is no bulk/CSV roster-import path here. Do NOT add one: a
// roster CSV is bulk PII for people who never signed up, and an under-13
// user would invoke COPPA's verifiable-parental-consent requirement that a
// roster import cannot satisfy.
//
// Class creation is server-side for the same reason board/session creation
// is (createBoard.ts, createSession.ts): the join code — the class's
// self-enrollment credential — must be generated where a client cannot
// choose it. A client-chosen or weakly-random code is guessable, and
// guessing one lets a stranger self-enroll into a class and (per
// firestore.rules' `isInstructorOfClass`) hand their own board's content to
// that class's instructor without ever having been invited.
//
// Fix round 1, I4 — this also writes `joinCodes/{joinCode}` (holding only
// `{classId}`) in the SAME atomic batch as the class document, so the two
// can never diverge. `classes/{classId}` itself no longer answers "does
// this code exist" — see firestore.rules' `classes` match block for why
// that read was narrowed.
//
// Fix round 2 — the batch write below used `set`, which SILENTLY
// OVERWRITES an existing `joinCodes/{code}` doc on a collision instead of
// failing. `generateInviteCode`'s keyspace is 36^6 ≈ 2.18e9 codes; birthday
// collisions are real at scale (~2e-4 at 1,000 classes, ~2.3% at 10,000,
// ~90% at 100,000) and these docs are never deleted, so occupancy only
// grows. A collision would have redirected every future redemption of the
// FIRST class's code to the SECOND class, silently and with no error to
// either instructor — a student's board becoming readable by a stranger
// instructor, with no attacker action at all. `batch.create` below fails
// the WHOLE batch (ALREADY_EXISTS) on a collision instead — the class is
// not created either, fail-closed and still atomic — and a bounded 3-try
// regenerate-and-retry (`makeWriteClass`) turns the ~1-in-2-billion
// collision into an invisible retry rather than an error surfaced to an
// instructor who did nothing wrong.
//
// Unlike createBoard/createSession, there is NO plan/seat-cap gate here: a
// class is not scoped to any workspace at all (the edu tier is sold
// manually with no self-serve), so nothing here reads `workspaces/*.plan`.
// Fix round 1, M4 — that also means nothing caps how many classes a single
// signed-in user may create; left as-is deliberately (there is no existing
// plan-limits table entry for "classes" to gate against), but called out
// here rather than left unremarked.

const MAX_NAME_LENGTH = 200;
const MAX_JOIN_CODE_ATTEMPTS = 3;

export interface CreateClassRequest {
  name: string;
}

export interface CreateClassResponse {
  classId: string;
  joinCode: string;
}

/** Injected so the handler unit-tests without Firestore, matching
 *  handleCreateBoard's pattern (functions/src/callable/createBoard.ts).
 *  Takes a join code to try FIRST, but returns the code actually written —
 *  the two can differ after a retry (see makeWriteClass below), and the
 *  caller must return the REAL one or an instructor would be handed a code
 *  that doesn't resolve to anything. */
export interface CreateClassDeps {
  writeClass(
    classDoc: Record<string, unknown>,
    joinCode: string
  ): Promise<{ classId: string; joinCode: string }>;
}

export async function handleCreateClass(
  req: CallableRequest<CreateClassRequest>,
  deps: CreateClassDeps,
  now: number
): Promise<CreateClassResponse> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to create a class.");

  const rawName = (req.data ?? ({} as CreateClassRequest)).name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new HttpsError("invalid-argument", "A class name is required.");

  // Generated here, never taken from req.data: a client cannot choose its
  // own join code (see this file's header, and generateInviteCode's own
  // header on createBoard.ts).
  const joinCode = generateInviteCode();
  const result = await deps.writeClass(
    {
      name: name.slice(0, MAX_NAME_LENGTH),
      // Derived from the auth token, never trusted from the client — mirrors
      // ownerId/adminId in handleCreateBoard.
      instructorId: uid,
      joinCode,
      // Enrollment is self-service only (see this file's header) — starts
      // empty and grows only through the `classes/{classId}` self-enroll
      // rules arm, never through this function.
      studentIds: [] as string[],
      schemaVersion: 1,
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: now,
    },
    joinCode
  );

  return { classId: result.classId, joinCode: result.joinCode };
}

/** True for the Admin SDK's ALREADY_EXISTS failure (gRPC status code 6) —
 *  what `batch.create()` throws when `joinCodes/{code}` already has a
 *  document, i.e. a real collision on the join-code keyspace. */
function isAlreadyExistsError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === 6;
}

/** The real batched write, split out so it unit-tests against a fake
 *  Firestore-like object without the emulator, mirroring
 *  createSession.ts's `makeRunCreate`. Both docs are written in ONE batch
 *  so a class is never created without its lookup entry, or vice versa —
 *  and the lookup entry is `create`d, never `set`, so a collision fails the
 *  batch instead of silently overwriting another class's code (see this
 *  file's header). On that failure, regenerates a fresh code and retries,
 *  up to `MAX_JOIN_CODE_ATTEMPTS` times, before giving up. */
export function makeWriteClass(db: Firestore): CreateClassDeps["writeClass"] {
  return async (classDoc, initialJoinCode) => {
    let code = initialJoinCode;
    for (let attempt = 1; attempt <= MAX_JOIN_CODE_ATTEMPTS; attempt++) {
      const classRef = db.collection("classes").doc();
      const joinCodeRef = db.collection("joinCodes").doc(code);
      const batch = db.batch();
      batch.create(joinCodeRef, { classId: classRef.id });
      batch.set(classRef, { ...classDoc, joinCode: code });
      try {
        await batch.commit();
        return { classId: classRef.id, joinCode: code };
      } catch (err) {
        if (attempt < MAX_JOIN_CODE_ATTEMPTS && isAlreadyExistsError(err)) {
          code = generateInviteCode();
          continue;
        }
        throw err;
      }
    }
    // Unreachable — the loop above always returns or throws — kept so
    // TypeScript sees every path return, and so a future refactor that
    // breaks that invariant fails loudly instead of returning `undefined`.
    throw new HttpsError("internal", "Could not allocate a unique join code. Please try again.");
  };
}

export const createClass = onCall((req: CallableRequest<CreateClassRequest>) => {
  const db = getFirestore();
  return handleCreateClass(req, { writeClass: makeWriteClass(db) }, Date.now());
});
