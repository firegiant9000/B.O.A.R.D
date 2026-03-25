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
} from "firebase/firestore";
import { db } from "../config/firebase";
import { Board } from "../types";

const boardsRef = collection(db, "boards");

export async function createBoard(
  title: string,
  ownerId: string
): Promise<string> {
  const docRef = await addDoc(boardsRef, {
    title,
    ownerId,
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

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      title: data.title,
      ownerId: data.ownerId,
      collaboratorIds: data.collaboratorIds ?? [],
      createdAt: data.createdAt?.toDate() ?? new Date(),
      updatedAt: data.updatedAt?.toDate() ?? new Date(),
    };
  });
}

export async function getBoard(boardId: string): Promise<Board | null> {
  const docSnap = await getDoc(doc(db, "boards", boardId));
  if (!docSnap.exists()) return null;

  const data = docSnap.data();
  return {
    id: docSnap.id,
    title: data.title,
    ownerId: data.ownerId,
    collaboratorIds: data.collaboratorIds ?? [],
    createdAt: data.createdAt?.toDate() ?? new Date(),
    updatedAt: data.updatedAt?.toDate() ?? new Date(),
  };
}

export async function updateBoard(
  boardId: string,
  data: Partial<Pick<Board, "title">>
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteBoard(boardId: string): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId));
}
