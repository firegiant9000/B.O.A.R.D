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
  onSnapshot,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { DrawPath, TextNote, TextElement } from "../types";
import { Bounds, boundsOfPoints, inflateBounds } from "../lib/viewport";

// --- Draw Paths ---

/**
 * Board-space bbox of a stroke, inflated by half the rendered stroke width so a
 * thick line is never clipped by viewport culling. Eraser strokes render at
 * strokeWidth + 10 (see DrawingCanvas), so they inflate to match. Returns null
 * for an empty point set.
 */
function computePathBbox(
  points: { x: number; y: number }[],
  strokeWidth: number,
  tool: DrawPath["tool"]
): Bounds | null {
  const bounds = boundsOfPoints(points);
  if (!bounds) return null;
  const rendered = tool === "eraser" ? strokeWidth + 10 : strokeWidth;
  return inflateBounds(bounds, rendered / 2);
}

export async function savePath(
  boardId: string,
  path: Omit<DrawPath, "id" | "createdAt">
): Promise<string> {
  const pathsRef = collection(db, "boards", boardId, "paths");
  // Recompute bbox at write time from the (already-simplified) points so every
  // call site — strokes, dots, redo — persists a current box regardless of what
  // the caller passed.
  const bbox = computePathBbox(path.points, path.strokeWidth, path.tool);
  const docRef = await addDoc(pathsRef, {
    ...path,
    ...(bbox ? { bbox } : {}),
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
      const strokeWidth = data.strokeWidth ?? 5;
      const tool = data.tool as "pen" | "eraser";
      return {
        id: d.id,
        boardId: data.boardId ?? "",
        userId: data.userId ?? "",
        points: data.points,
        color: data.color,
        strokeWidth,
        tool,
        // Legacy docs predate bbox — compute it on read so Phase 4 culling
        // can treat every stroke uniformly.
        bbox: data.bbox ?? computePathBbox(data.points, strokeWidth, tool) ?? undefined,
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

// --- Real-time subscriptions ---

export function subscribeToBoardPaths(
  boardId: string,
  onChange: (paths: DrawPath[]) => void,
  // Phase 6: optional connectivity reporter. When supplied, the listener opts into
  // metadata changes so it can surface fromCache / hasPendingWrites for the offline
  // banner. Omitting it preserves the original (data-only) subscription behavior.
  onSyncState?: (meta: { fromCache: boolean; hasPendingWrites: boolean }) => void
): () => void {
  const q = query(collection(db, "boards", boardId, "paths"), orderBy("createdAt", "asc"));
  const handle = (snapshot: any) => {
    if (onSyncState) {
      onSyncState({
        fromCache: snapshot.metadata.fromCache,
        hasPendingWrites: snapshot.metadata.hasPendingWrites,
      });
    }
    const paths = snapshot.docs
      .map((d: any) => {
        const data = d.data();
        if (!data.points || !data.color || !data.tool) return null;
        const strokeWidth = data.strokeWidth ?? 5;
        const tool = data.tool as "pen" | "eraser";
        return {
          id: d.id,
          boardId: data.boardId ?? "",
          userId: data.userId ?? "",
          points: data.points,
          color: data.color,
          strokeWidth,
          tool,
          // Legacy docs predate bbox — compute it on read so Phase 4 culling
          // can treat every stroke uniformly.
          bbox: data.bbox ?? computePathBbox(data.points, strokeWidth, tool) ?? undefined,
          createdAt: data.createdAt?.toDate() ?? new Date(),
        };
      })
      .filter((p: any): p is NonNullable<typeof p> => p !== null);
    onChange(paths);
  };
  // includeMetadataChanges only when a reporter wants fromCache/pendingWrites
  // transitions; otherwise the original single-arg listener.
  return onSyncState
    ? onSnapshot(q, { includeMetadataChanges: true }, handle)
    : onSnapshot(q, handle);
}

export function subscribeToBoardNotes(
  boardId: string,
  onChange: (notes: TextNote[]) => void
): () => void {
  const q = query(collection(db, "boards", boardId, "notes"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snapshot) => {
    const notes = snapshot.docs
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
    onChange(notes);
  });
}

export function subscribeToBoardTextElements(
  boardId: string,
  onChange: (elements: TextElement[]) => void
): () => void {
  const q = query(collection(db, "boards", boardId, "textElements"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snapshot) => {
    const elements = snapshot.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        boardId: data.boardId ?? "",
        userId: data.userId ?? "",
        text: data.text ?? "",
        position: data.position,
        width: data.width,
        height: data.height,
        fontSize: data.fontSize,
        color: data.color,
        createdAt: data.createdAt?.toDate() ?? new Date(),
      };
    });
    onChange(elements);
  });
}
