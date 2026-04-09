import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { BoardPresence } from "../types";

function presenceRef(boardId: string, userId: string) {
  return doc(db, "boards", boardId, "presence", userId);
}

export async function joinBoard(
  boardId: string,
  userId: string,
  displayName: string,
  email: string
): Promise<void> {
  await setDoc(presenceRef(boardId, userId), {
    userId,
    displayName,
    email,
    lastSeen: serverTimestamp(),
  });
}

export async function leaveBoard(boardId: string, userId: string): Promise<void> {
  await deleteDoc(presenceRef(boardId, userId));
}

export function subscribeToBoardPresence(
  boardId: string,
  callback: (presence: BoardPresence[]) => void
): Unsubscribe {
  return onSnapshot(collection(db, "boards", boardId, "presence"), (snap) => {
    const presence: BoardPresence[] = snap.docs.map((d) => {
      const data = d.data();
      return {
        userId: data.userId,
        displayName: data.displayName,
        email: data.email,
        lastSeen: data.lastSeen?.toDate() ?? new Date(),
      };
    });
    callback(presence);
  });
}

/**
 * Simple heartbeat-style presence update (writes lastActive timestamp).
 * Used by the useBoardPresence hook for periodic pings.
 */
export async function updatePresence(
  boardId: string,
  userId: string
): Promise<void> {
  await setDoc(
    presenceRef(boardId, userId),
    { lastSeen: serverTimestamp() },
    { merge: true }
  );
}

/**
 * Real-time listener returning a simple uid → lastActive map.
 * Used by the useBoardPresence hook for online/offline detection.
 */
export function subscribeToPresence(
  boardId: string,
  callback: (presenceMap: Record<string, Date>) => void
): () => void {
  return onSnapshot(collection(db, "boards", boardId, "presence"), (snap) => {
    const map: Record<string, Date> = {};
    snap.docs.forEach((d) => {
      const ts = d.data().lastSeen;
      if (ts) map[d.id] = ts.toDate();
    });
    callback(map);
  });
}
