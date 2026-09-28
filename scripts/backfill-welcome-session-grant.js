/**
 * Month 6 — one-off backfill for the welcome-session grant.
 *
 * WHY THIS EXISTS. `createSession` gates its un-metered onboarding session on
 * `workspaces/{id}.welcomeSessionGrantUsed` (functions/src/callable/
 * createSession.ts): the grant is available only while that field is not
 * `true`, and the callable's transaction sets it the moment the grant is
 * taken. The field did not exist before that commit, so EVERY workspace
 * created earlier reads as eligible — the whole back catalogue, not just
 * genuinely new signups. This script stamps `welcomeSessionGrantUsed: true`
 * on those workspaces so the grant means "your first workspace's demo
 * session", not "one free session for every account that has ever existed".
 *
 * WHEN TO RUN IT. Against production BEFORE the firestore.rules deploy that
 * pins the field. That ordering is not arbitrary: the pin makes the field
 * unwritable by any client, and this script writes through the Admin SDK, so
 * it works either side of the deploy — but running it first means there is no
 * window in which the pinned field is live and the back catalogue is still
 * eligible. See firestore.rules' deploy-order banner for the rest of that
 * sequence (this pair is the one that is RULES FIRST, not functions first).
 *
 * WHAT IT WILL NOT DO. It never touches a workspace that already carries
 * `welcomeSessionGrantUsed` in any form, including `false`. The only writer
 * of that field in the product is the callable's transaction, so a workspace
 * that has it has already had its grant decided, and overwriting that
 * decision is the one thing a backfill must never do.
 *
 * Properties (matching scripts/migrate-workspaces.js's own contract):
 *   - Idempotent: the "already has the field" guard is what makes a re-run
 *     after a partial failure safe; no deterministic-id trick is needed here.
 *   - `--dry-run`: reports the exact counts it WOULD change, writes nothing.
 *
 * Usage:
 *   # Against a real project (staging first):
 *   GOOGLE_APPLICATION_CREDENTIALS=./sa.json \
 *     node scripts/backfill-welcome-session-grant.js --project=<projectId> [--dry-run]
 *
 *   # Restricted to workspaces created before a cutover instant, for a re-run
 *   # AFTER the grant-aware createSession is live (see `--created-before`):
 *   node scripts/backfill-welcome-session-grant.js --project=<id> \
 *     --created-before=2026-09-09T00:00:00Z
 *
 *   # Against the local emulator:
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 \
 *     node scripts/backfill-welcome-session-grant.js --project=demo-board-rules [--dry-run]
 *
 * The core `backfillWelcomeSessionGrant(db, opts)` and the pure helpers are
 * exported for the emulator-backed test
 * (firestore-tests/backfillWelcomeSessionGrant.test.js).
 */
"use strict";

// ── pure helpers (unit-testable without a database) ──────────────────────────

/**
 * Whether the workspace document `data` has already had its grant decided.
 * Deliberately `in`, not truthiness: a stored `false` is a DECISION (the field
 * was written by something), and a backfill that treated it as "unset" would
 * hand that workspace a second grant. `undefined` values do not survive a
 * Firestore round trip, so an `in` check and a "field present" check are the
 * same thing here.
 */
function hasGrantDecision(data) {
  return !!data && Object.prototype.hasOwnProperty.call(data, "welcomeSessionGrantUsed");
}

/**
 * Milliseconds for a workspace's `createdAt`, or `null` when it cannot be
 * read. Handles the Admin SDK `Timestamp` (`.toMillis()`), a raw `Date`, and a
 * plain epoch number, because this collection predates the current writer and
 * a legacy document is exactly what this script is aimed at.
 */
function createdAtMillis(data) {
  const v = data && data.createdAt;
  if (!v) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * Whether this workspace is in scope for the backfill.
 *
 * With no `cutoffMillis` every workspace without the field is in scope, which
 * is the intended pre-deploy run: nothing can have taken the grant yet, so
 * "has no field" and "predates the cutover" are the same set.
 *
 * With a `cutoffMillis` (a re-run after the callable is live) a workspace is
 * in scope only if its `createdAt` is strictly earlier. A workspace whose
 * `createdAt` cannot be read is left ALONE rather than stamped — the two
 * errors are not symmetric. Wrongly stamping costs a real new user their
 * un-metered welcome session with no way to give it back; wrongly skipping
 * leaves one legacy workspace eligible for one extra session, ever, which is
 * the same bound createSession's own header already accepts.
 */
function isInScope(data, cutoffMillis) {
  if (hasGrantDecision(data)) return false;
  if (cutoffMillis === null || cutoffMillis === undefined) return true;
  const created = createdAtMillis(data);
  if (created === null) return false;
  return created < cutoffMillis;
}

function emptyStats() {
  return {
    workspacesScanned: 0,
    workspacesStamped: 0,
    workspacesAlreadyDecided: 0,
    workspacesAfterCutoff: 0,
    workspacesUndatedSkipped: 0,
  };
}

// ── backfill core ────────────────────────────────────────────────────────────

/**
 * @param db   An initialized Admin-SDK Firestore instance (real or emulator).
 * @param opts { dryRun?: boolean, log?: (msg) => void, cutoffMillis?: number|null,
 *               batchSize?: number }
 * @returns stats object (also returned in dry-run, reflecting would-be changes).
 */
async function backfillWelcomeSessionGrant(db, opts = {}) {
  const dryRun = !!opts.dryRun;
  const log = opts.log || (() => {});
  const cutoffMillis = opts.cutoffMillis === undefined ? null : opts.cutoffMillis;
  // Firestore's hard limit on a batch is 500 writes. Batched rather than
  // per-document like migrate-workspaces.js because every write here is the
  // identical single-field update over a whole collection — that script's
  // per-doc updates exist because its writes differ from each other.
  const batchSize = Math.min(opts.batchSize || 400, 500);
  const stats = emptyStats();

  const snap = await db.collection("workspaces").get();
  let batch = dryRun ? null : db.batch();
  let pending = 0;

  for (const ws of snap.docs) {
    stats.workspacesScanned++;
    const data = ws.data() || {};

    if (hasGrantDecision(data)) {
      stats.workspacesAlreadyDecided++;
      continue;
    }
    if (!isInScope(data, cutoffMillis)) {
      if (createdAtMillis(data) === null) {
        stats.workspacesUndatedSkipped++;
        log(`! workspace ${ws.id} has no readable createdAt; left eligible rather than stamped`);
      } else {
        stats.workspacesAfterCutoff++;
      }
      continue;
    }

    if (!dryRun) {
      batch.update(ws.ref, { welcomeSessionGrantUsed: true });
      pending++;
      if (pending >= batchSize) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    stats.workspacesStamped++;
  }

  if (!dryRun && pending > 0) await batch.commit();

  return stats;
}

module.exports = {
  backfillWelcomeSessionGrant,
  hasGrantDecision,
  createdAtMillis,
  isInScope,
  emptyStats,
};

// ── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const { initializeApp, applicationDefault } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const projectArg = args.find((a) => a.startsWith("--project="));
  const cutoffArg = args.find((a) => a.startsWith("--created-before="));
  const projectId =
    (projectArg && projectArg.split("=")[1]) ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT;

  const usingEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;

  if (!projectId) {
    console.error(
      "Refusing to run without an explicit target. Pass --project=<projectId> " +
        "(or set GCLOUD_PROJECT). For prod, also set GOOGLE_APPLICATION_CREDENTIALS."
    );
    process.exit(1);
  }

  let cutoffMillis = null;
  if (cutoffArg) {
    const raw = cutoffArg.split("=").slice(1).join("=");
    cutoffMillis = Date.parse(raw);
    if (Number.isNaN(cutoffMillis)) {
      console.error(`--created-before=${raw} is not a parseable date. Refusing to run.`);
      process.exit(1);
    }
  }

  initializeApp(
    usingEmulator ? { projectId } : { projectId, credential: applicationDefault() }
  );

  const db = getFirestore();

  console.log(
    `\nWelcome-session grant backfill — project=${projectId} ` +
      `${usingEmulator ? "(EMULATOR) " : ""}${dryRun ? "[DRY RUN — no writes]" : "[LIVE]"}` +
      `${cutoffArg ? ` created-before=${new Date(cutoffMillis).toISOString()}` : ""}\n`
  );

  backfillWelcomeSessionGrant(db, {
    dryRun,
    cutoffMillis,
    log: (m) => console.log(m),
  })
    .then((stats) => {
      console.log("\nResult:");
      for (const [k, v] of Object.entries(stats)) {
        console.log(`  ${k.padEnd(28)} ${v}`);
      }
      if (dryRun) {
        console.log("\nDry run complete — no documents were written.\n");
      } else {
        console.log("\nBackfill complete.\n");
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("\nBackfill FAILED:", err);
      process.exit(1);
    });
}
