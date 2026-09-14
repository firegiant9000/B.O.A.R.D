import type { Firestore, Transaction } from "firebase-admin/firestore";
import { currentPeriod } from "../ai/usage";

// Plan metering (M5). Boards, sessions and workspaces are gated by different
// plan limits (functions/src/billing/limits.ts) but they are metered with
// different mechanisms on purpose:
//
//   - Boards are a STOCK (5 alive at once, freed by deletion): counted live
//     via a Firestore count() aggregation. There is no stored board counter —
//     a stored counter would drift on every delete and the gate would stop
//     matching reality.
//   - Sessions are a FLOW (3 per month, never freed): metered with a stored
//     monthly bucket at `workspaces/{id}/usage/{period}` that only ever
//     increments, mirroring the `aiUsage` counter in ai/usage.ts. Both are
//     Functions-only writes, locked in firestore.rules.
//   - Workspaces are a STOCK like boards, but scoped to an OWNER rather than
//     to a containing workspace — they are the one capped resource with no
//     container to scope to. That difference also means the counter cannot use
//     count(): the gate has to learn the caller's plan from the same read (see
//     countOwnedWorkspaces below), because there is no parent document holding
//     one.

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

/** What `countOwnedWorkspaces` hands back. Both halves come from ONE query on
 *  purpose: a workspace has no containing workspace to read a `plan` off, so
 *  the create gate has to derive the caller's entitlement from the workspaces
 *  they already own — and issuing a second read to answer "which plan" would
 *  mean deciding the cap against two reads that can disagree. */
export interface OwnedWorkspaces {
  count: number;
  /** The `plan` of each COUNTED workspace, with non-string values dropped.
   *  Shorter than `count` whenever an owned workspace has a missing or corrupt
   *  `plan` — deliberately, see the filter in `countOwnedWorkspaces`. */
  plans: string[];
}

/** Workspaces are a STOCK like boards: a live read, so deleting a workspace
 *  frees a slot with no decrement path to get wrong. Unlike `countBoards` this
 *  cannot use count() — the caller needs each match's `plan`, not just how many
 *  matches there are — so it runs a projected (`select`) read instead: one
 *  document stub per owned workspace carrying that field alone, never the
 *  members/settings/swatches payload.
 *
 *  Filters on `ownerId`, NOT on membership, and that is a decision rather than
 *  a shortcut: being invited to someone else's workspace must never consume
 *  your own allowance, and the roadmap cap is on what a user CREATES. A
 *  workspace you were merely added to is invisible here by design.
 *
 *  Because the filter is on `ownerId`, this count is only as trustworthy as
 *  that field, and the field is pinned in rules: firestore.rules' `workspaces/
 *  {id}` update rule refuses any write whose affected keys include `ownerId`
 *  (alongside `plan`). Without that pin an owner could rewrite `ownerId` while
 *  keeping their own `members` entry — the workspace would stay fully theirs to
 *  use, vanish from this count, and earn them a fresh allowance for one client
 *  write. It is the exact counterpart of the `workspaceIdUnchanged` pin the
 *  board cap depends on, and the two halves must not be relaxed in isolation.
 *
 *  What the pin does NOT cover, deliberately: deleting a workspace frees a slot
 *  (`allow delete` stays open to the owner). The cap is on how many workspaces
 *  a user holds at once, not on how many they have ever created. */
export async function countOwnedWorkspaces(
  db: Firestore,
  ownerId: string
): Promise<OwnedWorkspaces> {
  const snap = await db
    .collection("workspaces")
    .where("ownerId", "==", ownerId)
    .select("plan")
    .get();
  return {
    count: snap.size,
    // A non-string `plan` is dropped from `plans` but its document still counts
    // above. The consumer picks the BEST plan across these, so forwarding a
    // corrupt value could only ever make it a candidate for "best" — dropping
    // it leaves `free` as the answer, which is the fail-closed direction.
    plans: snap.docs
      .map((d) => d.get("plan") as unknown)
      .filter((plan): plan is string => typeof plan === "string"),
  };
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
 *  never drift from the documents it counts.
 *
 *  One documented exception, and only one: Month 6's welcome-session grant
 *  (functions/src/callable/createSession.ts) creates a session WITHOUT calling
 *  this, at most once per workspace ever, and records that it did so on the
 *  workspace document in that same transaction. So a workspace's session
 *  documents can exceed this counter by exactly one, and by one only — the
 *  `welcomeSessionGrantUsed` marker is what makes that bound hold, which is
 *  why firestore.rules pins the field. Anything beyond that gap IS drift.
 *
 *  `prev` is REQUIRED and must come
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
