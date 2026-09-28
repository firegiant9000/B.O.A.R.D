/**
 * Emulator-backed test for the welcome-session grant backfill
 * (scripts/backfill-welcome-session-grant.js).
 *
 * Same harness and same reasoning as migrate.test.js: the Admin SDK, not the
 * rules client, because that is what the script itself uses and Admin writes
 * bypass security rules — which matters more here than it did there, since
 * `welcomeSessionGrantUsed` is PINNED for clients by firestore.rules'
 * `workspaces/{id}` update rule. A rules-client version of this test could not
 * perform the write at all.
 *
 * Asserts the properties the backfill is only safe under:
 *   - stamps `welcomeSessionGrantUsed: true` on a pre-cutover workspace;
 *   - never touches a workspace that already carries the field, `true` OR
 *     `false` — the callable's transaction owns that decision;
 *   - `--dry-run` writes nothing but reports accurate would-be counts;
 *   - idempotent: a second live run stamps nothing;
 *   - with `--created-before`, a post-cutover workspace is left eligible, and
 *     so is one whose `createdAt` cannot be read.
 */
const { initializeApp, getApps, deleteApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const {
  backfillWelcomeSessionGrant,
  hasGrantDecision,
  isInScope,
} = require("../scripts/backfill-welcome-session-grant");

const PROJECT_ID = "demo-board-rules";
const HOST = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";

// A cutover instant with fixtures on both sides of it.
const CUTOVER = Date.UTC(2026, 8, 9);

let db;

async function clearEmulator() {
  await fetch(
    `http://${HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" }
  );
}

function workspace(over) {
  return {
    name: "WS",
    ownerId: "alice",
    members: { alice: "owner" },
    memberIds: ["alice"],
    plan: "free",
    ...over,
  };
}

async function seed() {
  // Two legacy workspaces, both created before the cutover, neither carrying
  // the field — the whole back catalogue this script exists for.
  await db.collection("workspaces").doc("legacy1").set(
    workspace({ createdAt: Timestamp.fromMillis(CUTOVER - 86_400_000) })
  );
  await db.collection("workspaces").doc("legacy2").set(
    workspace({ createdAt: Timestamp.fromMillis(CUTOVER - 10_000) })
  );
  // Created after the cutover: a genuinely new signup whose grant is still
  // rightfully unspent.
  await db.collection("workspaces").doc("fresh").set(
    workspace({ createdAt: Timestamp.fromMillis(CUTOVER + 86_400_000) })
  );
  // Already decided by the callable's transaction, both directions.
  await db.collection("workspaces").doc("spent").set(
    workspace({ createdAt: Timestamp.fromMillis(CUTOVER - 1), welcomeSessionGrantUsed: true })
  );
  await db.collection("workspaces").doc("explicitlyUnspent").set(
    workspace({ createdAt: Timestamp.fromMillis(CUTOVER - 2), welcomeSessionGrantUsed: false })
  );
  // No createdAt at all — a document old enough to predate the field.
  await db.collection("workspaces").doc("undated").set(workspace({}));
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
  await seed();
});

async function grantOf(id) {
  return (await db.collection("workspaces").doc(id).get()).data().welcomeSessionGrantUsed;
}

test("dry-run reports counts but writes nothing", async () => {
  const stats = await backfillWelcomeSessionGrant(db, { dryRun: true });

  expect(stats.workspacesScanned).toBe(6);
  // legacy1, legacy2, fresh and undated all lack the field; with no cutoff
  // every one of them is in scope, which is the intended pre-deploy run.
  expect(stats.workspacesStamped).toBe(4);
  expect(stats.workspacesAlreadyDecided).toBe(2);

  expect(await grantOf("legacy1")).toBeUndefined();
  expect(await grantOf("fresh")).toBeUndefined();
});

test("live run stamps every workspace that has no decision yet", async () => {
  const stats = await backfillWelcomeSessionGrant(db, {});

  expect(stats.workspacesStamped).toBe(4);
  expect(await grantOf("legacy1")).toBe(true);
  expect(await grantOf("legacy2")).toBe(true);
  expect(await grantOf("undated")).toBe(true);
});

test("never overwrites a decision the callable already made, in either direction", async () => {
  await backfillWelcomeSessionGrant(db, {});

  // `true` stays true (trivially), and `false` STAYS FALSE — a stored `false`
  // means something wrote it, so flipping it to `true` would revoke a grant
  // the product had decided was still available.
  expect(await grantOf("spent")).toBe(true);
  expect(await grantOf("explicitlyUnspent")).toBe(false);
});

test("idempotent: a second live run stamps nothing", async () => {
  await backfillWelcomeSessionGrant(db, {});
  const second = await backfillWelcomeSessionGrant(db, {});

  expect(second.workspacesStamped).toBe(0);
  expect(second.workspacesAlreadyDecided).toBe(6);
});

test("with a cutoff, leaves post-cutover and undated workspaces eligible", async () => {
  const stats = await backfillWelcomeSessionGrant(db, { cutoffMillis: CUTOVER });

  expect(stats.workspacesStamped).toBe(2);
  expect(stats.workspacesAfterCutoff).toBe(1);
  expect(stats.workspacesUndatedSkipped).toBe(1);

  expect(await grantOf("legacy1")).toBe(true);
  expect(await grantOf("legacy2")).toBe(true);
  // Wrongly stamping either of these costs a real user their un-metered
  // welcome session with no way to give it back; wrongly skipping costs one
  // extra session once, which createSession's header already accepts.
  expect(await grantOf("fresh")).toBeUndefined();
  expect(await grantOf("undated")).toBeUndefined();
});

test("flushes a full batch and opens a new one instead of accumulating forever", async () => {
  // Firestore caps a batch at 500 writes, so the loop must flush at
  // `batchSize` rather than building one batch for the whole collection —
  // which would pass every fixture above (they are all far under 500) and
  // reject only in production, on the one collection big enough to matter.
  // Counted rather than inferred: the script touches `db` for exactly two
  // things, so a thin recorder around `batch()` makes the flush observable.
  const writer = db.batch();
  for (let i = 0; i < 12; i++) {
    writer.set(
      db.collection("workspaces").doc(`bulk${i}`),
      workspace({ createdAt: Timestamp.fromMillis(CUTOVER - 5) })
    );
  }
  await writer.commit();

  let batchesOpened = 0;
  const recorder = {
    collection: (name) => db.collection(name),
    batch: () => {
      batchesOpened++;
      return db.batch();
    },
  };

  const stats = await backfillWelcomeSessionGrant(recorder, { batchSize: 5 });

  // 16 in-scope workspaces at 5 per batch: three full flushes plus the final
  // partial one, and one more opened after the last flush.
  expect(stats.workspacesStamped).toBe(16);
  expect(batchesOpened).toBe(4);
  expect(await grantOf("bulk0")).toBe(true);
  expect(await grantOf("bulk11")).toBe(true);
});

describe("pure helpers", () => {
  test("hasGrantDecision treats a stored false as a decision, not as unset", () => {
    expect(hasGrantDecision({ welcomeSessionGrantUsed: false })).toBe(true);
    expect(hasGrantDecision({ welcomeSessionGrantUsed: true })).toBe(true);
    expect(hasGrantDecision({})).toBe(false);
  });

  test("isInScope admits an undated workspace only when there is no cutoff", () => {
    expect(isInScope({}, null)).toBe(true);
    expect(isInScope({}, CUTOVER)).toBe(false);
  });
});
