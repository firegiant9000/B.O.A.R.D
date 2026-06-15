/**
 * Emulator-backed Firestore security-rules tests (Month 3, Phase 2).
 *
 * The hard CI gate for the multi-tenancy work: proves board access resolves
 * through the parent workspace and that no one can read another workspace's board
 * content. Runs under `firebase emulators:exec` (see `npm run test:rules`).
 *
 * Tenancy fixture:
 *   wsA  — owner: alice            wsB — owner: bob
 *   boardCoded   in wsA, members [alice, evil], has an inviteCode
 *   boardPrivate in wsA, members [alice, evil], no inviteCode
 *   boardLegacy  no workspaceId,   members [alice, evil], no inviteCode
 *
 * `evil` is the crux: a user listed in a board's `members` array but NOT in the
 * board's workspace. Pre-Phase-2 they could read everything; Phase 2 must deny
 * them through the workspace gate.
 */
const { readFileSync } = require("fs");
const path = require("path");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
} = require("firebase/firestore");

const ALICE = "alice";
const BOB = "bob";
const EVIL = "evil";
// Phase 6 actors, all members of wsA with different workspace roles:
const CAROL = "carol"; // workspace viewer
const DAVE = "dave";   // workspace member
const FRANK = "frank"; // workspace member (demoted to viewer on boardWrite)

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-board-rules",
    firestore: {
      rules: readFileSync(path.resolve(__dirname, "../firestore.rules"), "utf8"),
    },
  });
});

afterAll(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Seed with rules bypassed so we can construct the cross-workspace fixture.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    await setDoc(doc(db, "workspaces/wsA"), {
      name: "Alice WS",
      ownerId: ALICE,
      members: { [ALICE]: "owner", [CAROL]: "viewer", [DAVE]: "member", [FRANK]: "member" },
      memberIds: [ALICE, CAROL, DAVE, FRANK],
      plan: "free",
    });
    await setDoc(doc(db, "workspaces/wsB"), {
      name: "Bob WS",
      ownerId: BOB,
      members: { [BOB]: "owner" },
      memberIds: [BOB],
      plan: "free",
    });

    await setDoc(doc(db, "boards/boardCoded"), {
      workspaceId: "wsA",
      title: "Coded",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE, EVIL],
      inviteCode: "BORD-AAAAAA",
    });
    await setDoc(doc(db, "boards/boardCoded/paths/p1"), { userId: ALICE });

    await setDoc(doc(db, "boards/boardPrivate"), {
      workspaceId: "wsA",
      title: "Private",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE, EVIL],
      inviteCode: null,
    });
    await setDoc(doc(db, "boards/boardPrivate/paths/pP"), { userId: ALICE });

    await setDoc(doc(db, "boards/boardLegacy"), {
      // no workspaceId — a board created before the Phase 2 migration
      title: "Legacy",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE, EVIL],
      inviteCode: null,
    });
    await setDoc(doc(db, "boards/boardLegacy/paths/p1"), { userId: ALICE });

    // Phase 6 — per-board roles fixture. All four extra members belong to wsA.
    //   carol  — workspace viewer, with an 'editor' override (must be floor-capped)
    //   dave   — workspace member, no override (defaults to editor)
    //   frank  — workspace member, demoted to 'viewer' via an override
    await setDoc(doc(db, "boards/boardWrite"), {
      workspaceId: "wsA",
      title: "Write",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE, CAROL, DAVE, FRANK],
      roles: { [CAROL]: "editor", [FRANK]: "viewer" },
      inviteCode: null,
    });
    await setDoc(doc(db, "boards/boardWrite/paths/seed"), { userId: ALICE });

    // Phase 7 — comment fixtures (one per board), authored by alice.
    const seedComment = { anchorElementId: "seed", anchorKind: "shape", authorId: ALICE, body: "hi", replies: [], resolved: false };
    await setDoc(doc(db, "boards/boardWrite/comments/cmt1"), seedComment);
    await setDoc(doc(db, "boards/boardPrivate/comments/cmtP"), seedComment);
    await setDoc(doc(db, "boards/boardLegacy/comments/cmtL"), seedComment);

    // Phase 4 — sessions inherit a workspaceId from their board.
    await setDoc(doc(db, "sessions/sessWsA"), {
      workspaceId: "wsA",
      boardId: "boardPrivate",
      createdById: ALICE,
      participantIds: [],
      joinCode: null,
    });
    await setDoc(doc(db, "sessions/sessCoded"), {
      workspaceId: "wsA",
      boardId: "boardCoded",
      createdById: ALICE,
      participantIds: [],
      joinCode: "SESS-AAAAAA",
    });
    await setDoc(doc(db, "sessions/sessLegacy"), {
      // no workspaceId — a session created before the Phase 4 migration
      boardId: "boardLegacy",
      createdById: ALICE,
      participantIds: [],
      joinCode: null,
    });

    // Phase 8 — a seeded activity event in wsA, authored by alice.
    await setDoc(doc(db, "workspaces/wsA/activity/ev1"), {
      actorId: ALICE,
      actorName: "Alice",
      verb: "board.created",
      targetType: "board",
      targetId: "boardPrivate",
      workspaceId: "wsA",
      boardId: "boardPrivate",
      meta: { title: "Private" },
    });

    // Month 4 Phase 1 — AI telemetry docs (written by Functions in prod). Seeded
    // here with rules bypassed to test client read/write access against them.
    await setDoc(doc(db, "workspaces/wsA/aiUsage/2026-06"), { calls: 3, tokens: 900, costUsd: 0.01 });
    await setDoc(doc(db, "workspaces/wsA/aiLog/call1"), { uid: ALICE, model: "gpt-3.5-turbo", tokens: 300 });
    await setDoc(doc(db, "workspaces/wsA/aiRate/bucket"), { tokens: 30, updatedAt: 0 });

    // Phase 10 — an OCR cache entry the function would have written.
    await setDoc(doc(db, "boards/boardCoded/ocrCache/hash1"), {
      text: "Hi", confidence: 0.9, source: "vision", model: "google-vision", createdAt: 0,
    });

    // Phase 10 — a seeded in-app notification for alice, authored by dave.
    await setDoc(doc(db, "users/alice/notifications/n1"), {
      recipientId: ALICE,
      type: "mention",
      actorId: DAVE,
      actorName: "Dave",
      boardId: "boardWrite",
      boardTitle: "Write",
      commentId: "cmt1",
      snippet: "ping @Alice",
      read: false,
    });
  });
});

function db(uid) {
  return testEnv.authenticatedContext(uid).firestore();
}

// ── roadmap minimum: member read allowed ──────────────────────────────────────
describe("member read allowed", () => {
  it("a workspace member reads their own board's content", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "boards/boardCoded/paths/p1")));
  });

  it("a workspace member reads a private (no-invite-code) board doc", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "boards/boardPrivate")));
  });
});

// ── roadmap minimum: cross-workspace read denied ──────────────────────────────
describe("cross-workspace read denied", () => {
  it("a board member who is NOT in the workspace cannot read board content", async () => {
    // `evil` is in boardCoded.members but not in wsA — the Phase 2 workspace gate.
    await assertFails(getDoc(doc(db(EVIL), "boards/boardCoded/paths/p1")));
  });

  it("a board member outside the workspace cannot read a private board doc", async () => {
    await assertFails(getDoc(doc(db(EVIL), "boards/boardPrivate")));
  });

  it("a different workspace's owner cannot read content of a board they don't belong to", async () => {
    await assertFails(getDoc(doc(db(BOB), "boards/boardCoded/paths/p1")));
  });
});

// ── migration tolerance ───────────────────────────────────────────────────────
describe("legacy boards (no workspaceId) stay accessible during the migration window", () => {
  it("a board member can read a legacy board's content without a workspace", async () => {
    await assertSucceeds(getDoc(doc(db(EVIL), "boards/boardLegacy/paths/p1")));
  });

  it("a board member can read the legacy board doc", async () => {
    await assertSucceeds(getDoc(doc(db(EVIL), "boards/boardLegacy")));
  });
});

// ── invite-code self-join still works ─────────────────────────────────────────
describe("invite-code self-join", () => {
  it("a non-member can add only themselves to an invite-coded board", async () => {
    await assertSucceeds(
      updateDoc(doc(db(BOB), "boards/boardCoded"), {
        members: [ALICE, EVIL, BOB],
        updatedAt: new Date(),
      })
    );
  });

  it("the self-join path cannot be used to add a third party", async () => {
    await assertFails(
      updateDoc(doc(db(BOB), "boards/boardCoded"), {
        members: [ALICE, EVIL, "someoneElse"],
        updatedAt: new Date(),
      })
    );
  });
});

// ── board create binds to a workspace you belong to ───────────────────────────
describe("board create", () => {
  it("a workspace member can create a board stamped into that workspace", async () => {
    await assertSucceeds(
      setDoc(doc(db(ALICE), "boards/newA"), {
        workspaceId: "wsA",
        title: "New",
        ownerId: ALICE,
        adminId: ALICE,
        members: [ALICE],
        inviteCode: "BORD-BBBBBB",
      })
    );
  });

  it("cannot plant a board in a workspace you don't belong to", async () => {
    await assertFails(
      setDoc(doc(db(ALICE), "boards/newB"), {
        workspaceId: "wsB",
        title: "Sneaky",
        ownerId: ALICE,
        adminId: ALICE,
        members: [ALICE],
        inviteCode: "BORD-CCCCCC",
      })
    );
  });
});

// ── sessions inherit workspace (Phase 4) ──────────────────────────────────────
describe("sessions inherit workspace", () => {
  it("a workspace member reads a private session in their workspace", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "sessions/sessWsA")));
  });

  it("a non-member/non-participant cannot read a private workspace session", async () => {
    // bob is neither creator, participant, nor a member of wsA, and there's no joinCode.
    await assertFails(getDoc(doc(db(BOB), "sessions/sessWsA")));
  });

  it("the joinCode public-lookup path is still readable by anyone signed-in", async () => {
    await assertSucceeds(getDoc(doc(db(BOB), "sessions/sessCoded")));
  });

  it("a legacy session with no workspaceId stays readable via the pre-Phase-4 path", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "sessions/sessLegacy")));
  });

  it("a workspace member can create a session stamped into that workspace", async () => {
    await assertSucceeds(
      setDoc(doc(db(ALICE), "sessions/newSessA"), {
        workspaceId: "wsA",
        boardId: "boardPrivate",
        createdById: ALICE,
        participantIds: [],
        joinCode: "SESS-BBBBBB",
      })
    );
  });

  it("cannot plant a session in a workspace you don't belong to", async () => {
    await assertFails(
      setDoc(doc(db(ALICE), "sessions/newSessB"), {
        workspaceId: "wsB",
        boardId: "boardPrivate",
        createdById: ALICE,
        participantIds: [],
        joinCode: "SESS-CCCCCC",
      })
    );
  });

  it("a legacy (no-workspaceId) session create is still allowed during the migration window", async () => {
    await assertSucceeds(
      setDoc(doc(db(ALICE), "sessions/newSessLegacy"), {
        boardId: "boardLegacy",
        createdById: ALICE,
        participantIds: [],
        joinCode: "SESS-DDDDDD",
      })
    );
  });
});

// ── Phase 6: per-board roles (editor/commenter/viewer) ───────────────────────
// Writes to canvas content resolve an effective role through the workspace floor
// plus per-board overrides. Reads stay at board-member level.
describe("per-board roles", () => {
  const path = (uid, docId) =>
    setDoc(doc(db(uid), `boards/boardWrite/paths/${docId}`), { userId: uid });

  it("the board owner can write canvas content", async () => {
    await assertSucceeds(path(ALICE, "byAlice"));
  });

  it("a workspace member with no override defaults to editor and can write", async () => {
    await assertSucceeds(path(DAVE, "byDave"));
  });

  it("viewer write denied: a workspace viewer cannot write canvas content", async () => {
    // carol is a wsA viewer; even her 'editor' board override is floor-capped.
    await assertFails(path(CAROL, "byCarol"));
  });

  it("a member demoted to viewer via a per-board override cannot write", async () => {
    await assertFails(path(FRANK, "byFrank"));
  });

  it("a viewer/commenter can still READ canvas content (read = board member)", async () => {
    await assertSucceeds(getDoc(doc(db(CAROL), "boards/boardWrite/paths/seed")));
    await assertSucceeds(getDoc(doc(db(FRANK), "boards/boardWrite/paths/seed")));
  });

  it("a non-editor cannot change the shared backgroundTemplate", async () => {
    await assertFails(
      updateDoc(doc(db(CAROL), "boards/boardWrite"), {
        backgroundTemplate: "grid",
        updatedAt: new Date(),
      })
    );
  });

  it("an effective editor can change the shared backgroundTemplate", async () => {
    await assertSucceeds(
      updateDoc(doc(db(DAVE), "boards/boardWrite"), {
        backgroundTemplate: "grid",
        updatedAt: new Date(),
      })
    );
  });

  it("a viewer can still leave the board (members/updatedAt edit)", async () => {
    await assertSucceeds(
      updateDoc(doc(db(CAROL), "boards/boardWrite"), {
        members: [ALICE, DAVE, FRANK],
        updatedAt: new Date(),
      })
    );
  });

  it("only the board admin can change the per-board roles map", async () => {
    await assertFails(
      updateDoc(doc(db(DAVE), "boards/boardWrite"), {
        roles: { [CAROL]: "editor", [FRANK]: "viewer", [DAVE]: "editor" },
        updatedAt: new Date(),
      })
    );
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "boards/boardWrite"), {
        roles: { [CAROL]: "commenter", [FRANK]: "viewer" },
        updatedAt: new Date(),
      })
    );
  });

  it("a legacy board (no workspaceId) still lets any member write", async () => {
    await assertSucceeds(
      setDoc(doc(db(EVIL), "boards/boardLegacy/paths/byEvil"), { userId: EVIL })
    );
  });
});

// ── Phase 7: comments (read = board member, write = commenter+) ───────────────
describe("comments", () => {
  const newComment = (uid, authorId) => ({
    anchorElementId: "seed",
    anchorKind: "shape",
    authorId,
    body: "x",
    replies: [],
    resolved: false,
  });
  const create = (uid, docId, authorId) =>
    setDoc(doc(db(uid), `boards/boardWrite/comments/${docId}`), newComment(uid, authorId));

  it("a board member can read comments (read follows board access)", async () => {
    await assertSucceeds(getDoc(doc(db(CAROL), "boards/boardWrite/comments/cmt1")));
    await assertSucceeds(getDoc(doc(db(FRANK), "boards/boardWrite/comments/cmt1")));
  });

  it("a cross-workspace member cannot read comments", async () => {
    // evil is in boardPrivate.members but not in wsA — denied through the gate.
    await assertFails(getDoc(doc(db(EVIL), "boards/boardPrivate/comments/cmtP")));
  });

  it("a workspace member (effective editor) can create a comment", async () => {
    await assertSucceeds(create(DAVE, "byDave", DAVE));
  });

  it("a workspace viewer with a commenter+ override can comment", async () => {
    // carol is a wsA viewer with an 'editor' override, floor-capped to commenter —
    // still allowed to comment.
    await assertSucceeds(create(CAROL, "byCarol", CAROL));
  });

  it("viewer write denied: a member demoted to viewer cannot comment", async () => {
    // frank's per-board override is 'viewer'.
    await assertFails(create(FRANK, "byFrank", FRANK));
  });

  it("the author field cannot be forged on create", async () => {
    await assertFails(create(DAVE, "forged", ALICE));
  });

  it("a commenter can append a reply / resolve (update)", async () => {
    await assertSucceeds(
      updateDoc(doc(db(DAVE), "boards/boardWrite/comments/cmt1"), {
        replies: [{ id: "r1", authorId: DAVE, authorName: "Dave", body: "ok", createdAtMs: 1 }],
        updatedAt: new Date(),
      })
    );
  });

  it("a viewer cannot update a comment", async () => {
    await assertFails(
      updateDoc(doc(db(FRANK), "boards/boardWrite/comments/cmt1"), {
        resolved: true,
        updatedAt: new Date(),
      })
    );
  });

  it("a non-author non-admin commenter cannot delete someone else's comment", async () => {
    // cmt1 is authored by alice; dave is a commenter but not the author or admin.
    await assertFails(deleteDoc(doc(db(DAVE), "boards/boardWrite/comments/cmt1")));
  });

  it("the board admin can delete any comment (moderation)", async () => {
    await assertSucceeds(deleteDoc(doc(db(ALICE), "boards/boardWrite/comments/cmt1")));
  });

  it("a legacy board (no workspaceId) lets any member comment", async () => {
    await assertSucceeds(
      setDoc(doc(db(EVIL), "boards/boardLegacy/comments/byEvil"), newComment(EVIL, EVIL))
    );
  });
});

// ── Month 4 Phase 6: live cursors (member read, own-uid write) ─────────────────
describe("live cursors", () => {
  const cursor = (userId) => ({ userId, x: 1, y: 2, tool: "pen", updatedAt: 0 });

  it("a board member reads cursors", async () => {
    await assertSucceeds(getDoc(doc(db(DAVE), "boards/boardWrite/cursors/alice")));
  });

  it("a member writes their own cursor doc", async () => {
    await assertSucceeds(
      setDoc(doc(db(DAVE), "boards/boardWrite/cursors/dave"), cursor(DAVE))
    );
  });

  it("a member cannot write another user's cursor", async () => {
    await assertFails(
      setDoc(doc(db(DAVE), "boards/boardWrite/cursors/alice"), cursor(ALICE))
    );
  });

  it("a non-member cannot write a cursor", async () => {
    await assertFails(
      setDoc(doc(db(BOB), "boards/boardWrite/cursors/bob"), cursor(BOB))
    );
  });

  it("a board member outside the workspace cannot read cursors (cross-workspace)", async () => {
    // evil is in boardPrivate.members but NOT in wsA — the workspace gate denies.
    await assertFails(getDoc(doc(db(EVIL), "boards/boardPrivate/cursors/alice")));
  });

  it("a viewer-role member may still write their own cursor (cursors aren't canvas content)", async () => {
    // frank is demoted to 'viewer' on boardWrite but is still a board member, so
    // he can broadcast a cursor even though he can't write paths.
    await assertSucceeds(
      setDoc(doc(db(FRANK), "boards/boardWrite/cursors/frank"), cursor(FRANK))
    );
  });
});

// ── Phase 8: activity feed (read = workspace member, append-only) ──────────────
describe("activity feed", () => {
  const event = (actorId, workspaceId) => ({
    actorId,
    actorName: "X",
    verb: "board.created",
    targetType: "board",
    targetId: "boardPrivate",
    workspaceId,
    boardId: "boardPrivate",
    meta: {},
  });

  it("a workspace member can read the activity feed", async () => {
    await assertSucceeds(getDoc(doc(db(DAVE), "workspaces/wsA/activity/ev1")));
  });

  it("a non-member of the workspace cannot read the activity feed", async () => {
    // bob isn't in wsA — denied through the workspace-membership gate.
    await assertFails(getDoc(doc(db(BOB), "workspaces/wsA/activity/ev1")));
  });

  it("a workspace member can append an event with themselves as actor", async () => {
    await assertSucceeds(
      setDoc(doc(db(DAVE), "workspaces/wsA/activity/byDave"), event(DAVE, "wsA"))
    );
  });

  it("a non-member cannot append an event", async () => {
    await assertFails(
      setDoc(doc(db(BOB), "workspaces/wsA/activity/byBob"), event(BOB, "wsA"))
    );
  });

  it("the actorId cannot be forged on append", async () => {
    await assertFails(
      setDoc(doc(db(DAVE), "workspaces/wsA/activity/forged"), event(ALICE, "wsA"))
    );
  });

  it("the event's workspaceId must match the path it's written under", async () => {
    await assertFails(
      setDoc(doc(db(DAVE), "workspaces/wsA/activity/mismatch"), event(DAVE, "wsB"))
    );
  });

  it("append-only: an existing event cannot be updated", async () => {
    await assertFails(
      updateDoc(doc(db(ALICE), "workspaces/wsA/activity/ev1"), { verb: "session.ended" })
    );
  });

  it("append-only: an existing event cannot be deleted (even by the actor/owner)", async () => {
    await assertFails(deleteDoc(doc(db(ALICE), "workspaces/wsA/activity/ev1")));
  });
});

// ── Phase 10: in-app notifications (owner-read, actor-pinned create) ───────────
describe("in-app notifications", () => {
  const notif = (actorId, recipientId) => ({
    recipientId,
    type: "mention",
    actorId,
    actorName: "Dave",
    boardId: "boardWrite",
    boardTitle: "Write",
    commentId: "cmt1",
    snippet: "hey",
    read: false,
  });

  it("the recipient (owner) reads their own notifications", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "users/alice/notifications/n1")));
  });

  it("no one else can read another user's notifications", async () => {
    // dave authored it but it isn't addressed to him — the inbox is owner-only.
    await assertFails(getDoc(doc(db(DAVE), "users/alice/notifications/n1")));
  });

  it("an actor can create a notification addressed to another user", async () => {
    await assertSucceeds(
      setDoc(doc(db(DAVE), "users/alice/notifications/byDave"), notif(DAVE, ALICE))
    );
  });

  it("the actorId cannot be forged on create", async () => {
    await assertFails(
      setDoc(doc(db(DAVE), "users/alice/notifications/forgedActor"), notif(ALICE, ALICE))
    );
  });

  it("the recipientId must match the path owner on create", async () => {
    await assertFails(
      setDoc(doc(db(DAVE), "users/alice/notifications/wrongRecip"), notif(DAVE, DAVE))
    );
  });

  // Anti-spam (Phase 10): a correctly-pinned notification is still rejected unless
  // the actor and recipient share the referenced board's workspace.
  it("an actor outside the board's workspace cannot plant a notification", async () => {
    // bob is wsB-only; boardWrite is in wsA — even pinned correctly, this is spam.
    await assertFails(
      setDoc(doc(db(BOB), "users/alice/notifications/spam"), notif(BOB, ALICE))
    );
  });

  it("a notification whose recipient isn't in the board's workspace is rejected", async () => {
    // evil is a member of some boards but not of wsA, so dave can't mention them here.
    await assertFails(
      setDoc(doc(db(DAVE), "users/evil/notifications/x"), notif(DAVE, EVIL))
    );
  });

  it("the owner can mark a notification read (read-only field change)", async () => {
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "users/alice/notifications/n1"), { read: true })
    );
  });

  it("the owner cannot edit the immutable payload (only `read`)", async () => {
    await assertFails(
      updateDoc(doc(db(ALICE), "users/alice/notifications/n1"), { snippet: "tampered" })
    );
  });

  it("a non-owner cannot mark someone else's notification read", async () => {
    await assertFails(
      updateDoc(doc(db(DAVE), "users/alice/notifications/n1"), { read: true })
    );
  });

  it("the owner can dismiss (delete) their notification; others cannot", async () => {
    await assertFails(deleteDoc(doc(db(DAVE), "users/alice/notifications/n1")));
    await assertSucceeds(deleteDoc(doc(db(ALICE), "users/alice/notifications/n1")));
  });
});

// ── Month 4 Phase 1: AI telemetry is Functions-only-write, admin-read ──────────
// These docs are written by Cloud Functions via the Admin SDK (which bypasses
// rules); every client write must be denied, and reads are limited to workspace
// owner/admins. This is the hard gate for the AI-gateway cutover.
describe("AI telemetry (aiUsage / aiLog / aiRate)", () => {
  it("the workspace owner reads aiUsage and aiLog", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "workspaces/wsA/aiUsage/2026-06")));
    await assertSucceeds(getDoc(doc(db(ALICE), "workspaces/wsA/aiLog/call1")));
  });

  it("a non-admin member cannot read aiUsage or aiLog", async () => {
    // dave is a plain workspace member, not owner/admin.
    await assertFails(getDoc(doc(db(DAVE), "workspaces/wsA/aiUsage/2026-06")));
    await assertFails(getDoc(doc(db(DAVE), "workspaces/wsA/aiLog/call1")));
  });

  it("a non-member cannot read aiUsage or aiLog", async () => {
    await assertFails(getDoc(doc(db(BOB), "workspaces/wsA/aiUsage/2026-06")));
    await assertFails(getDoc(doc(db(BOB), "workspaces/wsA/aiLog/call1")));
  });

  it("no client can write aiUsage — even the owner", async () => {
    await assertFails(
      setDoc(doc(db(ALICE), "workspaces/wsA/aiUsage/2026-07"), { calls: 1 })
    );
    await assertFails(
      updateDoc(doc(db(ALICE), "workspaces/wsA/aiUsage/2026-06"), { calls: 99 })
    );
  });

  it("no client can write aiLog — even the owner", async () => {
    await assertFails(
      setDoc(doc(db(ALICE), "workspaces/wsA/aiLog/forged"), { uid: ALICE, tokens: 1 })
    );
  });

  it("the aiRate bucket is fully opaque to clients (no read, no write)", async () => {
    await assertFails(getDoc(doc(db(ALICE), "workspaces/wsA/aiRate/bucket")));
    await assertFails(
      setDoc(doc(db(ALICE), "workspaces/wsA/aiRate/bucket"), { tokens: 999, updatedAt: 0 })
    );
  });
});

// ── Phase 10: OCR cache is member-read, Functions-only-write ───────────────────
describe("OCR cache (ocrCache)", () => {
  it("a board member reads a cached OCR result", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "boards/boardCoded/ocrCache/hash1")));
  });

  it("a non-member cannot read the OCR cache", async () => {
    await assertFails(getDoc(doc(db(BOB), "boards/boardCoded/ocrCache/hash1")));
  });

  it("no client can write the OCR cache — even a board member", async () => {
    await assertFails(
      setDoc(doc(db(ALICE), "boards/boardCoded/ocrCache/forged"), {
        text: "x", confidence: 1, source: "vision", model: "google-vision", createdAt: 0,
      })
    );
  });
});

// ── Phase 8: embed token read path ────────────────────────────────────────────
// An embed viewer is a custom-token identity carrying { embed, embedBoardId }
// claims (minted by exchangeEmbedToken after verifying a signed link token). The
// claim is board-scoped: read-only access to exactly one board + its canvas.
// `embed:<id>` is the deterministic embed uid (see exchangeEmbedToken.embedUid).
function embedDb(boardId) {
  return testEnv
    .authenticatedContext(`embed:${boardId}`, { embed: true, embedBoardId: boardId, embedScope: "view" })
    .firestore();
}

describe("embed token read path", () => {
  it("an embed viewer reads the board it is scoped to", async () => {
    await assertSucceeds(getDoc(doc(embedDb("boardPrivate"), "boards/boardPrivate")));
  });

  it("an embed viewer reads that board's canvas content", async () => {
    await assertSucceeds(getDoc(doc(embedDb("boardPrivate"), "boards/boardPrivate/paths/pP")));
  });

  it("an embed viewer cannot write canvas content (read-only)", async () => {
    await assertFails(
      setDoc(doc(embedDb("boardPrivate"), "boards/boardPrivate/paths/forged"), { userId: "embed:boardPrivate" })
    );
  });

  it("an embed viewer cannot read a different board (board-scoped claim)", async () => {
    await assertFails(getDoc(doc(embedDb("boardPrivate"), "boards/boardLegacy")));
    await assertFails(getDoc(doc(embedDb("boardPrivate"), "boards/boardLegacy/paths/p1")));
  });

  it("an embed viewer cannot edit the board doc or join as a member", async () => {
    await assertFails(
      updateDoc(doc(embedDb("boardPrivate"), "boards/boardPrivate"), { title: "hijacked" })
    );
  });

  it("a signed-in non-member with no embed claim is still denied (claim is required)", async () => {
    // BOB is in a different workspace and holds no embed claim — the ordinary gate.
    await assertFails(getDoc(doc(db(BOB), "boards/boardPrivate")));
  });
});
