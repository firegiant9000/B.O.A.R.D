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
//
// Month 6 — THE WELCOME-SESSION GRANT (`welcomeSessionGrant` below). The
// onboarding seed (src/services/onboardingService.ts) hands every brand-new
// account a finished demo session, because ROADMAP.md:706 (A6) requires one.
// Created through the ordinary metered path, that demo spent 1 of the free
// plan's 3 monthly sessions on something the user never asked for — a 33% tax
// on the first month of exactly the users Month 6 exists to acquire, and not
// refundable, since the counter only ever increments.
//
// The fix lives HERE rather than beside this function on purpose. An Admin-SDK
// seed writing a session document directly would not touch the counter at all,
// and a second creation path is a second thing to keep in sync with the cap —
// which is the failure mode the seed's original "just pay the cap" choice was
// avoiding. So the grant is an extra branch of the one metered callable: when
// it applies, the transaction below skips `assertUnderSessionCap` and
// `incrementSessionCount` and instead marks the workspace as having spent it,
// all in the SAME transaction as the session write. Marker and un-metered
// create commit together or not at all, so two concurrent requests cannot both
// claim the grant.
//
// THE EXPOSURE, STATED HONESTLY. `welcomeSessionGrant` arrives in `req.data`,
// so a patched client can ask for it on an ordinary session and spend it there.
// Nothing about this flag is unreachable by a client, and nothing here pretends
// otherwise. What bounds it is the server-side marker: the grant is available
// only while `workspaces/{id}.welcomeSessionGrantUsed` is not `true`, and the
// transaction sets it the moment the grant is taken. The worst a patched client
// gets is ONE extra session per workspace, ever — 4 in some month instead of 3,
// once, on a workspace that will never get another. That is bounded, one-time
// and per-workspace, and far smaller than the alternative it replaced (an
// Admin-SDK bypass that skipped the counter on every seeded write with no
// marker to stop at one).
//
// The marker is only worth anything if a client cannot clear it: firestore.rules'
// `workspaces/{id}` update rule pins `welcomeSessionGrantUsed` in the same
// `hasAny([...])` list as `plan` and `ownerId`. Without that pin a client could
// set it back to `false` and re-claim the grant every month, turning a one-time
// allowance into an unlimited one — a worse leak than the tax it fixes. Do not
// relax this branch and that rule in isolation.

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
  /** Asks for the one-per-workspace welcome-session grant (see the module
   *  header). Only `onboardingService.seedSampleWorkspace` sets it, but it is
   *  client-supplied like every other field here — the bound on abuse is the
   *  server-side `welcomeSessionGrantUsed` marker, not this flag's origin. */
  welcomeSessionGrant?: boolean;
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
  ): Promise<{
    plan?: string;
    members?: Record<string, string>;
    welcomeSessionGrantUsed?: boolean;
  } | null>;
  readSessionCount(workspaceId: string, now: number): Promise<number>;
  runCreate(
    workspaceId: string,
    sessionDoc: Record<string, unknown>,
    now: number,
    plan: Plan,
    /** Whether the caller asked for the welcome-session grant. OPTIONAL, and
     *  deliberately last: every pre-existing call site and test passes four
     *  arguments and keeps its exact meaning, `undefined` being the ordinary
     *  metered path. It is a REQUEST, not a decision — `runCreate` re-reads the
     *  workspace inside its own transaction and decides there, exactly as it
     *  re-reads the usage counter rather than trusting the pre-flight. */
    welcomeSessionGrant?: boolean
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

  // Month 6 — the welcome-session grant (see the module header). Requested by
  // the client, decided by the server. This read of `welcomeSessionGrantUsed`
  // is only as fresh as the pre-flight `getWorkspace` above, which is exactly
  // why it decides nothing on its own: it governs whether the fail-fast cap
  // check below is worth running, and `runCreate` re-reads the same field
  // inside its transaction to make the real call. If this read is stale the
  // worst case is one pointless round trip to a transaction that meters
  // normally — never a second grant.
  const grantRequested = data.welcomeSessionGrant === true;
  const grantLikelyAvailable = grantRequested && ws.welcomeSessionGrantUsed !== true;

  if (!grantLikelyAvailable) {
    // Fail-fast pre-check outside any transaction, purely to avoid a pointless
    // round trip when we can already tell the caller no. Not authoritative —
    // `runCreate` re-reads the counter fresh inside its own transaction, and
    // that re-check is the only one that actually decides.
    const used = await deps.readSessionCount(workspaceId, now);
    assertUnderSessionCap(used, plan);
  }
  // Skipped on the grant path deliberately: the whole point is that a workspace
  // already AT its cap that has never been seeded is still seedable. Denying
  // here would defeat the grant before the transaction ever got to honour it.

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
    // ownerId/adminId in handleCreateBoard. There is no client create path to
    // agree with any more: firestore.rules denies session creates outright, so
    // this is the only place the field is ever set, and it is set from the token.
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
  // own join code regardless, as defense in depth. `welcomeSessionGrant` is
  // likewise NOT part of `sessionDoc`: it is a request about metering, not a
  // property of the session, and nothing should be able to read a session
  // document later and conclude it was free.
  return deps.runCreate(workspaceId, sessionDoc, now, plan, grantRequested);
}

/** The real transactional core, split out so it unit-tests against a fake
 *  Firestore-like object without the emulator. `prev` MUST come from
 *  `tx.get(sessionUsageRef(...))` inside this same transaction — never from
 *  `readSessionCount`, which reads outside any transaction and would let a
 *  concurrent increment get silently lost. All reads happen before any
 *  write: both `tx.get`s below are the transaction's only reads, and both
 *  precede the session's `tx.set`, the counter's `tx.set` (inside
 *  `incrementSessionCount`) and the grant marker's `tx.set`.
 *
 *  The grant (see the module header) is decided HERE, not by the caller, for
 *  the same reason the cap is: `welcomeSessionGrant` says what the caller
 *  ASKED for, and the workspace read inside this transaction says whether it
 *  is still there to take. Taking it writes `welcomeSessionGrantUsed: true` in
 *  this same transaction as the session, so the un-metered create and the
 *  record that it happened commit together or not at all — two concurrent
 *  requests cannot both observe the marker unset and both go un-metered, and a
 *  session can never exist having spent a grant the workspace doesn't show. */
export function makeRunCreate(db: Firestore): CreateSessionDeps["runCreate"] {
  return (workspaceId, sessionDoc, now, plan, welcomeSessionGrant) =>
    db.runTransaction(async (tx) => {
      const ref = sessionUsageRef(db, workspaceId, now);
      const snap = await tx.get(ref);
      const prev = snap.exists ? (snap.data() as SessionUsageDoc) : undefined;
      const used =
        typeof prev?.sessions === "number" && Number.isFinite(prev.sessions) ? prev.sessions : 0;

      // Read the workspace ONLY when the grant was actually asked for: an
      // ordinary create must not pay for a second document read it will never
      // look at. Still a transactional read, and still before every write.
      const workspaceRef = db.doc(`workspaces/${workspaceId}`);
      let useGrant = false;
      if (welcomeSessionGrant === true) {
        const wsSnap = await tx.get(workspaceRef);
        const wsData = wsSnap.exists
          ? (wsSnap.data() as { welcomeSessionGrantUsed?: unknown } | undefined)
          : undefined;
        // `!== true` rather than a falsy test, so only the literal boolean the
        // marker write below stores can withhold the grant; and `wsSnap.exists`
        // is required, so a workspace deleted between the handler's pre-flight
        // and this transaction falls back to the metered path instead of having
        // a marker `set` conjure the document back into existence.
        useGrant = wsSnap.exists && wsData?.welcomeSessionGrantUsed !== true;
      }

      // Same gate as the pre-flight above (see assertUnderSessionCap), re-run
      // against the value this transaction itself just read — this re-check
      // is what makes two concurrent creates at the boundary safe. Skipped
      // only on the grant path, which is the entire point of the grant: a
      // never-seeded workspace sitting at 3/3 must still get its demo session.
      if (!useGrant) {
        assertUnderSessionCap(used, plan);
      }

      const sessionRef = db.collection("sessions").doc();
      // Generated here, never taken from `sessionDoc`: a client cannot choose
      // its own join code. Imported from createBoard.ts rather than
      // reimplemented (same 6-char, 36-char-alphabet, rejection-sampled
      // generator boards already use).
      const joinCode = generateInviteCode();
      tx.set(sessionRef, { ...sessionDoc, joinCode });
      if (useGrant) {
        // `{ merge: true }` — unlike the usage doc, which `incrementSessionCount`
        // owns outright and therefore overwrites wholesale, this function owns
        // exactly one field of a document full of things it must not touch
        // (name, members, memberIds, plan, ownerId, sampleSeededAt). Merging is
        // mandatory here, not a convenience.
        tx.set(workspaceRef, { welcomeSessionGrantUsed: true }, { merge: true });
      } else {
        incrementSessionCount(tx, db, workspaceId, now, prev);
      }

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
          ? (s.data() as {
              plan?: string;
              members?: Record<string, string>;
              welcomeSessionGrantUsed?: boolean;
            })
          : null;
      },
      readSessionCount: (id, now) => readSessionCount(db, id, now),
      runCreate: makeRunCreate(db),
    },
    Date.now()
  );
});
