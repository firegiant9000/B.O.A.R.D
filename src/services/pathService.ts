import {
  collection,
  addDoc,
  getDocs,
  deleteDoc,
  doc,
  query,
  orderBy,
  serverTimestamp,
  writeBatch,
  updateDoc,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { DrawPath, TextNote, TextElement } from "../types";

// --- Draw Paths ---

export async function savePath(
  boardId: string,
  path: Omit<DrawPath, "id" | "createdAt">
): Promise<string> {
  const pathsRef = collection(db, "boards", boardId, "paths");
  const docRef = await addDoc(pathsRef, {
    ...path,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function getBoardPaths(boardId: string): Promise<DrawPath[]> {
  const pathsRef = collection(db, "boards", boardId, "paths");
  const q = query(pathsRef, orderBy("createdAt", "asc"));
  const snapshot = await getDocs(q);

  return snapshot.docs
    .map((d) => {
      const data = d.data();
      // Skip documents missing required drawing fields
      if (!data.points || !data.color || !data.tool) return null;
      return {
        id: d.id,
        boardId: data.boardId ?? "",
        userId: data.userId ?? "",
        points: data.points,
        color: data.color,
        strokeWidth: data.strokeWidth ?? 5,
        tool: data.tool as "pen" | "eraser",
        createdAt: data.createdAt?.toDate() ?? new Date(),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

export async function deletePath(
  boardId: string,
  pathId: string
): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId, "paths", pathId));
}

export async function clearBoardPaths(boardId: string): Promise<void> {
  const pathsRef = collection(db, "boards", boardId, "paths");
  const snapshot = await getDocs(pathsRef);

  // Firestore batch limit is 500
  const chunks: Array<typeof snapshot.docs> = [];
  for (let i = 0; i < snapshot.docs.length; i += 500) {
    chunks.push(snapshot.docs.slice(i, i + 500));
  }

  for (const chunk of chunks) {
    const batch = writeBatch(db);
    chunk.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// --- Text Notes ---

export async function saveTextNote(
  boardId: string,
  note: Omit<TextNote, "id" | "createdAt">
): Promise<string> {
  const notesRef = collection(db, "boards", boardId, "notes");
  const docRef = await addDoc(notesRef, {
    ...note,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function getBoardNotes(boardId: string): Promise<TextNote[]> {
  const notesRef = collection(db, "boards", boardId, "notes");
  const q = query(notesRef, orderBy("createdAt", "asc"));
  const snapshot = await getDocs(q);

  return snapshot.docs
    .map((d) => {
      const data = d.data();
      if (!data.content || !data.position) return null;
      return {
        id: d.id,
        boardId: data.boardId ?? "",
        userId: data.userId ?? "",
        content: data.content,
        position: data.position,
        createdAt: data.createdAt?.toDate() ?? new Date(),
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);
}

export async function deleteTextNote(
  boardId: string,
  noteId: string
): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId, "notes", noteId));
}

export async function clearBoardNotes(boardId: string): Promise<void> {
  const notesRef = collection(db, "boards", boardId, "notes");
  const snapshot = await getDocs(notesRef);

  const chunks: Array<typeof snapshot.docs> = [];
  for (let i = 0; i < snapshot.docs.length; i += 500) {
    chunks.push(snapshot.docs.slice(i, i + 500));
  }

  for (const chunk of chunks) {
    const batch = writeBatch(db);
    chunk.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// --- Text Elements ---

export async function saveTextElement(
  boardId: string,
  element: Omit<TextElement, "id" | "createdAt">
): Promise<string> {
  const ref = collection(db, "boards", boardId, "textElements");
  const docRef = await addDoc(ref, { ...element, createdAt: serverTimestamp() });
  return docRef.id;
}

export async function getBoardTextElements(boardId: string): Promise<TextElement[]> {
  const ref = collection(db, "boards", boardId, "textElements");
  const q = query(ref, orderBy("createdAt", "asc"));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      boardId: data.boardId ?? "",
      userId: data.userId ?? "",
      text: data.text,
      position: data.position,
      width: data.width,
      height: data.height,
      fontSize: data.fontSize,
      color: data.color,
      createdAt: data.createdAt?.toDate() ?? new Date(),
    };
  });
}

export async function updateTextElement(
  boardId: string,
  elementId: string,
  updates: Partial<Pick<TextElement, "text" | "position" | "width" | "height" | "fontSize" | "color">>
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId, "textElements", elementId), updates);
}

export async function deleteTextElement(boardId: string, elementId: string): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId, "textElements", elementId));
}

export async function clearBoardTextElements(boardId: string): Promise<void> {
  const ref = collection(db, "boards", boardId, "textElements");
  const snapshot = await getDocs(ref);
  for (let i = 0; i < snapshot.docs.length; i += 500) {
    const batch = writeBatch(db);
    snapshot.docs.slice(i, i + 500).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}
