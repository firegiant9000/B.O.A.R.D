import {
  collection,
  getDoc,
  getDocs,
  doc,
  query,
  where,
  updateDoc,
  arrayUnion,
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
    schemaVersion: 1,
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
 * workspace at all (controller ruling R78).
 */
export async function createClass(name: string): Promise<CreateClassResponse> {
  const fn = httpsCallable<{ name: string }, CreateClassResponse>(functions, "createClass");
  const { data } = await fn({ name });
  return data;
}

export type EnrollResult = { classId: string; alreadyEnrolled: boolean };

/**
 * Self-enrollment by join code — mirrors boardService.joinBoardByCode
 * exactly. The write is a plain client `updateDoc`; firestore.rules'
 * self-enroll arm on `classes/{classId}` is what actually proves the caller
 * redeemed a real code and only ever appends the caller's OWN uid. This
 * function enforces nothing itself.
 */
export async function enrollInClass(inputCode: string): Promise<EnrollResult> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("You must be signed in to join a class.");
  }

  const normalized = inputCode.trim().toUpperCase();
  const q = query(classesRef, where("joinCode", "==", normalized));
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    throw new Error("No class found with that join code. Please check and try again.");
  }

  const classDoc = snapshot.docs[0];
  const studentIds: string[] = classDoc.data().studentIds ?? [];

  if (studentIds.includes(currentUser.uid)) {
    return { classId: classDoc.id, alreadyEnrolled: true };
  }

  await updateDoc(classDoc.ref, { studentIds: arrayUnion(currentUser.uid) });
  return { classId: classDoc.id, alreadyEnrolled: false };
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

/** Advisory-only membership check (mirrors firestore.rules'
 *  `isEnrolledInClass`) — never itself an enforcement point. */
export function isEnrolledStudent(klass: Pick<ClassRoom, "studentIds">, uid: string): boolean {
  return klass.studentIds.includes(uid);
}

/**
 * Attaches a board to a class as that board's assignment submission
 * (Appendix E.2 "Cohort views"). A pure `updateDoc` — firestore.rules'
 * `classIdTransitionValid` is what actually enforces the one-way pin (once
 * set, a board's `classId` can never be changed or cleared — mirrors
 * `workspaceIdUnchanged`'s re-parenting guard) and the enrollment check (the
 * caller must be an enrolled student of `classId` at the moment of this
 * write). A denied write throws the same permission error `updateDoc`
 * always would; this function enforces neither itself.
 */
export async function attachBoardToClass(boardId: string, classId: string): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), { classId });
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
 * assignment in one grid"). Access is enforced by firestore.rules'
 * `isInstructorOfClass` predicate on the board `read` rule (resolved with a
 * single get() on the class doc, per this task's R79 ruling): the SAME
 * query run by a non-instructor returns only the boards they already have
 * board-level access to (owner/member/invite-code), never the whole
 * cohort — this function does not filter anything itself.
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
