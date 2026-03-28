import {
  doc,
  setDoc,
  collection,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../config/firebase";

/**
 * Writes (or updates) a presence document for the given user under the board's
 * presence subcollection. Uses merge so we never overwrite unrelated fields.
 */
export async function updatePresence(
  boardId: string,
  userId: string
): Promise<void> {
  await setDoc(
    doc(db, "boards", boardId, "presence", userId),
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
