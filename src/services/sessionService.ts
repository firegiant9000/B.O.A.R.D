import {
  collection,
  getDocs,
  getDoc,
  deleteDoc,
  updateDoc,
  doc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  arrayUnion,
  Timestamp,
  QueryConstraint,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../config/firebase";
import { Plan, Session, SessionSummary, ParticipantSnapshot } from "../types";
import { assertQuota } from "./quotaService";
import { getUsersByIds } from "./friendService";

const sessionsRef = collection(db, "sessions");

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
    // Phase 4 lifecycle fields — all optional, so legacy docs map to undefined.
    agenda: data.agenda,
    startedAt: data.startedAt?.toDate(),
    endedAt: data.endedAt?.toDate(),
    participants: data.participants,
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

interface CreateSessionResponse {
  sessionId: string;
  joinCode: string;
}

/**
 * Since M5: this function creates sessions through the `createSession`
 * callable rather than writing the session doc directly, so every session is
 * capped and gets a server-generated join code. firestore.rules now denies
 * client session creates outright, so the callable is the only create path — a
 * patched client or a raw REST call cannot go around it. The client signature
 * here is unchanged so every call site keeps working untouched.
 *
 * `scheduledAt` doesn't survive the callable boundary as a `Date`, so it's
 * converted to epoch milliseconds here; the function rebuilds the `Timestamp`
 * server-side. Lifecycle fields (`summary`, `joinCode`, `startedAt`,
 * `endedAt`, `participants`) aren't sent — they're either stamped server-side
 * at create (`joinCode`, and `startedAt` when `status` is "active") or only
 * ever set later, by `startSession`/`endSession`/`updateSessionSummary`.
 *
 * `quota` is the advisory pre-flight's real plan/count (see quotaService's
 * module header): optional and additive, so every pre-existing call keeps
 * working untouched. `currentCount` has no honest value to pass yet — the
 * authoritative monthly count lives in an owner/admin-gated Firestore doc
 * (see the module header note on `assertQuota`) — so this only ever forwards
 * `plan` today; a caller that also has a trustworthy count may pass it.
 */
export async function createSession(
  data: Omit<Session, "id" | "createdAt">,
  quota?: { plan?: Plan; currentCount?: number }
): Promise<string> {
  await assertQuota(data.workspaceId, "session", quota?.plan, quota?.currentCount);

  const fn = httpsCallable<
    {
      workspaceId: string;
      boardId: string;
      boardTitle?: string;
      title: string;
      description?: string;
      scheduledAtMs: number;
      durationMinutes: number;
      createdByName?: string;
      participantIds?: string[];
      status?: Session["status"];
      agenda?: string;
    },
    CreateSessionResponse
  >(functions, "createSession");

  const { data: res } = await fn({
    workspaceId: data.workspaceId,
    boardId: data.boardId,
    boardTitle: data.boardTitle,
    title: data.title,
    description: data.description,
    scheduledAtMs: data.scheduledAt.getTime(),
    durationMinutes: data.durationMinutes,
    createdByName: data.createdByName,
    participantIds: data.participantIds,
    status: data.status,
    agenda: data.agenda,
  });
  return res.sessionId;
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

// ── Phase 5 session history ───────────────────────────────────────────────────

const ENDED_PAGE_SIZE = 20;

export interface EndedSessionsPage {
  sessions: Session[];
  hasMore: boolean;
  /** scheduledAt of the last returned session; pass back as `before` to page. */
  nextCursor: Date | null;
}

/**
 * Phase 5: paginated history of the user's ended sessions, scoped to a workspace.
 *
 * Bounded cost (roadmap risk row): each underlying query (sessions the user
 * created / was invited to) is capped at `pageSize`, so a page reads at most
 * 2·pageSize docs — never the whole history. We page on a `scheduledAt` cursor
 * (`before`) rather than a doc-snapshot `startAfter` because the two queries are
 * merged client-side and can't share a single Firestore cursor. Migration-tolerant
 * workspace scoping mirrors `getUpcomingSessions` (legacy unscoped sessions kept).
 *
 * Edge case: sessions sharing an identical `scheduledAt` at a page boundary can be
 * skipped by the strict `<` cursor — acceptable for v1 (ms collisions are rare).
 */
export async function getEndedSessions(
  userId: string,
  opts: { workspaceId?: string; pageSize?: number; before?: Date } = {}
): Promise<EndedSessionsPage> {
  const pageSize = opts.pageSize ?? ENDED_PAGE_SIZE;
  const cursorTs = opts.before ? Timestamp.fromDate(opts.before) : null;

  const buildQuery = (match: ReturnType<typeof where>) => {
    const clauses: QueryConstraint[] = [match, where("status", "==", "ended")];
    if (cursorTs) clauses.push(where("scheduledAt", "<", cursorTs));
    clauses.push(orderBy("scheduledAt", "desc"), limit(pageSize));
    return getDocs(query(sessionsRef, ...clauses));
  };

  const [asCreator, asParticipant] = await Promise.all([
    buildQuery(where("createdById", "==", userId)),
    buildQuery(where("participantIds", "array-contains", userId)),
  ]);

  const seen = new Set<string>();
  const merged: Session[] = [];
  for (const snap of [asCreator, asParticipant]) {
    snap.docs.forEach((d) => {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        merged.push(mapSession(d.id, d.data()));
      }
    });
  }

  const scoped = merged
    .filter(inWorkspace(opts.workspaceId))
    .sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime());

  // Either query hitting its limit means there may be older sessions past this page.
  const eitherFull = asCreator.docs.length === pageSize || asParticipant.docs.length === pageSize;
  const page = scoped.slice(0, pageSize);
  const hasMore = eitherFull || scoped.length > pageSize;

  return {
    sessions: page,
    hasMore,
    nextCursor: page.length > 0 ? page[page.length - 1].scheduledAt : null,
  };
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

// ── Phase 4 lifecycle transitions ─────────────────────────────────────────────
// Two explicit transitions own the lifecycle so timer/recap fields stay consistent
// regardless of which surface (schedule tab, board screen, session screen) triggers
// them. Activity-feed emission stays at the call site (it needs actor identity the
// service doesn't carry) but always pairs with endSession.

/** scheduled → active. Stamps `startedAt` so the in-session elapsed timer has an
 *  anchor that survives reloads. */
export async function startSession(sessionId: string): Promise<void> {
  await updateDoc(doc(db, "sessions", sessionId), {
    status: "active",
    startedAt: serverTimestamp(),
  });
}

/** active → ended. Stamps `endedAt`, and optionally freezes the participant snapshot
 *  and the final canvas image in the same write so the recap is self-contained. */
export async function endSession(
  sessionId: string,
  opts: { participants?: ParticipantSnapshot[]; snapshot?: string | null } = {}
): Promise<void> {
  const payload: Record<string, any> = {
    status: "ended",
    endedAt: serverTimestamp(),
  };
  if (opts.participants) payload.participants = opts.participants;
  if (opts.snapshot) payload.canvasSnapshot = opts.snapshot;
  await updateDoc(doc(db, "sessions", sessionId), payload);
}

/** Resolves the creator + every invited participant into a frozen name/email
 *  snapshot for `endSession`. The creator is included first and deduped against the
 *  participant list. Falls back to the denormalized createdByName if the creator's
 *  user doc can't be read. */
export async function resolveParticipantSnapshot(
  session: Pick<Session, "createdById" | "createdByName" | "participantIds">
): Promise<ParticipantSnapshot[]> {
  const ids = Array.from(
    new Set([session.createdById, ...session.participantIds].filter(Boolean))
  );
  const profiles = await getUsersByIds(ids);
  const byId = new Map(profiles.map((p) => [p.uid, p]));
  return ids.map((uid) => {
    const p = byId.get(uid);
    if (p) return { uid: p.uid, displayName: p.displayName, email: p.email };
    // Creator fallback if their doc was unreadable; otherwise a bare uid record.
    return {
      uid,
      displayName: uid === session.createdById ? session.createdByName || "Unknown" : "Unknown",
      email: "",
    };
  });
}

export async function updateSessionSnapshot(
  sessionId: string,
  dataUrl: string
): Promise<void> {
  await updateDoc(doc(db, "sessions", sessionId), { canvasSnapshot: dataUrl });
}

export async function updateSessionSummary(
  sessionId: string,
  summary: string | SessionSummary
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
