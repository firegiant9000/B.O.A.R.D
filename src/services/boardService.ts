import {
  collection,
  addDoc,
  getDocs,
  getDoc,
  deleteDoc,
  updateDoc,
  doc,
  query,
  where,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  writeBatch,
} from "firebase/firestore";
import { db, auth } from "../config/firebase";
import { Board } from "../types";
import { randomCode } from "../lib/secureRandom";
import { isBackgroundTemplate } from "../lib/backgrounds";

const boardsRef = collection(db, "boards");

const INVITE_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function mapBoard(id: string, data: Record<string, any>): Board {
  return {
    id,
    title: data.title ?? "Untitled",
    ownerId: data.ownerId ?? "",
    adminId: data.adminId ?? data.ownerId ?? "",
    collaboratorIds: data.collaboratorIds ?? [],
    inviteCode: data.inviteCode ?? "",
    members: data.members ?? [],
    backgroundTemplate: isBackgroundTemplate(data.backgroundTemplate)
      ? data.backgroundTemplate
      : "blank",
    createdAt: data.createdAt?.toDate() ?? new Date(),
    updatedAt: data.updatedAt?.toDate() ?? new Date(),
  };
}

function generateInviteCode(): string {
  return `BORD-${randomCode(6, INVITE_CODE_CHARS)}`;
}

/** Deletes all documents in a subcollection in 500-doc batches. */
async function deleteSubcollection(boardId: string, subcollection: string): Promise<void> {
  const snap = await getDocs(collection(db, "boards", boardId, subcollection));
  for (let i = 0; i < snap.docs.length; i += 500) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 500).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

export async function createBoard(
  title: string,
  ownerId: string
): Promise<string> {
  const inviteCode = generateInviteCode();
  const docRef = await addDoc(boardsRef, {
    title,
    ownerId,
    adminId: ownerId,
    collaboratorIds: [],
    inviteCode,
    members: [ownerId],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function getUserBoards(userId: string): Promise<Board[]> {
  const q = query(boardsRef, where("ownerId", "==", userId));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => mapBoard(d.id, d.data()));
}

export async function getMemberBoards(userId: string): Promise<Board[]> {
  const q = query(boardsRef, where("members", "array-contains", userId));
  const snapshot = await getDocs(q);
  return snapshot.docs
    .map((d) => mapBoard(d.id, d.data()))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function getBoard(boardId: string): Promise<Board | null> {
  const docSnap = await getDoc(doc(db, "boards", boardId));
  if (!docSnap.exists()) return null;
  return mapBoard(docSnap.id, docSnap.data());
}

export async function updateBoard(
  boardId: string,
  data: Partial<Pick<Board, "title" | "adminId" | "backgroundTemplate">>
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function assignBoardAdmin(
  boardId: string,
  newAdminId: string
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), { adminId: newAdminId });
}

/** Deletes a board and all its subcollection documents (paths, notes, presence, textElements). */
export async function deleteBoard(boardId: string): Promise<void> {
  await Promise.all([
    deleteSubcollection(boardId, "paths"),
    deleteSubcollection(boardId, "notes"),
    deleteSubcollection(boardId, "presence"),
    deleteSubcollection(boardId, "textElements"),
  ]);
  await deleteDoc(doc(db, "boards", boardId));
}

/** Removes the current user from a board's members array without deleting the board. */
export async function leaveBoard(boardId: string): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("You must be signed in.");
  await updateDoc(doc(db, "boards", boardId), {
    members: arrayRemove(currentUser.uid),
    updatedAt: serverTimestamp(),
  });
}

export type JoinBoardResult = { boardId: string; alreadyMember: boolean };

/** Adds a user directly to a board by UID (no lookup needed). */
export async function addMemberById(boardId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), {
    members: arrayUnion(uid),
    updatedAt: serverTimestamp(),
  });
}

export type AddByEmailResult = "added" | "not_found" | "already_member";

/** Looks up a user by email and adds them to the board. Returns the outcome. */
export async function addMemberByEmail(
  boardId: string,
  email: string
): Promise<{ result: AddByEmailResult; uid?: string }> {
  const q = query(collection(db, "users"), where("email", "==", email.toLowerCase().trim()));
  const snap = await getDocs(q);
  if (snap.empty) return { result: "not_found" };

  const uid = snap.docs[0].id;
  const boardSnap = await getDoc(doc(db, "boards", boardId));
  if (!boardSnap.exists()) throw new Error("Board not found");

  const members: string[] = boardSnap.data().members ?? [];
  if (members.includes(uid)) return { result: "already_member", uid };

  await updateDoc(doc(db, "boards", boardId), {
    members: arrayUnion(uid),
    updatedAt: serverTimestamp(),
  });
  return { result: "added", uid };
}

/**
 * Read-only lookup of a board by its invite code. Used by the `/b/{code}`
 * Universal/App Link landing route to resolve a code → board before routing the
 * viewer into the existing membership/join gate. Returns null when no board
 * matches, so the route can show a clean "invalid link" state.
 */
export async function getBoardByInviteCode(inputCode: string): Promise<Board | null> {
  const normalized = inputCode.trim().toUpperCase();
  const q = query(boardsRef, where("inviteCode", "==", normalized));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  return mapBoard(snapshot.docs[0].id, snapshot.docs[0].data());
}

export async function joinBoardByCode(inputCode: string): Promise<JoinBoardResult> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("You must be signed in to join a board.");
  }

  const normalized = inputCode.trim().toUpperCase();
  const q = query(boardsRef, where("inviteCode", "==", normalized));
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    throw new Error("No board found with that invite code. Please check and try again.");
  }

  const boardDoc = snapshot.docs[0];
  const members: string[] = boardDoc.data().members ?? [];

  if (members.includes(currentUser.uid)) {
    return { boardId: boardDoc.id, alreadyMember: true };
  }

  await updateDoc(boardDoc.ref, {
    members: arrayUnion(currentUser.uid),
    updatedAt: serverTimestamp(),
  });

  return { boardId: boardDoc.id, alreadyMember: false };
}
