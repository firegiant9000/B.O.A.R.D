/**
 * Month 3, Phase 9 — multi-tenancy backfill migration (roadmap item 2 backfill).
 *
 * One-off Admin-SDK script that stamps the tenancy primitive onto every legacy
 * doc created before the workspace model existed:
 *
 *   1. users    → ensure each user has a personal workspace (`personal_{uid}`).
 *   2. boards    → stamp `workspaceId`:
 *                   - solo board (only the owner is a member) → owner's personal WS.
 *                   - shared board (>1 member)              → a dedicated shared
 *                     workspace `board_ws_{boardId}` whose members mirror the board
 *                     (owner→owner, adminId→admin, everyone else→member). This is
 *                     the gap the plan's one-liner glossed: a personal workspace
 *                     contains only its owner, so once the legacy rules fallback is
 *                     removed at cutover, board collaborators who aren't workspace
 *                     members would 403. Mirroring board membership into a shared
 *                     workspace preserves their access without leaking the owner's
 *                     personal boards.
 *   3. sessions  → stamp `workspaceId` inherited from the parent board.
 *
 * Roles backfill: legacy boards had no role distinction — every member could edit.
 * That maps exactly onto the default role resolution (workspace owner/admin/member
 * ⇒ editor; see boardService.effectiveBoardRole), so we deliberately write NO
 * `roles` map. An absent override means "inherit editor", which reproduces the
 * pre-migration behavior. Writing explicit editor overrides would be redundant and
 * would have to be unwound the first time someone is demoted to viewer.
 *
 * Properties (roadmap requirements):
 *   - Idempotent: re-running skips docs already stamped / workspaces already created
 *     (deterministic doc ids + a `workspaceId != ''` guard), so a re-run after a
 *     partial failure is safe.
 *   - `--dry-run`: reports the exact counts it WOULD change, writes nothing.
 *
 * Usage:
 *   # Against a real project (staging first — see the Phase 9 runbook):
 *   GOOGLE_APPLICATION_CREDENTIALS=./sa.json \
 *     node scripts/migrate-workspaces.js --project=<projectId> [--dry-run]
 *
 *   # Against the local emulator:
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 \
 *     node scripts/migrate-workspaces.js --project=demo-board-rules [--dry-run]
 *
 * The core `migrate(db, opts)` and the pure helpers are exported for the
 * emulator-backed test (firestore-tests/migrate.test.js).
 */
"use strict";

// ── pure helpers (unit-testable without a database) ──────────────────────────

/** The workspace role a board member should carry in the board's shared workspace. */
function workspaceRoleForMember(uid, board) {
  if (uid === board.ownerId) return "owner";
  if (uid === board.adminId) return "admin";
  return "member";
}

/** A board is "shared" when it has any member other than its owner. */
function boardIsShared(board) {
  const members = board.members || [];
  return members.some((uid) => uid !== board.ownerId);
}

/**
 * Builds the shared-workspace document for a board: members mirror the board's
 * `members` array (owner→owner, adminId→admin, rest→member), with the owner always
 * present even if absent from `members`. `memberIds` is the parallel array the
 * `array-contains` membership query reads (see Workspace type).
 */
function buildSharedWorkspace(board) {
  const members = {};
  const memberIds = [];
  const add = (uid, role) => {
    if (uid && !(uid in members)) {
      members[uid] = role;
      memberIds.push(uid);
    }
  };
  add(board.ownerId, "owner");
  for (const uid of board.members || []) add(uid, workspaceRoleForMember(uid, board));
  return {
    name: `${board.title || "Untitled"} (Shared)`,
    ownerId: board.ownerId,
    members,
    memberIds,
    plan: "free",
    // Marks a migration-created shared workspace so personal-workspace detection
    // (below) never mistakes it for a user's personal one.
    kind: "shared",
  };
}

function emptyStats() {
  return {
    usersScanned: 0,
    personalCreated: 0,
    personalReused: 0,
    boardsScanned: 0,
    boardsStamped: 0,
    boardsAlreadyMigrated: 0,
    sharedWorkspacesCreated: 0,
    sharedWorkspacesReused: 0,
    sessionsScanned: 0,
    sessionsStamped: 0,
    sessionsAlreadyMigrated: 0,
    sessionsOrphaned: 0,
  };
}

// ── migration core ───────────────────────────────────────────────────────────

/**
 * @param db   An initialized Admin-SDK Firestore instance (real or emulator).
 * @param opts { dryRun?: boolean, log?: (msg) => void, serverTimestamp?: () => any }
 * @returns stats object (also returned in dry-run, reflecting would-be changes).
 */
async function migrate(db, opts = {}) {
  const dryRun = !!opts.dryRun;
  const log = opts.log || (() => {});
  const now = opts.serverTimestamp ? opts.serverTimestamp() : new Date();
  const stats = emptyStats();

  // uid → personal workspace id, memoized so the board loop reuses the user loop's work.
  const personalByUser = new Map();

  /**
   * Resolves (and creates if needed) a user's personal workspace, idempotently.
   * Preference order: a prior migration's `personal_{uid}` doc → an existing
   * owner-of, non-shared workspace (e.g. a signup-created "Personal") → create
   * `personal_{uid}`. Uses a single equality query (no composite index needed) and
   * filters out `kind: 'shared'` in memory.
   */
  async function ensurePersonal(uid) {
    if (!uid) return null;
    if (personalByUser.has(uid)) return personalByUser.get(uid);

    const detId = `personal_${uid}`;
    const detSnap = await db.collection("workspaces").doc(detId).get();
    if (detSnap.exists) {
      personalByUser.set(uid, detId);
      stats.personalReused++;
      return detId;
    }

    const owned = await db.collection("workspaces").where("ownerId", "==", uid).get();
    const candidates = owned.docs.filter((d) => (d.data() || {}).kind !== "shared");
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const ta = (a.data().createdAt && a.data().createdAt.toMillis && a.data().createdAt.toMillis()) || 0;
        const tb = (b.data().createdAt && b.data().createdAt.toMillis && b.data().createdAt.toMillis()) || 0;
        return ta - tb;
      });
      const id = candidates[0].id;
      personalByUser.set(uid, id);
      stats.personalReused++;
      return id;
    }

    // None exists → create the deterministic personal workspace.
    if (!dryRun) {
      await db.collection("workspaces").doc(detId).set({
        name: "Personal",
        ownerId: uid,
        members: { [uid]: "owner" },
        memberIds: [uid],
        plan: "free",
        kind: "personal",
        createdAt: now,
      });
    }
    personalByUser.set(uid, detId);
    stats.personalCreated++;
    return detId;
  }

  // 1. Personal workspaces for every user.
  const usersSnap = await db.collection("users").get();
  for (const u of usersSnap.docs) {
    stats.usersScanned++;
    await ensurePersonal(u.id);
  }

  // 2. Boards. boardId → resolved workspaceId, recorded for the session pass below
  //    (including boards skipped as already-migrated, so their sessions still resolve).
  const boardWs = new Map();
  const boardsSnap = await db.collection("boards").get();
  for (const b of boardsSnap.docs) {
    stats.boardsScanned++;
    const board = b.data() || {};

    if (board.workspaceId) {
      stats.boardsAlreadyMigrated++;
      boardWs.set(b.id, board.workspaceId);
      continue;
    }

    let wsId;
    if (boardIsShared(board)) {
      wsId = `board_ws_${b.id}`;
      const wsRef = db.collection("workspaces").doc(wsId);
      const exists = (await wsRef.get()).exists;
      if (exists) {
        stats.sharedWorkspacesReused++;
      } else {
        if (!dryRun) {
          await wsRef.set({ ...buildSharedWorkspace(board), createdAt: now });
        }
        stats.sharedWorkspacesCreated++;
      }
    } else {
      wsId = await ensurePersonal(board.ownerId);
      if (!wsId) {
        log(`! board ${b.id} has no resolvable owner (ownerId=${board.ownerId}); skipping`);
        continue;
      }
    }

    if (!dryRun) {
      await b.ref.update({ workspaceId: wsId });
    }
    stats.boardsStamped++;
    boardWs.set(b.id, wsId);
  }

  // 3. Sessions inherit workspaceId from their board.
  const sessionsSnap = await db.collection("sessions").get();
  for (const s of sessionsSnap.docs) {
    stats.sessionsScanned++;
    const session = s.data() || {};

    if (session.workspaceId) {
      stats.sessionsAlreadyMigrated++;
      continue;
    }

    const wsId = boardWs.get(session.boardId);
    if (!wsId) {
      stats.sessionsOrphaned++;
      log(`! session ${s.id} references board ${session.boardId} with no workspace; left unscoped`);
      continue;
    }

    if (!dryRun) {
      await s.ref.update({ workspaceId: wsId });
    }
    stats.sessionsStamped++;
  }

  return stats;
}

module.exports = {
  migrate,
  workspaceRoleForMember,
  boardIsShared,
  buildSharedWorkspace,
  emptyStats,
};

// ── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const { initializeApp, applicationDefault } = require("firebase-admin/app");
  const { getFirestore, FieldValue } = require("firebase-admin/firestore");

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const projectArg = args.find((a) => a.startsWith("--project="));
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

  // Emulator runs need no credentials; the Admin SDK reads FIRESTORE_EMULATOR_HOST.
  // Real runs use application-default credentials (GOOGLE_APPLICATION_CREDENTIALS).
  initializeApp(
    usingEmulator ? { projectId } : { projectId, credential: applicationDefault() }
  );

  const db = getFirestore();

  console.log(
    `\nPhase 9 workspace migration — project=${projectId} ` +
      `${usingEmulator ? "(EMULATOR) " : ""}${dryRun ? "[DRY RUN — no writes]" : "[LIVE]"}\n`
  );

  migrate(db, {
    dryRun,
    log: (m) => console.log(m),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  })
    .then((stats) => {
      console.log("\nResult:");
      for (const [k, v] of Object.entries(stats)) {
        console.log(`  ${k.padEnd(26)} ${v}`);
      }
      if (dryRun) {
        console.log("\nDry run complete — no documents were written.\n");
      } else {
        console.log("\nMigration complete.\n");
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("\nMigration FAILED:", err);
      process.exit(1);
    });
}
