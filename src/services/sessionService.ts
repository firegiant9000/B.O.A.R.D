import {
  collection,
  addDoc,
  getDocs,
  updateDoc,
  doc,
  query,
  where,
  orderBy,
  serverTimestamp,
  getDoc,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { Session } from "../types";

function mapSession(id: string, data: any): Session {
  return {
    id,
    boardId: data.boardId,
    boardTitle: data.boardTitle ?? "",
    title: data.title,
    description: data.description ?? "",
    scheduledAt: data.scheduledAt?.toDate() ?? new Date(),
    durationMinutes: data.durationMinutes ?? 60,
    createdById: data.createdById,
    createdByName: data.createdByName ?? "",
    participantIds: data.participantIds ?? [],
    status: data.status ?? "scheduled",
    summary: data.summary,
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

export async function createSession(
  data: Omit<Session, "id" | "createdAt">
): Promise<string> {
  // Omit undefined fields — Firestore rejects them
  const { summary, ...rest } = data;
  const payload: Record<string, any> = { ...rest, createdAt: serverTimestamp() };
  if (summary !== undefined) payload.summary = summary;
  const ref = await addDoc(collection(db, "sessions"), payload);
  return ref.id;
}

export async function getSessionsForUser(userId: string): Promise<Session[]> {
  const sessionsRef = collection(db, "sessions");

  // Sessions created by the user
  const [asCreator, asParticipant] = await Promise.all([
    getDocs(
      query(
        sessionsRef,
        where("createdById", "==", userId),
        orderBy("scheduledAt", "desc")
      )
    ),
    getDocs(
      query(
        sessionsRef,
        where("participantIds", "array-contains", userId),
        orderBy("scheduledAt", "desc")
      )
    ),
  ]);

  const seen = new Set<string>();
  const sessions: Session[] = [];

  for (const snap of [asCreator, asParticipant]) {
    snap.docs.forEach((d) => {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        sessions.push(mapSession(d.id, d.data()));
      }
    });
  }

  return sessions.sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime());
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const snap = await getDoc(doc(db, "sessions", sessionId));
  if (!snap.exists()) return null;
  return mapSession(snap.id, snap.data());
}

export async function updateSessionStatus(
  sessionId: string,
  status: Session["status"]
): Promise<void> {
  await updateDoc(doc(db, "sessions", sessionId), { status });
}

export async function updateSessionSummary(
  sessionId: string,
  summary: string
): Promise<void> {
  await updateDoc(doc(db, "sessions", sessionId), { summary });
}

/** Returns the push tokens of all participants who have one stored. */
export async function getParticipantPushTokens(participantIds: string[]): Promise<string[]> {
  if (participantIds.length === 0) return [];

  const tokens: string[] = [];
  await Promise.all(
    participantIds.map(async (uid) => {
      const snap = await getDoc(doc(db, "users", uid));
      if (snap.exists()) {
        const token = snap.data().pushToken;
        if (token) tokens.push(token);
      }
    })
  );
  return tokens;
}
