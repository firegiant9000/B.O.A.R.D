import {
  collection,
  getDoc,
  getDocs,
  doc,
  query,
  where,
  updateDoc,
  arrayUnion,
  arrayRemove,
  serverTimestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, auth, functions } from "../config/firebase";
import type { ClassRoom } from "../types";

// Month 6 — education pilot (invite-based class enrollment + instructor
// cohort grid, ROADMAP.md's "Education pilot — reshaped" + Appendix E.2
// "Cohort views"). University-level only; K-12 is explicitly out of scope
// (COPPA's verifiable-parental-consent requirement for under-13 users,
// which nothing here attempts to satisfy). Enrollment is invite-based
// self-service: a student redeems a join code with THEIR OWN account, so
// this module never collects or stores an identifier for anyone who has
// not signed up themselves. There is deliberately no bulk/CSV roster-import
// path — do NOT add one; see ROADMAP.md's Education-pilot section ("A5")
// and functions/src/callable/createClass.ts's header for the full
// reasoning (a roster CSV is bulk PII for people who never signed up).
//
// A class is its own top-level `classes/{classId}` collection, NOT an
// overloaded workspace — see firestore.rules' `classes` match block for why
// (a class carries none of a workspace's plan/billing/seat-cap semantics).
//
// Every enforcement point here is advisory only, same as every other
// service in this codebase: firestore.rules and the `createClass` Cloud
// Function are the real gates. See that function's header and
// firestore.rules' `classes` / `isInstructorOfClass` / `classIdTransitionValid`
// for what's actually enforced.

const classesRef = collection(db, "classes");

function mapClass(id: string, data: Record<string, any>): ClassRoom {
  return {
    id,
    name: data.name ?? "Untitled class",
    instructorId: data.instructorId ?? "",
    joinCode: data.joinCode ?? "",
    studentIds: data.studentIds ?? [],
    // Fix round 1, M2 — reads the STORED value (defaulting only when
    // absent), rather than hardcoding 1, so a future v2 document isn't
    // silently mislabelled as v1.
    schemaVersion: data.schemaVersion ?? 1,
    createdAt: data.createdAt?.toDate?.() ?? new Date(),
  };
}

interface CreateClassResponse {
  classId: string;
  joinCode: string;
}

/**
 * Creates a class through the `createClass` callable, which generates the
 * join code server-side — a client cannot choose its own (see
 * generateInviteCode's header on functions/src/callable/createBoard.ts;
 * createClass.ts reuses that same generator). No plan/seat-cap pre-flight
 * here, unlike createBoard/createSession: a class isn't scoped to any
 * workspace at all, and (see createClass.ts's own header) nothing caps how
 * many classes a signed-in user can create today.
 */
export async function createClass(name: string): Promise<CreateClassResponse> {
  const fn = httpsCallable<{ name: string }, CreateClassResponse>(functions, "createClass");
  const { data } = await fn({ name });
  return data;
}

/**
 * Self-enrollment by join code. Fix round 1, I4 — the code now resolves
 * against the narrow `joinCodes/{code}` lookup collection (holds only
 * `{classId}`, written server-side by `createClass`) instead of querying
 * the `classes` collection directly by `joinCode`: that query would have
 * required `classes/{classId}` itself to stay readable by anyone holding a
 * code, which is exactly the roster-exposure this fix round closed. The
 * self-enroll `updateDoc` below needs no prior read of the class doc at
 * all — `arrayUnion` is applied server-side, and firestore.rules'
 * self-enroll arm tolerates an idempotent re-submit (the caller is already
 * enrolled) as a no-op rather than rejecting it, so an "already enrolled"
 * double-tap of Join is harmless without this function needing to check
 * membership itself first.
 */
export async function enrollInClass(inputCode: string): Promise<{ classId: string }> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("You must be signed in to join a class.");
  }

  const normalized = inputCode.trim().toUpperCase();
  const lookup = await getDoc(doc(db, "joinCodes", normalized));
  if (!lookup.exists()) {
    throw new Error("No class found with that join code. Please check and try again.");
  }

  const { classId } = lookup.data() as { classId: string };
  try {
    await updateDoc(doc(db, "classes", classId), {
      studentIds: arrayUnion(currentUser.uid),
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Fix round 2, S4 — a resolvable code whose class write still fails
    // (the class was deleted after the code was minted, or any other
    // denial) surfaced the raw Firestore error verbatim before this. Map
    // it back to the SAME friendly message the resolve-miss path above
    // uses — from the caller's point of view this code just doesn't work,
    // and the underlying reason isn't actionable for them either way.
    throw new Error("No class found with that join code. Please check and try again.");
  }
  return { classId };
}

export async function getClass(classId: string): Promise<ClassRoom | null> {
  const snap = await getDoc(doc(db, "classes", classId));
  if (!snap.exists()) return null;
  return mapClass(snap.id, snap.data());
}

/** Classes taught by `uid` — feeds the instructor's own class picker. */
export async function getInstructorClasses(uid: string): Promise<ClassRoom[]> {
  const q = query(classesRef, where("instructorId", "==", uid));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => mapClass(d.id, d.data()));
}

/** Classes `uid` is enrolled in as a student — feeds both the "attach my
 *  board to a class" picker and the student's own "my classes" list. */
export async function getEnrolledClasses(uid: string): Promise<ClassRoom[]> {
  const q = query(classesRef, where("studentIds", "array-contains", uid));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => mapClass(d.id, d.data()));
}

/**
 * Instructor-only roster removal (fix round 1, I3) — without this, a
 * roster polluted by a bad write (or a student who simply left the course)
 * had no cleanup path at all, since `joinCode` is immutable and deleting
 * the whole class is the only other lever. Kept as narrow as self-enroll:
 * firestore.rules' removal arm permits shrinking `studentIds` by exactly
 * one DISTINCT named uid (fix round 2, S1 — `toSet().size()==size()`
 * closes a duplicate-uid path an earlier version of this arm allowed) and
 * touches nothing else, so this can never become a general roster-write
 * function.
 *
 * `arrayRemove` of a uid already gone from the roster (stale list, another
 * device got there first) computes an UNCHANGED array — firestore.rules'
 * removal arm itself denies that (it's not a size-1 shrink), but the
 * self-enroll arm's own pre-existing idempotent branch (`next == prev`,
 * open to any signed-in caller touching only `studentIds`/`updatedAt`)
 * already allows the resulting no-op write, so this still succeeds. Fix
 * round 2, S2's actual gap was purely client-side: this function's caller
 * (ClassroomHome's `handleRemoveStudent`) had no `catch` at all, so any
 * OTHER failure (a genuine denial, a network error) was an unhandled
 * rejection.
 */
export async function removeStudentFromClass(classId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, "classes", classId), {
    studentIds: arrayRemove(uid),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Attaches a board to a class as that board's assignment submission
 * (Appendix E.2 "Cohort views"). A pure `updateDoc` — firestore.rules'
 * `classIdTransitionValid` is what actually enforces the one-way pin (once
 * set, a board's `classId` can never be changed, mirroring
 * `workspaceIdUnchanged`'s re-parenting guard) and the enrollment check (the
 * caller must be an enrolled student of `classId` at the moment of this
 * write). A denied write throws the same permission error `updateDoc`
 * always would; this function enforces neither itself. `updatedAt` is
 * bumped in the same write (fix round 1, M3) so a board's "last touched"
 * date reflects this submission rather than falling back to today's date
 * on the cohort grid until the board is next edited for an unrelated
 * reason.
 */
export async function attachBoardToClass(boardId: string, classId: string): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), { classId, updatedAt: serverTimestamp() });
}

/**
 * Clears a board's `classId` (fix round 1, I3) — the ONE way `classId` may
 * ever move off a real value once set: firestore.rules'
 * `classIdTransitionValid` permits this specific write only when `classId`'s
 * CURRENT class no longer exists (the instructor deleted it), so this is
 * safe to expose unconditionally here; a denied write (the class still
 * exists) throws the same permission error `updateDoc` always would.
 */
export async function clearBoardClass(boardId: string): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), { classId: null, updatedAt: serverTimestamp() });
}

export interface AssignmentBoardSummary {
  id: string;
  title: string;
  ownerId: string;
  updatedAt: Date;
}

/**
 * Every board submitted to `classId` — the instructor cohort grid's one
 * query (Appendix E.2 "Cohort views... see all student boards for an
 * assignment in one grid").
 *
 * Fix round 1, I2 — an earlier version of this comment claimed a
 * non-instructor's identical query "gets back only the boards they already
 * have access to (never the whole cohort)." Verified wrong on the emulator:
 * firestore.rules' `isInstructorOfClass` disjunct on the board `read` rule
 * is a get()-gated predicate, not a bare field comparison Firestore can
 * prove safe purely from this query's `classId==` filter, so the ENTIRE
 * query is rejected outright (permission-denied) for anyone who isn't that
 * class's instructor — it does not silently filter to a subset. Callers
 * MUST confirm (e.g. via `getClass`) that the signed-in user is the named
 * class's instructor before calling this — see
 * `InstructorCohortGrid`'s own header for the component that does exactly
 * that.
 */
export async function getClassBoards(classId: string): Promise<AssignmentBoardSummary[]> {
  const q = query(collection(db, "boards"), where("classId", "==", classId));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      title: data.title ?? "Untitled",
      ownerId: data.ownerId ?? "",
      updatedAt: data.updatedAt?.toDate?.() ?? new Date(),
    };
  });
}
