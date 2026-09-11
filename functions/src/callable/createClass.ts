import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { generateInviteCode } from "./createBoard";

// Month 6 — education pilot (invite-based class enrollment + instructor
// cohort grid). ROADMAP.md's "Education pilot — reshaped": university-level
// only, K-12 explicitly out of scope. Invite-based self-enrollment ONLY — a
// student redeems `joinCode` with their OWN account, so this module never
// collects a name, email, date of birth, or minor-status field for anyone,
// and there is no bulk/CSV roster-import path here. Do NOT add one: a
// roster CSV is bulk PII for people who never signed up, and an under-13
// user would invoke COPPA's verifiable-parental-consent requirement that a
// roster import cannot satisfy. See ROADMAP.md's "A5" for the full
// reasoning this task's own write-up expands on.
//
// Class creation is server-side for the same reason board/session creation
// is (createBoard.ts, createSession.ts): the join code — the class's
// self-enrollment credential — must be generated where a client cannot
// choose it. A client-chosen or weakly-random code is guessable, and
// guessing one lets a stranger self-enroll into a class and (per
// firestore.rules' `isInstructorOfClass`) hand their own board's content to
// that class's instructor without ever having been invited.
//
// Unlike createBoard/createSession, there is NO plan/seat-cap gate here: a
// class is not scoped to any workspace at all (controller ruling R78 — the
// edu tier is sold manually with no self-serve, per ROADMAP.md:534), so
// nothing here reads `workspaces/*.plan`.

const MAX_NAME_LENGTH = 200;

export interface CreateClassRequest {
  name: string;
}

export interface CreateClassResponse {
  classId: string;
  joinCode: string;
}

/** Injected so the handler unit-tests without Firestore, matching
 *  handleCreateBoard's pattern (functions/src/callable/createBoard.ts). */
export interface CreateClassDeps {
  writeClass(doc: Record<string, unknown>): Promise<string>;
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
  const classId = await deps.writeClass({
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
  });

  return { classId, joinCode };
}

export const createClass = onCall((req: CallableRequest<CreateClassRequest>) => {
  const db = getFirestore();
  return handleCreateClass(
    req,
    {
      writeClass: async (doc) => (await db.collection("classes").add(doc)).id,
    },
    Date.now()
  );
});
