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

const boardsRef = collection(db, "boards");

function mapBoard(id: string, data: Record<string, any>): Board {
  return {
    id,
    title: data.title ?? "Untitled",
    ownerId: data.ownerId ?? "",
    adminId: data.adminId ?? data.ownerId ?? "",
    collaboratorIds: data.collaboratorIds ?? [],
    inviteCode: data.inviteCode ?? "",
    members: data.members ?? [],
    createdAt: data.createdAt?.toDate() ?? new Date(),
    updatedAt: data.updatedAt?.toDate() ?? new Date(),
  };
}

function generateInviteCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `BORD-${suffix}`;
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
  data: Partial<Pick<Board, "title" | "adminId">>
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
