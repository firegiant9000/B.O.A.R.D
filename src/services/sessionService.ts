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
  Timestamp,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { Session } from "../types";

const sessionsRef = collection(db, "sessions");

function docToSession(id: string, data: Record<string, any>): Session {
  return {
    id,
    boardId: data.boardId,
    title: data.title,
    description: data.description ?? "",
    scheduledAt: data.scheduledAt?.toDate() ?? new Date(),
    durationMinutes: data.durationMinutes,
    createdById: data.createdById,
    participantIds: data.participantIds ?? [],
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

export async function createSession(
  session: Omit<Session, "id" | "createdAt">
): Promise<string> {
  const docRef = await addDoc(sessionsRef, {
    ...session,
    scheduledAt: Timestamp.fromDate(session.scheduledAt),
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const docSnap = await getDoc(doc(db, "sessions", sessionId));
  if (!docSnap.exists()) return null;
  return docToSession(docSnap.id, docSnap.data());
}

export async function getSessionsByBoard(boardId: string): Promise<Session[]> {
  const q = query(
    sessionsRef,
    where("boardId", "==", boardId),
    orderBy("scheduledAt", "asc")
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => docToSession(d.id, d.data()));
}

export async function getUserSessions(userId: string): Promise<Session[]> {
  // Firestore doesn't support OR across different fields, so run two queries
  const [createdQuery, participantQuery] = await Promise.all([
    getDocs(
      query(
        sessionsRef,
        where("createdById", "==", userId),
        orderBy("scheduledAt", "asc")
      )
    ),
    getDocs(
      query(
        sessionsRef,
        where("participantIds", "array-contains", userId),
        orderBy("scheduledAt", "asc")
      )
    ),
  ]);

  const sessionMap = new Map<string, Session>();
  for (const d of createdQuery.docs) {
    sessionMap.set(d.id, docToSession(d.id, d.data()));
  }
  for (const d of participantQuery.docs) {
    if (!sessionMap.has(d.id)) {
      sessionMap.set(d.id, docToSession(d.id, d.data()));
    }
  }

  return Array.from(sessionMap.values()).sort(
    (a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()
  );
}

export async function getUpcomingSessions(
  userId: string
): Promise<Session[]> {
  const now = new Date();
  const sessions = await getUserSessions(userId);
  return sessions.filter((s) => s.scheduledAt >= now);
}

export async function updateSession(
  sessionId: string,
  data: Partial<Omit<Session, "id" | "createdAt">>
): Promise<void> {
  const updateData: Record<string, any> = { ...data };
  if (data.scheduledAt) {
    updateData.scheduledAt = Timestamp.fromDate(data.scheduledAt);
  }
  await updateDoc(doc(db, "sessions", sessionId), updateData);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await deleteDoc(doc(db, "sessions", sessionId));
}
