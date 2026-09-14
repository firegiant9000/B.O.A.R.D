import {
  doc,
  getDoc,
  collection,
  query,
  where,
  getCountFromServer,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { getAiUsage, periodFor } from "./aiUsageService";
import { limitFor, UNLIMITED } from "../lib/planLimits";
import type { Plan } from "../types";

// Month 5/6 — the usage dashboard's read path. Extends the M4 AI
// meter (aiUsageService.ts) with the other three plan resources: boards,
// sessions, and workspace headroom in general. UI components (app/ai-usage.tsx)
// call only this module, never Firestore directly (Global Constraint).
//
// Every number here is DISPLAY, not enforcement. The real gates are the
// Cloud Functions (createBoard.ts, createSession.ts) and firestore.rules —
// this module reads the same counters those gates read, or, for boards, the
// closest a client is permitted to get to them. That "closest" has one known
// gap after the workspace-migration backfill runs — see the long comment on
// `countWorkspaceBoards` below. Nothing in this module denies anything.

export interface Headroom {
  used: number;
  limit: number;
  remaining: number;
  fraction: number;
  unlimited: boolean;
}

/** Turns a used/limit pair into display-ready headroom. Every branch is
 *  written so `undefined`/`NaN` land on the safe side rather than producing
 *  `Infinity`/`NaN` for a screen to render (Global Constraint):
 *   - a non-finite `used` (a stray `NaN`, or a caller outside TypeScript's
 *     view passing `undefined`) reads as 0, not NaN.
 *   - `limit === UNLIMITED` (Infinity — PLAN_LIMITS' sentinel for Pro/Edu)
 *     is handled explicitly: `fraction` is pinned to 0 and `remaining` to
 *     `UNLIMITED` rather than computed, so nothing downstream can turn this
 *     into `Infinity/Infinity` (NaN) or `x/Infinity` (0, which would be
 *     accidentally correct here but is not a rule to lean on elsewhere).
 *   - a non-finite/non-positive `limit` that ISN'T the unlimited sentinel —
 *     `limitFor` can return `undefined` at runtime for a prototype-shaped
 *     plan string (e.g. "__proto__"; see planLimits.ts), despite its `number`
 *     return type — reads as "already at the limit" (fraction 1, remaining
 *     0) rather than dividing by zero/undefined into Infinity or NaN. This
 *     is a display surface, so "looks full" is the safe failure mode, not a
 *     crash and not "looks empty".
 */
export function toHeadroom(used: number, limit: number): Headroom {
  const safeUsed = typeof used === "number" && Number.isFinite(used) ? used : 0;

  if (limit === UNLIMITED) {
    return { used: safeUsed, limit, remaining: UNLIMITED, fraction: 0, unlimited: true };
  }

  const safeLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : 0;
  if (safeLimit === 0) {
    return { used: safeUsed, limit: safeLimit, remaining: 0, fraction: 1, unlimited: false };
  }

  const remaining = Math.max(safeLimit - safeUsed, 0);
  const fraction = Math.min(safeUsed / safeLimit, 1);
  return { used: safeUsed, limit: safeLimit, remaining, fraction, unlimited: false };
}

/** Live board count for `workspaceId`, as close as firestore.rules lets a
 *  client get to the SERVER'S enforcement query — `countBoards` in
 *  functions/src/billing/usage.ts: `where("workspaceId","==",workspaceId)
 *  .count()`, run with the Admin SDK, which bypasses rules entirely.
 *
 *  A client can't run that exact query. Cloud Firestore validates an
 *  aggregation query against the query's *potential* result set, not the
 *  documents actually in the database, so the whole request is rejected
 *  unless every document that COULD match is provably readable under
 *  firestore.rules. The board read rule is
 *  `ownerId==caller || caller in members || inviteCode != null`
 *  (firestore.rules `match /boards/{boardId}`) — a bare `workspaceId==X`
 *  filter proves none of those three for a caller who isn't personally a
 *  member of every board in the workspace, which is the ordinary case: any
 *  workspace member can create a board (createBoard only checks
 *  membership, not role) and the callable adds only the creator to
 *  `members`, so a workspace owner/admin viewing THIS dashboard is often
 *  not a member of boards their teammates created. Verified against the
 *  rules emulator: that bare filter throws permission-denied for exactly
 *  that shape of workspace.
 *
 *  Adding `where("inviteCode","!=",null)` lets Firestore prove the third
 *  rule branch directly from the query, so the request succeeds — also
 *  verified against the emulator. This does not change WHICH boards get
 *  counted for a board CREATED through the app: `boards/{boardId}` can only
 *  ever be created through the `createBoard` callable (firestore.rules:
 *  `allow create: if false` on a direct client write), and that callable
 *  always stamps a freshly generated `inviteCode` on every board it writes
 *  — no path in this app's own create/update flow ever clears it back to
 *  null afterward (the board `update` rule doesn't allow touching
 *  `inviteCode` at all).
 *
 *  There IS a real, non-hypothetical path to a `workspaceId`-set,
 *  `inviteCode`-null board, though: `scripts/migrate-workspaces.js` (the M3
 *  backfill — a pending gate, not run yet) stamps `workspaceId` onto every
 *  legacy board it finds (`b.ref.update({ workspaceId: wsId })`, in its
 *  boards-scan step) and never touches `inviteCode` — a legacy board with no invite code
 *  (`boardService.ts`'s own `mapBoard` defaults it to `""`, i.e. it can be
 *  genuinely absent) keeps that absence straight through the migration.
 *  After that backfill runs, such a board IS included in the server's
 *  `countBoards` (`workspaceId` alone) but NOT in this function's count —
 *  this dashboard UNDER-counts relative to real enforcement for exactly
 *  those boards, showing headroom the workspace doesn't actually have. This
 *  divergence is accepted, not fixed, here: the client provably cannot run
 *  the server's exact query (see above), reading the server's real count
 *  needs a new callable, and widening the read rule is out of scope for
 *  this module. `firestore-tests/firestore.rules.test.js` has a regression
 *  test seeding exactly this shape (`workspaceId` set, `inviteCode` null)
 *  and asserting this query's shape excludes it, so this divergence stays
 *  mechanically visible rather than resting on this comment alone.
 *
 *  This DOES mean the query is answerable by any signed-in user for any
 *  workspaceId, not just that workspace's owner/admin — the same is already
 *  true of reading a full board document with an inviteCode (the rule's
 *  comment calls that "an intentional public-lookup path"), so this adds no
 *  new exposure beyond a count of something already individually readable.
 *  `app/ai-usage.tsx` still gates the page itself on `canViewUsage`.
 *
 *  Needs the matching composite index declared in firestore.indexes.json
 *  (`workspaceId` + `inviteCode`, both ascending) — an equality filter
 *  combined with a `!=` filter on a different field is not one Firestore
 *  indexes automatically. */
export async function countWorkspaceBoards(workspaceId: string): Promise<number> {
  const q = query(
    collection(db, "boards"),
    where("workspaceId", "==", workspaceId),
    where("inviteCode", "!=", null)
  );
  const snap = await getCountFromServer(q);
  return snap.data().count;
}

/** Reads the `sessions` counter off `workspaces/{id}/usage/{period}` — the
 *  doc `incrementSessionCount` (functions/src/billing/usage.ts) writes and
 *  `createSession`'s transaction reads to gate the plan's session cap.
 *  firestore.rules restricts this doc to workspace owner/admin, exactly the
 *  `canViewUsage` gate this page already applies — this module does not
 *  widen it.
 *
 *  Tolerant of a missing doc (a workspace with no sessions created yet this
 *  period) and, mirroring the Function's own `readSessionCount` guard, of a
 *  non-finite stored value: `NaN` is a legal Firestore double and
 *  `typeof NaN === "number"`, so a `typeof`-only check would read a
 *  corrupt/half-written doc back as `NaN` and poison every comparison
 *  downstream. Both default to 0. */
export async function readSessionUsage(workspaceId: string, period: string): Promise<number> {
  const snap = await getDoc(doc(db, "workspaces", workspaceId, "usage", period));
  const data = snap.exists() ? (snap.data() as Record<string, any> | undefined) : undefined;
  const sessions = data?.sessions;
  return typeof sessions === "number" && Number.isFinite(sessions) ? sessions : 0;
}

/** The workspace's own member count, read fresh (not passed in) so this
 *  module's four-resource contract holds from `workspaceId` alone. Used as
 *  the "used" figure for the collaborators-per-board limit: this page has
 *  no active board (it's a workspace-wide dashboard, reached from Profile
 *  with no boardId), so there is no single board to measure against. A
 *  workspace's member count is what determines how close ANY one board
 *  could get to the per-board cap if every member were added to it — a
 *  real, currently-true number, just not "this board's current
 *  collaborators". `app/ai-usage.tsx` labels the row accordingly rather
 *  than implying it is counting one board's actual membership. */
export async function countWorkspaceMembers(workspaceId: string): Promise<number> {
  const snap = await getDoc(doc(db, "workspaces", workspaceId));
  const data = snap.exists() ? (snap.data() as Record<string, any> | undefined) : undefined;
  const members = data?.members as Record<string, unknown> | undefined;
  return members ? Object.keys(members).length : 0;
}

export interface WorkspaceUsage {
  boards: Headroom;
  sessions: Headroom;
  aiCalls: Headroom;
  collaborators: Headroom;
}

/** All four plan resources' headroom for `workspaceId` on `plan`. The period
 *  for both the AI-usage read and the session-usage read comes from the
 *  SAME existing helper (`periodFor`, aiUsageService.ts) — never re-derived
 *  — so this always reads the doc the Functions side is writing this month
 *  (Global Constraint: monthly buckets have exactly one implementation).
 *
 *  Does NOT cover `workspaces` (the 5th `LimitedResource`), and the reason is
 *  scope rather than enforcement — that cap IS enforced now, by the
 *  `createWorkspace` callable (see quotaService.ts's module header). It counts
 *  workspaces the CALLER OWNS, so it is not a property of `workspaceId` at
 *  all, and there is no honest place for it in a function whose entire
 *  contract is "these resources, for this one workspace." `app/ai-usage.tsx`
 *  shows it as a plain note beside the metered rows instead. */
export async function getWorkspaceUsage(workspaceId: string, plan: Plan): Promise<WorkspaceUsage> {
  const period = periodFor();
  const [boardsUsed, sessionsUsed, aiUsage, membersUsed] = await Promise.all([
    countWorkspaceBoards(workspaceId),
    readSessionUsage(workspaceId, period),
    getAiUsage(workspaceId, period),
    countWorkspaceMembers(workspaceId),
  ]);

  return {
    boards: toHeadroom(boardsUsed, limitFor(plan, "boards")),
    sessions: toHeadroom(sessionsUsed, limitFor(plan, "sessionsPerPeriod")),
    aiCalls: toHeadroom(aiUsage.calls, limitFor(plan, "aiCallsPerPeriod")),
    collaborators: toHeadroom(membersUsed, limitFor(plan, "collaboratorsPerBoard")),
  };
}
