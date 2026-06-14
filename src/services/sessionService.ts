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
  arrayUnion,
  Timestamp,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { Session } from "../types";
import { randomCode } from "../lib/secureRandom";
import { assertQuota } from "./quotaService";

const sessionsRef = collection(db, "sessions");

// Excludes ambiguous glyphs (I/O/0/1) so codes read aloud unambiguously.
const JOIN_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateJoinCode(): string {
  return `SESS-${randomCode(6, JOIN_CODE_CHARS)}`;
}

function mapSession(id: string, data: any): Session {
  return {
    id,
    // "" marks a legacy/unmigrated session (see Session.workspaceId); readers below
    // treat it as belonging to the active workspace during the migration window.
    workspaceId: data.workspaceId ?? "",
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
    joinCode: data.joinCode,
    summary: data.summary,
    canvasSnapshot: data.canvasSnapshot,
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

export async function createSession(
  data: Omit<Session, "id" | "createdAt">
): Promise<string> {
  await assertQuota(data.workspaceId, "session");
  const { summary, joinCode: _jc, ...rest } = data;
  const payload: Record<string, any> = {
    ...rest,
    joinCode: generateJoinCode(),
    scheduledAt: Timestamp.fromDate(rest.scheduledAt),
    createdAt: serverTimestamp(),
  };
  if (summary !== undefined) payload.summary = summary;
  const ref = await addDoc(sessionsRef, payload);
  return ref.id;
}

export async function joinSessionByCode(
  code: string,
  userId: string
): Promise<{ sessionId: string; alreadyJoined: boolean } | null> {
  const q = query(sessionsRef, where("joinCode", "==", code.trim().toUpperCase()));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const sessionDoc = snap.docs[0];
  const data = sessionDoc.data();
  if ((data.participantIds ?? []).includes(userId) || data.createdById === userId) {
    return { sessionId: sessionDoc.id, alreadyJoined: true };
  }
  await updateDoc(sessionDoc.ref, { participantIds: arrayUnion(userId) });
  return { sessionId: sessionDoc.id, alreadyJoined: false };
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const snap = await getDoc(doc(db, "sessions", sessionId));
  if (!snap.exists()) return null;
  return mapSession(snap.id, snap.data());
}

export async function getSessionsByBoard(boardId: string): Promise<Session[]> {
  const q = query(
    sessionsRef,
    where("boardId", "==", boardId),
    orderBy("scheduledAt", "asc")
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => mapSession(d.id, d.data()));
}

/** Returns all sessions the user created or was invited to (deduped, sorted desc by scheduledAt). */
export async function getSessionsForUser(userId: string): Promise<Session[]> {
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

/** Alias used by week-6 schedule screen. */
export const getUserSessions = getSessionsForUser;

// Migration-tolerant workspace scoping (Phase 4), mirroring boardService.inWorkspace.
// A session matches when it's in the active workspace OR is still unscoped (legacy,
// pre-Phase-9-backfill). Filtering client-side rather than adding a compound
// `where('workspaceId','==',ws)` avoids silently dropping legacy sessions before the
// backfill runs and avoids a new composite index mid-migration. Access itself is
// enforced by the security rules; this filter is list scoping only.
// TODO(phase-9-cutover): drop the `!s.workspaceId` legacy clause once the migration
// has backfilled every session and the soak window closes.
function inWorkspace(workspaceId: string | undefined) {
  return (s: Session) => !workspaceId || s.workspaceId === workspaceId || !s.workspaceId;
}

/** Returns upcoming sessions (scheduledAt >= now) for the given user, optionally scoped to a workspace. Used by the boards index. */
export async function getUpcomingSessions(
  userId: string,
  workspaceId?: string
): Promise<Session[]> {
  const now = Timestamp.fromDate(new Date());

  const [createdQuery, participantQuery] = await Promise.all([
    getDocs(
      query(
        sessionsRef,
        where("createdById", "==", userId),
        where("scheduledAt", ">=", now),
        orderBy("scheduledAt", "asc")
      )
    ),
    getDocs(
      query(
        sessionsRef,
        where("participantIds", "array-contains", userId),
        where("scheduledAt", ">=", now),
        orderBy("scheduledAt", "asc")
      )
    ),
  ]);

  const sessionMap = new Map<string, Session>();
  for (const d of createdQuery.docs) {
    sessionMap.set(d.id, mapSession(d.id, d.data()));
  }
  for (const d of participantQuery.docs) {
    if (!sessionMap.has(d.id)) {
      sessionMap.set(d.id, mapSession(d.id, d.data()));
    }
  }

  return Array.from(sessionMap.values())
    .filter(inWorkspace(workspaceId))
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
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

export async function updateSessionStatus(
  sessionId: string,
  status: Session["status"]
): Promise<void> {
  await updateDoc(doc(db, "sessions", sessionId), { status });
}

export async function updateSessionSnapshot(
  sessionId: string,
  dataUrl: string
): Promise<void> {
  await updateDoc(doc(db, "sessions", sessionId), { canvasSnapshot: dataUrl });
}

export async function updateSessionSummary(
  sessionId: string,
  summary: string
): Promise<void> {
  await updateDoc(doc(db, "sessions", sessionId), { summary });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await deleteDoc(doc(db, "sessions", sessionId));
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
