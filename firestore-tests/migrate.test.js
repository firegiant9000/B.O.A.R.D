/**
 * Emulator-backed test for the Phase 9 workspace migration (scripts/migrate-workspaces.js).
 *
 * Runs under the same `firebase emulators:exec` harness as the rules tests
 * (`npm run test:rules`). Uses the Admin SDK (not the rules client) because that's
 * exactly what the migration script uses — Admin writes bypass security rules, so
 * we can seed legacy fixtures and let the migration mutate them freely.
 *
 * Asserts the roadmap's Phase 9 requirements:
 *   - solo board → owner's personal workspace; shared board → dedicated shared WS
 *     whose members mirror the board (so collaborators don't lose access at cutover).
 *   - sessions inherit their board's workspaceId.
 *   - `--dry-run` writes nothing but reports accurate would-be counts.
 *   - idempotency: a second live run is a no-op (everything already migrated).
 */
const { initializeApp, getApps, deleteApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { migrate } = require("../scripts/migrate-workspaces");

const PROJECT_ID = "demo-board-rules";
const HOST = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";

let db;

async function clearEmulator() {
  await fetch(
    `http://${HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" }
  );
}

async function seedLegacyFixture() {
  // Two users; no workspaces yet (pre-Phase-1 world).
  await db.collection("users").doc("alice").set({ email: "alice@x.com" });
  await db.collection("users").doc("bob").set({ email: "bob@x.com" });

  // Solo board (only the owner) → should land in alice's personal workspace.
  await db.collection("boards").doc("solo").set({
    title: "Solo",
    ownerId: "alice",
    adminId: "alice",
    members: ["alice"],
    inviteCode: "BORD-SOLO00",
  });

  // Shared board (alice owner, bob collaborator) → dedicated shared workspace.
  await db.collection("boards").doc("shared").set({
    title: "Group Project",
    ownerId: "alice",
    adminId: "bob",
    members: ["alice", "bob"],
    inviteCode: "BORD-SHARE0",
  });

  // Sessions on each board → inherit the board's workspaceId.
  await db.collection("sessions").doc("sessSolo").set({
    boardId: "solo",
    createdById: "alice",
    participantIds: ["alice"],
    title: "Solo study",
  });
  await db.collection("sessions").doc("sessShared").set({
    boardId: "shared",
    createdById: "alice",
    participantIds: ["alice", "bob"],
    title: "Group study",
  });
  // Orphan session — its board doesn't exist; must be left unscoped, not crash.
  await db.collection("sessions").doc("sessOrphan").set({
    boardId: "ghost",
    createdById: "alice",
    participantIds: ["alice"],
    title: "Orphan",
  });
}

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID });
  db = getFirestore();
});

afterAll(async () => {
  await Promise.all(getApps().map((a) => deleteApp(a)));
});

beforeEach(async () => {
  await clearEmulator();
  await seedLegacyFixture();
});

test("dry-run reports counts but writes nothing", async () => {
  const stats = await migrate(db, { dryRun: true });

  expect(stats.usersScanned).toBe(2);
  expect(stats.boardsStamped).toBe(2);
  expect(stats.sharedWorkspacesCreated).toBe(1);
  expect(stats.sessionsStamped).toBe(2);
  expect(stats.sessionsOrphaned).toBe(1);

  // Nothing actually written.
  expect((await db.collection("workspaces").get()).empty).toBe(true);
  expect((await db.collection("boards").doc("solo").get()).data().workspaceId).toBeUndefined();
  expect((await db.collection("sessions").doc("sessSolo").get()).data().workspaceId).toBeUndefined();
});

test("live run stamps boards/sessions and builds the right workspaces", async () => {
  await migrate(db, {});

  // alice has a personal workspace; the solo board points at it.
  const personal = await db.collection("workspaces").doc("personal_alice").get();
  expect(personal.exists).toBe(true);
  expect(personal.data().members).toEqual({ alice: "owner" });

  const solo = (await db.collection("boards").doc("solo").get()).data();
  expect(solo.workspaceId).toBe("personal_alice");

  // Shared board → dedicated workspace mirroring board membership.
  const sharedWs = (await db.collection("workspaces").doc("board_ws_shared").get()).data();
  expect(sharedWs.members).toEqual({ alice: "owner", bob: "admin" });
  expect(sharedWs.memberIds.sort()).toEqual(["alice", "bob"]);
  expect(sharedWs.kind).toBe("shared");

  const shared = (await db.collection("boards").doc("shared").get()).data();
  expect(shared.workspaceId).toBe("board_ws_shared");
  // No roles map written — members inherit editor (preserves pre-migration behavior).
  expect(shared.roles).toBeUndefined();

  // Sessions inherit their board's workspace; the orphan stays unscoped.
  expect((await db.collection("sessions").doc("sessSolo").get()).data().workspaceId).toBe("personal_alice");
  expect((await db.collection("sessions").doc("sessShared").get()).data().workspaceId).toBe("board_ws_shared");
  expect((await db.collection("sessions").doc("sessOrphan").get()).data().workspaceId).toBeUndefined();
});

test("idempotent: a second run changes nothing", async () => {
  await migrate(db, {});
  const second = await migrate(db, {});

  expect(second.boardsStamped).toBe(0);
  expect(second.boardsAlreadyMigrated).toBe(2);
  expect(second.sharedWorkspacesCreated).toBe(0);
  // Already-stamped boards short-circuit before the shared-WS check, so a clean
  // re-run never re-touches it (reuse only fires during partial-run recovery).
  expect(second.sharedWorkspacesReused).toBe(0);
  expect(second.personalCreated).toBe(0);
  expect(second.personalReused).toBeGreaterThanOrEqual(1);
  expect(second.sessionsStamped).toBe(0);
  expect(second.sessionsAlreadyMigrated).toBe(2);

  // Exactly three workspaces (one personal per user + one shared board) — no dupes.
  expect((await db.collection("workspaces").get()).size).toBe(3);
});

test("reuses a signup-created 'Personal' workspace instead of duplicating", async () => {
  // A user who signed up post-Phase-1 already has a random-id personal workspace.
  await db.collection("workspaces").doc("randomid123").set({
    name: "Personal",
    ownerId: "alice",
    members: { alice: "owner" },
    memberIds: ["alice"],
    plan: "free",
  });

  await migrate(db, {});

  // The solo board must reuse the existing one, not create personal_alice.
  expect((await db.collection("workspaces").doc("personal_alice").get()).exists).toBe(false);
  expect((await db.collection("boards").doc("solo").get()).data().workspaceId).toBe("randomid123");
});
