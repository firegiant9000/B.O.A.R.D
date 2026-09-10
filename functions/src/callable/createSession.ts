import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { generateInviteCode } from "./createBoard";
import { limitFor, type Plan } from "../billing/limits";
import {
  readSessionCount,
  incrementSessionCount,
  sessionUsageRef,
  type SessionUsageDoc,
} from "../billing/usage";

// Month 5 — session creation is server-side so the free-tier monthly session
// cap (functions/src/billing/limits.ts) can't be bypassed by a patched client or
// a raw REST call. Sessions are a FLOW (3/month, never freed) metered with a
// stored monthly counter (functions/src/billing/usage.ts) rather than a live
// count, so the counter bump and the session write happen inside one Firestore
// transaction — if they could diverge, the gate would be decorative.
//
// This is the ONLY create path: firestore.rules denies client session creates
// outright, and the Admin SDK write below bypasses rules. Two things depend on
// that — the monthly cap, and the join code, which a client create could
// otherwise choose for itself. It also makes this function load-bearing: it must
// be deployed before those rules, or session creation goes down (see the warning
// at the top of firestore.rules).

export interface CreateSessionRequest {
  workspaceId: string;
  boardId: string;
  title: string;
  scheduledAtMs: number;
  durationMinutes: number;
  boardTitle?: string;
  description?: string;
  createdByName?: string;
  participantIds?: string[];
  // "ended" deliberately excluded: a session is never created already ended
  // (only startSession/endSession transition it there), and the handler
  // below collapses anything but "active" to "scheduled" — this type should
  // not advertise a value that would silently be dropped.
  status?: "scheduled" | "active";
  agenda?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  joinCode: string;
}

// Bounds on client-supplied input, applied fail-closed (clamp/filter, not
// trust) before anything is written. None of these are business-meaningful
// limits — they exist so a client can't blow past a Firestore document-size
// limit or feed garbage into the user-lookup/notification paths downstream
// of `participantIds`.
const MAX_TITLE_LENGTH = 200;
const MAX_NAME_LENGTH = 200;
const MAX_TEXT_LENGTH = 4000;
const MAX_PARTICIPANTS = 100;
// A generous absolute calendar window (not relative to `now`, so a session
// scheduled further out than "now" doesn't false-positive): rejects garbage
// like `1e18` before it reaches `Timestamp.fromMillis`, which would otherwise
// throw a `RangeError` that surfaces as an opaque `internal` error instead of
// a clean `invalid-argument`.
const MIN_SCHEDULED_AT_MS = Date.UTC(2000, 0, 1);
const MAX_SCHEDULED_AT_MS = Date.UTC(2100, 0, 1);

function clampString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function sanitizeParticipantIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, MAX_PARTICIPANTS);
}

/** One decision (the negated "provably under" comparison), applied to two
 *  different `used` values by the two call sites below — the fail-fast
 *  pre-check and the authoritative in-transaction re-check. Extracted so the
 *  `__proto__`-safe comparison form can't drift between them: if this lived
 *  as two copies and one were later "simplified" to `used >= limit`, that
 *  copy would reopen the `PLAN_LIMITS["__proto__"] === Object.prototype`
 *  fail-open (see createBoard.ts), and each test layer covers only its own
 *  copy, so the regression could go unnoticed by the other. `limitFor` can
 *  return `undefined` for a prototype-shaped plan value, and `used` could in
 *  principle be non-finite; `!(used < limit)` denies on both, with no extra
 *  branch needed for UNLIMITED (`Infinity`) — `used < Infinity` is simply
 *  always true for a finite `used`. */
function assertUnderSessionCap(used: number, plan: Plan): void {
  const limit = limitFor(plan, "sessionsPerPeriod");
  if (!(used < limit)) {
    throw new HttpsError(
      "resource-exhausted",
      `You've reached your plan's session limit (${limit}) for this period. Upgrade for more.`
    );
  }
}

/** Injected so the handler unit-tests without Firestore, matching
 *  handleCreateBoard's pattern (functions/src/callable/createBoard.ts).
 *  `runCreate` is the transactional core: it re-reads the usage doc,
 *  re-checks the limit against that fresh read, and writes the session +
 *  bumps the counter in one transaction. `readSessionCount` is only used for
 *  a fail-fast pre-check outside any transaction — a concurrent create right
 *  at the boundary is caught by the re-check inside `runCreate`, not by
 *  this one. */
export interface CreateSessionDeps {
  getWorkspace(
    workspaceId: string
  ): Promise<{ plan?: string; members?: Record<string, string> } | null>;
  readSessionCount(workspaceId: string, now: number): Promise<number>;
  runCreate(
    workspaceId: string,
    sessionDoc: Record<string, unknown>,
    now: number,
    plan: Plan
  ): Promise<CreateSessionResponse>;
}

export async function handleCreateSession(
  req: CallableRequest<CreateSessionRequest>,
  deps: CreateSessionDeps,
  now: number
): Promise<CreateSessionResponse> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to create a session.");

  const data = (req.data ?? {}) as Partial<CreateSessionRequest>;
  const { workspaceId, boardId, title, scheduledAtMs, durationMinutes } = data;

  if (!workspaceId) throw new HttpsError("invalid-argument", "workspaceId is required.");
  if (!boardId) throw new HttpsError("invalid-argument", "boardId is required.");
  if (!title || !title.trim()) {
    throw new HttpsError("invalid-argument", "A session title is required.");
  }
  if (
    typeof scheduledAtMs !== "number" ||
    !Number.isFinite(scheduledAtMs) ||
    scheduledAtMs < MIN_SCHEDULED_AT_MS ||
    scheduledAtMs > MAX_SCHEDULED_AT_MS
  ) {
    throw new HttpsError("invalid-argument", "scheduledAtMs is required and must be a plausible date.");
  }
  if (
    typeof durationMinutes !== "number" ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0
  ) {
    throw new HttpsError("invalid-argument", "durationMinutes must be a positive number.");
  }

  const ws = await deps.getWorkspace(workspaceId);
  if (!ws) throw new HttpsError("not-found", "Workspace not found.");
  if (!ws.members || !(uid in ws.members)) {
    throw new HttpsError("permission-denied", "You are not a member of this workspace.");
  }

  const plan = (ws.plan ?? "free") as Plan;

  // Fail-fast pre-check outside any transaction, purely to avoid a pointless
  // round trip when we can already tell the caller no. Not authoritative —
  // `runCreate` re-reads the counter fresh inside its own transaction, and
  // that re-check is the only one that actually decides.
  const used = await deps.readSessionCount(workspaceId, now);
  assertUnderSessionCap(used, plan);

  const status: "scheduled" | "active" = data.status === "active" ? "active" : "scheduled";
  const sessionDoc: Record<string, unknown> = {
    workspaceId,
    boardId,
    boardTitle: clampString(data.boardTitle, MAX_TITLE_LENGTH),
    title: title.trim().slice(0, MAX_TITLE_LENGTH),
    description: clampString(data.description, MAX_TEXT_LENGTH),
    scheduledAt: Timestamp.fromMillis(scheduledAtMs),
    durationMinutes,
    // Derived from the auth token, never trusted from the client — mirrors
    // ownerId/adminId in handleCreateBoard, and matches what firestore.rules
    // already requires on the direct-write path (createdById == auth.uid).
    createdById: uid,
    createdByName: clampString(data.createdByName, MAX_NAME_LENGTH),
    participantIds: sanitizeParticipantIds(data.participantIds),
    status,
    createdAt: FieldValue.serverTimestamp(),
  };
  const agenda = typeof data.agenda === "string" ? data.agenda.trim() : "";
  if (agenda) {
    sessionDoc.agenda = agenda.slice(0, MAX_TEXT_LENGTH);
  }
  if (status === "active") {
    // Mirrors the prior client-side behavior: a session created already
    // "active" (the board's Start Session modal) anchors its elapsed timer
    // from now, rather than waiting for a later scheduled -> active transition.
    sessionDoc.startedAt = FieldValue.serverTimestamp();
  }

  // `sessionDoc` is built field-by-field above from validated/whitelisted
  // input — a client-supplied `joinCode` (or any other unexpected field) in
  // `req.data` never reaches it. The transactional core below generates its
  // own join code regardless, as defense in depth.
  return deps.runCreate(workspaceId, sessionDoc, now, plan);
}

/** The real transactional core, split out so it unit-tests against a fake
 *  Firestore-like object without the emulator. `prev` MUST come from
 *  `tx.get(sessionUsageRef(...))` inside this same transaction — never from
 *  `readSessionCount`, which reads outside any transaction and would let a
 *  concurrent increment get silently lost. All reads happen before any
 *  write: the single `tx.get` below is the transaction's only read, and it
 *  precedes both the session's `tx.set` and the counter's `tx.set` (inside
 *  `incrementSessionCount`). */
export function makeRunCreate(db: Firestore): CreateSessionDeps["runCreate"] {
  return (workspaceId, sessionDoc, now, plan) =>
    db.runTransaction(async (tx) => {
      const ref = sessionUsageRef(db, workspaceId, now);
      const snap = await tx.get(ref);
      const prev = snap.exists ? (snap.data() as SessionUsageDoc) : undefined;
      const used =
        typeof prev?.sessions === "number" && Number.isFinite(prev.sessions) ? prev.sessions : 0;
      // Same gate as the pre-flight above (see assertUnderSessionCap), re-run
      // against the value this transaction itself just read — this re-check
      // is what makes two concurrent creates at the boundary safe.
      assertUnderSessionCap(used, plan);

      const sessionRef = db.collection("sessions").doc();
      // Generated here, never taken from `sessionDoc`: a client cannot choose
      // its own join code. Imported from createBoard.ts rather than
      // reimplemented (same 6-char, 36-char-alphabet, rejection-sampled
      // generator boards already use).
      const joinCode = generateInviteCode();
      tx.set(sessionRef, { ...sessionDoc, joinCode });
      incrementSessionCount(tx, db, workspaceId, now, prev);

      return { sessionId: sessionRef.id, joinCode };
    });
}

export const createSession = onCall((req: CallableRequest<CreateSessionRequest>) => {
  const db = getFirestore();
  return handleCreateSession(
    req,
    {
      getWorkspace: async (id) => {
        const s = await db.doc(`workspaces/${id}`).get();
        return s.exists
          ? (s.data() as { plan?: string; members?: Record<string, string> })
          : null;
      },
      readSessionCount: (id, now) => readSessionCount(db, id, now),
      runCreate: makeRunCreate(db),
    },
    Date.now()
  );
});
