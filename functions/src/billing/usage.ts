import type { Firestore, Transaction } from "firebase-admin/firestore";
import { currentPeriod } from "../ai/usage";

// Plan metering (M5). Boards and sessions are gated by different plan limits
// (functions/src/billing/limits.ts) but they are metered with two different
// mechanisms on purpose:
//
//   - Boards are a STOCK (5 alive at once, freed by deletion): counted live
//     via a Firestore count() aggregation. There is no stored board counter —
//     a stored counter would drift on every delete and the gate would stop
//     matching reality.
//   - Sessions are a FLOW (3 per month, never freed): metered with a stored
//     monthly bucket at `workspaces/{id}/usage/{period}` that only ever
//     increments, mirroring the `aiUsage` counter in ai/usage.ts. Both are
//     Functions-only writes, locked in firestore.rules.

/** Persisted at `workspaces/{id}/usage/{period}`. Functions-only writes. */
export interface SessionUsageDoc {
  sessions: number;
  updatedAt: number;
}

/** Pure increment, split out so it unit-tests without Firestore — mirrors the
 *  `applyUsage` split in ai/usage.ts. A non-numeric stored value resets to 0
 *  rather than producing NaN and silently disabling the gate. */
export function applySessionUsage(
  prev: SessionUsageDoc | undefined,
  now: number
): SessionUsageDoc {
  const current = typeof prev?.sessions === "number" && Number.isFinite(prev.sessions)
    ? prev.sessions
    : 0;
  return { sessions: current + 1, updatedAt: now };
}

/** The doc ref for a workspace's session-usage period bucket. Exported so
 *  callers that must read-then-write inside one transaction (Task 6's session
 *  create) resolve the same path this module uses internally, rather than
 *  re-typing `workspaces/{id}/usage/{period}` by hand — the one string that
 *  must also agree with firestore.rules' `match /usage/{period}` block. */
export function sessionUsageRef(db: Firestore, workspaceId: string, now: number) {
  return db.doc(`workspaces/${workspaceId}/usage/${currentPeriod(now)}`);
}

/** Boards are a STOCK: live aggregation, so deleting a board frees a slot with
 *  no decrement path to get wrong. Filters on `workspaceId`, which excludes
 *  legacy (pre-Phase-2) boards that have none — by design: an unattributed
 *  board can't honestly be charged against a workspace's cap. This under-counts
 *  a workspace holding legacy boards until the M3 workspaceId migration cuts
 *  over, and self-heals then, since every new board is created with a
 *  workspaceId already stamped in. */
export async function countBoards(db: Firestore, workspaceId: string): Promise<number> {
  const snap = await db
    .collection("boards")
    .where("workspaceId", "==", workspaceId)
    .count()
    .get();
  return snap.data().count;
}

/** Sessions are a FLOW: monthly bucket, increment-only. `Number.isFinite`
 *  (not `typeof === "number"`) guards the stored value: `NaN` is a legal
 *  Firestore double and `typeof NaN === "number"`, so a `typeof`-only check
 *  would return `NaN` verbatim on a corrupt/half-written doc — and a
 *  downstream `count >= limit` gate evaluates `NaN >= 3` as `false`, granting
 *  unlimited sessions. Mirrors the same guard in `applySessionUsage` above. */
export async function readSessionCount(
  db: Firestore,
  workspaceId: string,
  now: number
): Promise<number> {
  const snap = await sessionUsageRef(db, workspaceId, now).get();
  const data = snap.exists ? (snap.data() as SessionUsageDoc) : undefined;
  const sessions = data?.sessions;
  return typeof sessions === "number" && Number.isFinite(sessions) ? sessions : 0;
}

/** Must run inside the same transaction as the session create so the count can
 *  never drift from the documents it counts. `prev` is REQUIRED and must come
 *  from `tx.get(sessionUsageRef(db, workspaceId, now))` inside that same
 *  transaction — never from `readSessionCount`, which reads via `db` outside
 *  any transaction and would let a concurrent increment get silently lost.
 *  `tx.set` fully overwrites the period doc (no `merge: true`): this function
 *  owns the doc's entire shape (`{sessions, updatedAt}`), so a future field
 *  added to the same doc by another writer would need its own read-modify-
 *  write here, not a blind merge that could mask a real conflict. */
export function incrementSessionCount(
  tx: Transaction,
  db: Firestore,
  workspaceId: string,
  now: number,
  prev: SessionUsageDoc | undefined
): void {
  tx.set(sessionUsageRef(db, workspaceId, now), applySessionUsage(prev, now));
}
