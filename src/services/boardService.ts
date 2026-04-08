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

export async function createBoard(
  title: string,
  ownerId: string
): Promise<string> {
  const inviteCode = generateInviteCode();
  const docRef = await addDoc(boardsRef, {
    title,
    ownerId,
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

  return snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title,
        ownerId: data.ownerId,
        collaboratorIds: data.collaboratorIds ?? [],
        inviteCode: data.inviteCode ?? "",
        members: data.members ?? [],
        createdAt: data.createdAt?.toDate() ?? new Date(),
        updatedAt: data.updatedAt?.toDate() ?? new Date(),
      };
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
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
    inviteCode: data.inviteCode ?? "",
    members: data.members ?? [],
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

/** Deletes a board and all its subcollection documents (paths, notes, presence). */
export async function deleteBoard(boardId: string): Promise<void> {
  const subcollections = ["paths", "notes", "presence", "textElements"];

  for (const sub of subcollections) {
    const snapshot = await getDocs(collection(db, "boards", boardId, sub));
    // Firestore batch limit is 500 ops
    for (let i = 0; i < snapshot.docs.length; i += 500) {
      const batch = writeBatch(db);
      snapshot.docs.slice(i, i + 500).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

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

function generateInviteCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `BORD-${suffix}`;
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

export async function getMemberBoards(userId: string): Promise<Board[]> {
  const q = query(boardsRef, where("members", "array-contains", userId));
  const snapshot = await getDocs(q);

  return snapshot.docs
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        title: data.title,
        ownerId: data.ownerId,
        collaboratorIds: data.collaboratorIds ?? [],
        inviteCode: data.inviteCode ?? "",
        members: data.members ?? [],
        createdAt: data.createdAt?.toDate() ?? new Date(),
        updatedAt: data.updatedAt?.toDate() ?? new Date(),
      };
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
