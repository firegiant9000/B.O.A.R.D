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
    lastActive: serverTimestamp(),
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
 * Writes (or updates) a presence document for the given user under the board's
 * presence subcollection. Uses merge so we never overwrite unrelated fields.
 */
export async function updatePresence(
  boardId: string,
  userId: string
): Promise<void> {
  await setDoc(
    presenceRef(boardId, userId),
    { lastActive: serverTimestamp() },
    { merge: true }
  );
}

/**
 * Opens a real-time listener on the board's presence subcollection.
 * Returns an unsubscribe function. The callback receives a map of
 * uid → lastActive Date each time any member's presence changes.
 */
export function subscribeToPresence(
  boardId: string,
  callback: (presenceMap: Record<string, Date>) => void
): () => void {
  const ref = collection(db, "boards", boardId, "presence");
  return onSnapshot(ref, (snapshot) => {
    const map: Record<string, Date> = {};
    snapshot.docs.forEach((d) => {
      const ts = d.data().lastActive;
      if (ts) map[d.id] = ts.toDate();
    });
    callback(map);
  });
}
