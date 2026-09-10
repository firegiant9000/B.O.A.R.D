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

function usageRef(db: Firestore, workspaceId: string, now: number) {
  return db.doc(`workspaces/${workspaceId}/usage/${currentPeriod(now)}`);
}

/** Boards are a STOCK: live aggregation, so deleting a board frees a slot with
 *  no decrement path to get wrong. */
export async function countBoards(db: Firestore, workspaceId: string): Promise<number> {
  const snap = await db
    .collection("boards")
    .where("workspaceId", "==", workspaceId)
    .count()
    .get();
  return snap.data().count;
}

/** Sessions are a FLOW: monthly bucket, increment-only. */
export async function readSessionCount(
  db: Firestore,
  workspaceId: string,
  now: number
): Promise<number> {
  const snap = await usageRef(db, workspaceId, now).get();
  const data = snap.exists ? (snap.data() as SessionUsageDoc) : undefined;
  return typeof data?.sessions === "number" ? data.sessions : 0;
}

/** Must run inside the same transaction as the session create so the count can
 *  never drift from the documents it counts. */
export function incrementSessionCount(
  tx: Transaction,
  db: Firestore,
  workspaceId: string,
  now: number,
  prev: SessionUsageDoc | undefined
): void {
  tx.set(usageRef(db, workspaceId, now), applySessionUsage(prev, now));
}
