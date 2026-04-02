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
  orderBy,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { Board } from "../types";

const boardsRef = collection(db, "boards");

function mapBoard(id: string, data: Record<string, any>): Board {
  return {
    id,
    title: data.title ?? "Untitled",
    ownerId: data.ownerId ?? "",
    adminId: data.adminId ?? data.ownerId ?? "",
    collaboratorIds: data.collaboratorIds ?? [],
    createdAt: data.createdAt?.toDate() ?? new Date(),
    updatedAt: data.updatedAt?.toDate() ?? new Date(),
  };
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
  const docRef = await addDoc(boardsRef, {
    title,
    ownerId,
    adminId: ownerId,
    collaboratorIds: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function getUserBoards(userId: string): Promise<Board[]> {
  const q = query(
    boardsRef,
    where("ownerId", "==", userId),
    orderBy("updatedAt", "desc")
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => mapBoard(d.id, d.data()));
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

export async function deleteBoard(boardId: string): Promise<void> {
  // Clear subcollections first — Firestore does not cascade-delete them automatically
  await Promise.all([
    deleteSubcollection(boardId, "paths"),
    deleteSubcollection(boardId, "notes"),
    deleteSubcollection(boardId, "presence"),
  ]);
  await deleteDoc(doc(db, "boards", boardId));
}
