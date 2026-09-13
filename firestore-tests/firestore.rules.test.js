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
  deleteField,
  collection,
  query,
  where,
  getDocs,
  getCountFromServer,
  writeBatch,
} = require("firebase/firestore");

const ALICE = "alice";
const BOB = "bob";
const EVIL = "evil";
// Phase 6 actors, all members of wsA with different workspace roles:
const CAROL = "carol"; // workspace viewer
const DAVE = "dave";   // workspace member
const FRANK = "frank"; // workspace member (demoted to viewer on boardWrite)

// Month 6 — education pilot actors. instructorA/instructorB each
// teach one class; studentA1/studentA2 are both enrolled in classA (proves
// student<->student isolation WITHIN one class, not just across classes);
// studentB1 is enrolled in classB; studentC is enrolled nowhere (the
// self-enrollment + "random stranger" actor).
const INSTRUCTOR_A = "instructorA";
const INSTRUCTOR_B = "instructorB";
const INSTRUCTOR_C = "instructorC";
const STUDENT_A1 = "studentA1";
const STUDENT_A2 = "studentA2";
const STUDENT_B1 = "studentB1";
const STUDENT_C = "studentC";

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
    // M5 seat cap — a pro workspace, so the cap tests can prove the rule actually
    // reads the plan rather than hardcoding the free number.
    await setDoc(doc(db, "workspaces/wsPro"), {
      name: "Pro WS",
      ownerId: ALICE,
      members: { [ALICE]: "owner", [DAVE]: "member" },
      memberIds: [ALICE, DAVE],
      plan: "pro",
    });
    // M5 seat cap — an unrecognized plan string (a future tier, a corrupt value).
    // Must fall back to the free cap, the same way limitFor does on the Functions
    // side, and must NOT error: an erroring cap predicate would lock every member
    // of this workspace out of their own boards.
    await setDoc(doc(db, "workspaces/wsWeird"), {
      name: "Weird WS",
      ownerId: ALICE,
      members: { [ALICE]: "owner", [DAVE]: "member" },
      memberIds: [ALICE, DAVE],
      plan: "team-tier-that-does-not-exist",
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
    // Month 5 — voice notes (ROADMAP.md:583-587). Same member-read /
    // editor-write gate as every other canvas-content subcollection; seeded
    // here so the denial tests below have a real doc to read.
    await setDoc(doc(db, "boards/boardWrite/audio/seed"), { userId: ALICE });

    // M5 seat cap fixtures. `collaboratorsPerBoard` counts the whole `members`
    // array, so free = 4 total.
    //   boardFull    — wsA (free), exactly AT the cap (4 members), invite-coded
    //   boardProFull — wsPro (pro, cap 25), same 4 members, invite-coded
    //   boardOverCap — wsA (free), ALREADY OVER the cap (6 members), invite-coded;
    //                  the post-downgrade state that must stay editable/shrinkable
    await setDoc(doc(db, "boards/boardFull"), {
      workspaceId: "wsA",
      title: "Full",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE, CAROL, DAVE, FRANK],
      inviteCode: "BORD-FULLLL",
    });
    await setDoc(doc(db, "boards/boardProFull"), {
      workspaceId: "wsPro",
      title: "Pro Full",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE, CAROL, DAVE, FRANK],
      inviteCode: "BORD-PROFUL",
    });
    await setDoc(doc(db, "boards/boardOverCap"), {
      workspaceId: "wsA",
      title: "Over Cap",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE, CAROL, DAVE, FRANK, EVIL, "extra1"],
      inviteCode: "BORD-OVERCP",
    });
    //   boardWeirdFull/boardWeirdSmall — on the unrecognized-plan workspace, at
    //   and under the free cap respectively
    await setDoc(doc(db, "boards/boardWeirdFull"), {
      workspaceId: "wsWeird",
      title: "Weird Full",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE, CAROL, DAVE, FRANK],
      inviteCode: "BORD-WEIRDF",
    });
    await setDoc(doc(db, "boards/boardWeirdSmall"), {
      workspaceId: "wsWeird",
      title: "Weird Small",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE, DAVE],
      inviteCode: "BORD-WEIRDS",
    });
    //   boardLegacyFull — no workspaceId AND at the free cap, so the legacy
    //   fallback can be pinned to 4 rather than merely "resolves to something"
    await setDoc(doc(db, "boards/boardLegacyFull"), {
      // no workspaceId — a board created before the Phase 2 migration
      title: "Legacy Full",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE, CAROL, DAVE, FRANK],
      inviteCode: "BORD-LEGFUL",
    });

    // Month 5 — the worst case for the invite-code self-join arm, all three
    // properties at once: LEGACY (no workspaceId, so inBoardWorkspace waves
    // everything through and isBoardEditor's null-workspace disjunct fires),
    // INVITE-CODED (so the self-join arm is live) and UNDER the free cap of 4 (so
    // withinSeatCap cannot be what denies a join). Without all three, an "embed
    // identity cannot self-join" test passes on fixture accidents rather than on
    // the rule. A non-embed signed-in user CAN join this board — asserted below,
    // which is what proves the board is genuinely joinable.
    await setDoc(doc(db, "boards/boardLegacyOpen"), {
      // no workspaceId — a board created before the Phase 2 migration
      title: "Legacy, invite-coded, under cap",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE],
      inviteCode: "BORD-LEGOPN",
    });
    await setDoc(doc(db, "boards/boardLegacyOpen/paths/pLO"), { userId: ALICE });

    // Usage-dashboard regression fixture — the shape scripts/migrate-workspaces.js
    // (the M3 backfill) produces for a legacy board: workspaceId stamped in,
    // inviteCode untouched and still null. src/services/usageService.ts's
    // countWorkspaceBoards can't run the server's exact `countBoards` query
    // (workspaceId alone — see that function's doc comment for why), so it adds
    // an `inviteCode != null` filter to satisfy the rules' provability check.
    // This board proves that filter's cost: it HAS a workspaceId (the server's
    // countBoards would include it) but the client aggregation below must not.
    await setDoc(doc(db, "boards/boardMigratedNoCode"), {
      workspaceId: "wsA",
      title: "Migrated, never got an invite code",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE],
      inviteCode: null,
    });

    // Phase 7 — comment fixtures (one per board), authored by alice.
    const seedComment = { anchorElementId: "seed", anchorKind: "shape", authorId: ALICE, body: "hi", replies: [], resolved: false };
    await setDoc(doc(db, "boards/boardWrite/comments/cmt1"), seedComment);
    await setDoc(doc(db, "boards/boardPrivate/comments/cmtP"), seedComment);
    await setDoc(doc(db, "boards/boardLegacy/comments/cmtL"), seedComment);

    // Month 6 — reaction fixtures (one per board), reacted by alice. Doc ids
    // follow the real `{elementId}_{emoji}_{userId}` shape so the read/delete
    // tests below exercise the actual production path, not a stand-in id.
    const seedReaction = (userId) => ({
      schemaVersion: 1,
      anchorElementId: "seed",
      anchorKind: "shape",
      emoji: "👍",
      userId,
    });
    await setDoc(doc(db, "boards/boardWrite/reactions/seed_👍_alice"), seedReaction(ALICE));
    await setDoc(doc(db, "boards/boardPrivate/reactions/seed_👍_alice"), seedReaction(ALICE));

    // Month 6 — poll fixtures. `pollSingle` is a genuinely NON-anonymous poll
    // with one real seeded vote (alice) so the "a member can read a
    // non-anonymous poll's votes" positive control below has a real doc to
    // read, not an empty collection that would pass for the wrong reason.
    // `pollAnon` is the anonymous twin, same shape, so every "denied" test
    // against it has a same-board, same-actor, same-shape "allowed" sibling
    // differing ONLY in `anonymous` — proving the denial is about anonymity,
    // not about votes being unreadable in general.
    const seedPoll = (overrides) => ({
      schemaVersion: 1,
      boardId: "boardWrite",
      question: "Favorite color?",
      options: ["Red", "Blue", "Green"],
      anonymous: false,
      mode: "single",
      x: 10,
      y: 10,
      createdById: ALICE,
      ...overrides,
    });
    await setDoc(doc(db, "boards/boardWrite/polls/pollSingle"), seedPoll());
    await setDoc(doc(db, "boards/boardWrite/polls/pollSingle/votes/alice"), {
      userId: ALICE,
      optionIndices: [0],
      // Fix round 2 — the vote's OWN stamp is what gates its read now, not
      // the parent poll's (mutable, recreatable) field — see
      // firestore.rules' votes-read header. Every seeded vote below is
      // stamped to match the poll it's actually seeded under.
      anonymous: false,
    });
    await setDoc(doc(db, "boards/boardWrite/polls/pollAnon"), seedPoll({ anonymous: true }));
    await setDoc(doc(db, "boards/boardWrite/polls/pollAnon/votes/alice"), {
      userId: ALICE,
      optionIndices: [1],
      anonymous: true,
    });
    // A dots-mode poll (4 options) — same board/read/write boundary, only
    // `mode` differs, for the dot-voting-specific rules tests below.
    await setDoc(
      doc(db, "boards/boardWrite/polls/pollDots"),
      seedPoll({ mode: "dots", options: ["A", "B", "C", "D"] })
    );

    // Cross-workspace fixture, mirroring the reaction/comment ones above:
    // evil is in boardPrivate.members but not in wsA.
    await setDoc(doc(db, "boards/boardPrivate/polls/pollP"), {
      schemaVersion: 1,
      boardId: "boardPrivate",
      question: "Q?",
      options: ["A", "B"],
      anonymous: false,
      mode: "single",
      x: 0,
      y: 0,
      createdById: ALICE,
    });
    await setDoc(doc(db, "boards/boardPrivate/polls/pollP/votes/alice"), {
      userId: ALICE,
      optionIndices: [0],
      anonymous: false,
    });

    // Legacy-board tolerance fixture (no workspaceId) — mirrors reactions'
    // own "a legacy board lets any member [write]" fixture.
    await setDoc(doc(db, "boards/boardLegacy/polls/pollLegacy"), {
      schemaVersion: 1,
      boardId: "boardLegacy",
      question: "Q?",
      options: ["A", "B"],
      anonymous: false,
      mode: "single",
      x: 0,
      y: 0,
      createdById: ALICE,
    });

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
    // Fix round 3, A — has an EXISTING participant (evil), unlike
    // sessCoded above (empty participantIds): needed to test that an
    // ALREADY-joined caller can't add an arbitrary uid, the exact shape
    // C1 fixed on `classes`.
    await setDoc(doc(db, "sessions/sessCodedWithParticipant"), {
      workspaceId: "wsA",
      boardId: "boardCoded",
      createdById: ALICE,
      participantIds: [EVIL],
      joinCode: "SESS-FFFFFF",
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

    // M5 — plan metering docs (written by Functions in prod). Seeded here with
    // rules bypassed to test client read/write access against them.
    await setDoc(doc(db, "workspaces/wsA/usage/2026-09"), { sessions: 1, updatedAt: 0 });
    await setDoc(doc(db, "workspaces/wsA/billing/subscription"), { plan: "free" });

    // Phase 10 — an OCR cache entry the function would have written.
    await setDoc(doc(db, "boards/boardCoded/ocrCache/hash1"), {
      text: "Hi", confidence: 0.9, source: "vision", model: "google-vision", createdAt: 0,
    });

    // Month 6 — a seeded math element and a seeded render-cache entry the
    // `renderMath` Cloud Function would have written. `boardWrite` is the
    // board whose per-role membership (editor/viewer/commenter) the write
    // tests below exercise; `boardCoded` carries the cache entry, matching
    // where ocrCache's own entry lives.
    await setDoc(doc(db, "boards/boardWrite/mathElements/m1"), {
      schemaVersion: 1,
      type: "math",
      boardId: "boardWrite",
      userId: ALICE,
      latex: "x^2",
      svgPath: "M 0 0 L 1 1",
      x: 0,
      y: 0,
      width: 20,
      height: 18,
      scale: 1,
    });
    await setDoc(doc(db, "boards/boardCoded/mathCache/hash1"), {
      svgPath: "M 0 0 L 1 1",
      width: 20,
      height: 18,
      createdAt: 0,
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

    // Month 6 — a seeded flashcard deck + card, owned by alice. Per-user
    // scheduling: lives under `users/alice/decks/...`, never under a board.
    await setDoc(doc(db, "users/alice/decks/deck1"), {
      schemaVersion: 1,
      name: "Biology 101",
      boardId: "boardCoded",
    });
    await setDoc(doc(db, "users/alice/decks/deck1/cards/card1"), {
      schemaVersion: 1,
      front: "What is the powerhouse of the cell?",
      back: "The mitochondria",
      repetitions: 0,
      intervalDays: 0,
      easeFactor: 2.5,
      dueAtMs: 0,
    });

    // ── Month 6 — education pilot fixtures ──────────────────────────────────
    // classC exists only to isolate the classId PIN from the enrollment
    // gate below: studentA1 is deliberately enrolled in BOTH classA and
    // classC, so "denies re-parenting" tests can prove the PIN fires even
    // when the caller genuinely is enrolled in the target class.
    await setDoc(doc(db, "classes/classA"), {
      name: "CS 101 (A)",
      instructorId: INSTRUCTOR_A,
      joinCode: "CLASSA1",
      studentIds: [STUDENT_A1, STUDENT_A2],
    });
    await setDoc(doc(db, "classes/classB"), {
      name: "CS 101 (B)",
      instructorId: INSTRUCTOR_B,
      joinCode: "CLASSB1",
      studentIds: [STUDENT_B1],
    });
    await setDoc(doc(db, "classes/classC"), {
      name: "CS 101 (C)",
      instructorId: INSTRUCTOR_C,
      joinCode: "CLASSC1",
      studentIds: [STUDENT_A1],
    });
    // Fix round 2, S1 — a THREE-student roster, used only by the
    // duplicate-uid removal test: classA's own 2-student roster can't
    // exercise that shape (shrinking 2 -> a 2-entry duplicate array isn't
    // even a size-1 shrink).
    await setDoc(doc(db, "classes/classD"), {
      name: "CS 101 (D)",
      instructorId: INSTRUCTOR_A,
      joinCode: "CLASSD1",
      studentIds: [STUDENT_A1, STUDENT_A2, STUDENT_B1],
    });

    // Fix round 1, I4 — the narrow self-enrollment lookup collection, one
    // doc per seeded class, matching what `createClass` would have written
    // in the same batch as the class doc itself.
    await setDoc(doc(db, "joinCodes/CLASSA1"), { classId: "classA" });
    await setDoc(doc(db, "joinCodes/CLASSB1"), { classId: "classB" });
    await setDoc(doc(db, "joinCodes/CLASSC1"), { classId: "classC" });
    await setDoc(doc(db, "joinCodes/CLASSD1"), { classId: "classD" });

    // Assignment boards — no workspaceId. The education-pilot linkage
    // (classId) is independent of workspace membership entirely; the
    // legacy (no-workspaceId) fallback keeps each board readable by its own
    // owner/member the same way it already does for boardLegacy above.
    await setDoc(doc(db, "boards/boardA1"), {
      title: "Student A1's board",
      ownerId: STUDENT_A1,
      adminId: STUDENT_A1,
      members: [STUDENT_A1],
      inviteCode: null,
      classId: "classA",
    });
    await setDoc(doc(db, "boards/boardA2"), {
      title: "Student A2's board",
      ownerId: STUDENT_A2,
      adminId: STUDENT_A2,
      members: [STUDENT_A2],
      inviteCode: null,
      classId: "classA",
    });
    await setDoc(doc(db, "boards/boardB1"), {
      title: "Student B1's board",
      ownerId: STUDENT_B1,
      adminId: STUDENT_B1,
      members: [STUDENT_B1],
      inviteCode: null,
      classId: "classB",
    });
    // Not yet attached to any class — the classIdTransitionValid "first
    // transition" fixture.
    await setDoc(doc(db, "boards/boardNoClass"), {
      title: "Unattached board",
      ownerId: STUDENT_A1,
      adminId: STUDENT_A1,
      members: [STUDENT_A1],
      inviteCode: null,
    });
    // A board with a non-owner member, to prove enrollment ALONE isn't
    // enough to attach classId — the caller must also be the board admin.
    await setDoc(doc(db, "boards/boardSharedNoClass"), {
      title: "Shared unattached board",
      ownerId: STUDENT_A1,
      adminId: STUDENT_A1,
      members: [STUDENT_A1, STUDENT_A2],
      inviteCode: null,
    });
    // Fix round 1, I3 — attached to classC (which the test below deletes
    // mid-test) so the classId-clears-after-delete transition has a real
    // board to exercise.
    await setDoc(doc(db, "boards/boardInClassC"), {
      title: "Board in class C",
      ownerId: STUDENT_A1,
      adminId: STUDENT_A1,
      members: [STUDENT_A1],
      inviteCode: null,
      classId: "classC",
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

  // Month 5 — voice notes' `audio` subcollection gets the same gate as
  // `paths`/`images`/etc. above; this is the actual emulator-backed proof
  // that a non-member is denied (a grep of this file for "audio" returned
  // zero matches before this test existed).
  it("a non-member cannot read the audio subcollection", async () => {
    await assertFails(getDoc(doc(db(BOB), "boards/boardWrite/audio/seed")));
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

// ── board create is Cloud-Function-only (M5) ──────────────────────────────────
// Was: a workspace member could addDoc a board directly. That path is denied now
// so the plan's board cap (enforced in functions/src/callable/createBoard.ts,
// which writes via the Admin SDK and bypasses rules) cannot be bypassed.
describe("board create", () => {
  it("denies a direct client board create, even a fully legitimate-looking one", async () => {
    // alice owns wsA and pins herself as ownerId — everything the old rule asked
    // for. Denied anyway: rules cannot count a workspace's boards.
    await assertFails(
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

  it("still cannot plant a board in a workspace you don't belong to", async () => {
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

  it("denies a legacy (no-workspaceId) board create too", async () => {
    // The pre-migration escape hatch is closed on CREATE. Existing workspace-less
    // boards stay readable and writable (see the legacy-board tests above); only
    // new ones are refused.
    await assertFails(
      setDoc(doc(db(ALICE), "boards/newLegacy"), {
        title: "Legacy-ish",
        ownerId: ALICE,
        adminId: ALICE,
        members: [ALICE],
        inviteCode: null,
      })
    );
  });

  it("deleting a board is unaffected — only create is denied", async () => {
    await assertSucceeds(deleteDoc(doc(db(ALICE), "boards/boardPrivate")));
  });
});

// ── M5 seat cap (collaboratorsPerBoard) ───────────────────────────────────────
// The cap is a rules predicate rather than a callable because the invite-code
// self-join path is a client `update` to `members`. Numbers come from
// functions/src/billing/limits.ts: free 4, pro 25, edu 100 — held in agreement by
// the drift test in functions/src/__tests__/limits.test.ts.
describe("M5 seat cap", () => {
  it("denies a self-join that would exceed the free cap", async () => {
    // boardFull sits at 4/4 on free wsA; bob would be the 5th.
    await assertFails(
      updateDoc(doc(db(BOB), "boards/boardFull"), {
        members: [ALICE, CAROL, DAVE, FRANK, BOB],
        updatedAt: new Date(),
      })
    );
  });

  it("allows a self-join under the free cap", async () => {
    // boardCoded sits at 2/4 on free wsA; bob would be the 3rd.
    await assertSucceeds(
      updateDoc(doc(db(BOB), "boards/boardCoded"), {
        members: [ALICE, EVIL, BOB],
        updatedAt: new Date(),
      })
    );
  });

  it("allows the same 5th self-join on a pro workspace (the cap reads the plan)", async () => {
    // Identical shape to the denied case above, only the workspace's plan differs
    // — this is what proves the rule resolves the plan instead of hardcoding 4.
    await assertSucceeds(
      updateDoc(doc(db(BOB), "boards/boardProFull"), {
        members: [ALICE, CAROL, DAVE, FRANK, BOB],
        updatedAt: new Date(),
      })
    );
  });

  it("denies the board ADMIN adding a member past the cap (the share-by-email path)", async () => {
    // The realistic bypass: the owner shares the board rather than a stranger
    // self-joining. boardService.addMemberById/addMemberByEmail land here.
    await assertFails(
      updateDoc(doc(db(ALICE), "boards/boardFull"), {
        members: [ALICE, CAROL, DAVE, FRANK, BOB],
        updatedAt: new Date(),
      })
    );
  });

  it("denies a board EDITOR adding someone past the cap", async () => {
    // dave is a wsA member with no override, so he resolves to editor on
    // boardFull — this is the editor arm.
    await assertFails(
      updateDoc(doc(db(DAVE), "boards/boardFull"), {
        members: [ALICE, CAROL, DAVE, FRANK, BOB],
        updatedAt: new Date(),
      })
    );
  });

  it("denies a plain board MEMBER adding someone past the cap", async () => {
    // carol is a wsA *viewer*, so she fails isEffectiveEditor and reaches the
    // rule only through the member arm (members/updatedAt bookkeeping). That is
    // the arm this test is here to cover.
    await assertFails(
      updateDoc(doc(db(CAROL), "boards/boardFull"), {
        members: [ALICE, CAROL, DAVE, FRANK, BOB],
        updatedAt: new Date(),
      })
    );
  });

  it("lets the admin still edit a board that is exactly at the cap", async () => {
    // The cap must gate GROWTH only; an at-cap board is not frozen.
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "boards/boardFull"), {
        title: "Renamed",
        updatedAt: new Date(),
      })
    );
  });

  it("lets a member leave a board that is already OVER cap (post-downgrade thaw)", async () => {
    // boardOverCap has 6 members on a free (cap 4) workspace — the state a pro →
    // free downgrade leaves behind. Shrinking to 5 is still over the cap, so this
    // passes only via the `<= current size` clause. Without that clause the board
    // would be permanently frozen.
    await assertSucceeds(
      updateDoc(doc(db(DAVE), "boards/boardOverCap"), {
        members: [ALICE, CAROL, FRANK, EVIL, "extra1"],
        updatedAt: new Date(),
      })
    );
  });

  it("lets the admin still edit an over-cap board", async () => {
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "boards/boardOverCap"), {
        title: "Renamed while over cap",
        updatedAt: new Date(),
      })
    );
  });

  it("denies growing an over-cap board even further", async () => {
    await assertFails(
      updateDoc(doc(db(BOB), "boards/boardOverCap"), {
        members: [ALICE, CAROL, DAVE, FRANK, EVIL, "extra1", BOB],
        updatedAt: new Date(),
      })
    );
  });

  // An unrecognized plan must fall back to the free cap — and must resolve, not
  // error. These two tests together are what distinguish "fell back to 4" from
  // "the predicate threw and denied everything", which would lock this
  // workspace's members out of their own boards.
  it("falls back to the free cap for an unrecognized plan (denies the 5th)", async () => {
    await assertFails(
      updateDoc(doc(db(BOB), "boards/boardWeirdFull"), {
        members: [ALICE, CAROL, DAVE, FRANK, BOB],
        updatedAt: new Date(),
      })
    );
  });

  it("still allows a join UNDER the free cap on an unrecognized plan", async () => {
    // Denial above must come from the size comparison, not from a throw.
    await assertSucceeds(
      updateDoc(doc(db(BOB), "boards/boardWeirdSmall"), {
        members: [ALICE, DAVE, BOB],
        updatedAt: new Date(),
      })
    );
  });

  // A legacy board has no workspaceId, so no plan: the smallest cap applies, the
  // same fail-closed fallback limitFor uses on the Functions side. These two
  // together pin the fallback at exactly 4 — the success case alone would pass at
  // any cap >= 3, and the denial alone could be a throw.
  it("caps a legacy board with no workspaceId at the free limit (denies the 5th)", async () => {
    // boardLegacyFull has 4 members and no workspaceId.
    await assertFails(
      updateDoc(doc(db(BOB), "boards/boardLegacyFull"), {
        members: [ALICE, CAROL, DAVE, FRANK, BOB],
        updatedAt: new Date(),
      })
    );
  });

  it("still allows a join UNDER the free cap on a legacy board", async () => {
    // boardLegacy has 2 members, so growth to 3 is allowed — the cap resolves
    // rather than erroring on the missing workspaceId.
    await assertSucceeds(
      updateDoc(doc(db(EVIL), "boards/boardLegacy"), {
        members: [ALICE, EVIL, "third"],
        updatedAt: new Date(),
      })
    );
  });
});

// ── M5: a board's workspaceId is pinned on update ─────────────────────────────
// The board cap counts boards per workspace (countBoards filters on
// workspaceId), and a workspace-less board stays fully usable — inBoardWorkspace
// permits a null workspaceId and the board list keeps such boards visible. So a
// client able to unset the field could hide its boards from the count and earn a
// fresh allowance, repeatedly. Only the admin arm can write arbitrary fields, so
// that is the route these tests close.
describe("M5 board workspaceId is pinned", () => {
  it("denies the board admin UNSETTING workspaceId (the countBoards bypass)", async () => {
    await assertFails(
      updateDoc(doc(db(ALICE), "boards/boardPrivate"), {
        workspaceId: deleteField(),
        updatedAt: new Date(),
      })
    );
  });

  it("denies the board admin setting workspaceId to null", async () => {
    // Same bypass, written the other way: countBoards' equality filter misses a
    // null just as it misses a missing field.
    await assertFails(
      updateDoc(doc(db(ALICE), "boards/boardPrivate"), {
        workspaceId: null,
        updatedAt: new Date(),
      })
    );
  });

  it("denies re-parenting a board into another workspace", async () => {
    // alice owns wsPro too, so this is a write she is otherwise authorized for.
    await assertFails(
      updateDoc(doc(db(ALICE), "boards/boardPrivate"), { workspaceId: "wsPro" })
    );
  });

  it("denies re-parenting into a Pro workspace to shop for a bigger seat cap", async () => {
    // The combined attack: move the board to a pro workspace and add the 5th
    // member in the same write. Denied twice over — the cap resolves the plan
    // from the STORED workspaceId, and the re-parent itself is refused.
    await assertFails(
      updateDoc(doc(db(ALICE), "boards/boardFull"), {
        workspaceId: "wsPro",
        members: [ALICE, CAROL, DAVE, FRANK, BOB],
        updatedAt: new Date(),
      })
    );
  });

  it("denies stamping a workspaceId onto a legacy board from the client", async () => {
    // The Phase 9 backfill does this via the Admin SDK, which bypasses rules.
    await assertFails(
      updateDoc(doc(db(ALICE), "boards/boardLegacy"), { workspaceId: "wsA" })
    );
  });

  it("still allows an ordinary admin edit that leaves workspaceId alone", async () => {
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "boards/boardPrivate"), {
        title: "Renamed",
        updatedAt: new Date(),
      })
    );
  });

  it("still allows an update that re-sends the SAME workspaceId", async () => {
    // The pin compares values, so an idempotent write is not collateral damage.
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "boards/boardPrivate"), {
        workspaceId: "wsA",
        title: "Renamed again",
      })
    );
  });

  it("still allows a legacy board's ordinary edits (workspaceId stays absent)", async () => {
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "boards/boardLegacy"), { title: "Legacy renamed" })
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

  // ── session create is Cloud-Function-only (M5) ──────────────────────────────
  // Was: a workspace member could addDoc a session directly with any joinCode.
  // Denied now — rules cannot read the workspace's monthly session counter, and
  // the joinCode must be server-generated. functions/src/callable/createSession.ts
  // writes via the Admin SDK and bypasses these rules.
  it("denies a direct client session create, even a fully legitimate-looking one", async () => {
    await assertFails(
      setDoc(doc(db(ALICE), "sessions/newSessA"), {
        workspaceId: "wsA",
        boardId: "boardPrivate",
        createdById: ALICE,
        participantIds: [],
        joinCode: "SESS-BBBBBB",
      })
    );
  });

  it("still cannot plant a session in a workspace you don't belong to", async () => {
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

  it("denies a legacy (no-workspaceId) session create too", async () => {
    // The callable requires a workspaceId, so no new workspace-less session can
    // appear by any path. Existing ones stay readable (see the test above).
    await assertFails(
      setDoc(doc(db(ALICE), "sessions/newSessLegacy"), {
        boardId: "boardLegacy",
        createdById: ALICE,
        participantIds: [],
        joinCode: "SESS-DDDDDD",
      })
    );
  });

  it("the joinCode self-join update still works — only create is denied", async () => {
    await assertSucceeds(
      updateDoc(doc(db(BOB), "sessions/sessCoded"), { participantIds: [BOB] })
    );
  });

  // Fix round 3, A (CRITICAL vector, same shape as `classes`' C1) — this
  // arm was the pre-C1 shape verbatim: `hasAll(prev)` + `size==prev+1` +
  // `hasAny([caller])`, with no check that the caller wasn't ALREADY a
  // participant. `evil` is already in sessCodedWithParticipant's
  // `participantIds`, so (pre-fix) `evil` could add ANY third uid: already
  // in `prev`, so trivially in `next` too, and nothing pinned the ADDED
  // element to `evil` specifically.
  it("CRITICAL: denies an ALREADY-joined participant from adding an arbitrary third party", async () => {
    await assertFails(
      updateDoc(doc(db(EVIL), "sessions/sessCodedWithParticipant"), {
        participantIds: [EVIL, "stranger"],
      })
    );
  });

  // Positive control: a genuinely NEW caller can still join the SAME
  // session via the SAME joinCode path — the fix denies the exploit, not
  // ordinary self-join.
  it("still lets a genuinely new caller join that same session", async () => {
    await assertSucceeds(
      updateDoc(doc(db(BOB), "sessions/sessCodedWithParticipant"), {
        participantIds: [EVIL, BOB],
      })
    );
  });

  // Confirms the review's own pre-flight check: a participant re-joining
  // (resubmitting the UNCHANGED list) already failed the size==prev+1
  // check before this fix and still does after it — this fix denies
  // nothing that currently succeeds, only the exploit above.
  it("a participant re-submitting the unchanged list is still denied (pre-existing, unaffected by this fix)", async () => {
    await assertFails(
      updateDoc(doc(db(EVIL), "sessions/sessCodedWithParticipant"), {
        participantIds: [EVIL],
      })
    );
  });

  it("the creator can still update and delete their session", async () => {
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "sessions/sessWsA"), { status: "active" })
    );
    await assertSucceeds(deleteDoc(doc(db(ALICE), "sessions/sessWsA")));
  });
});

// ── Phase 6: per-board roles (editor/commenter/viewer) ───────────────────────
// Writes to canvas content resolve an effective role through the workspace floor
// plus per-board overrides. Reads stay at board-member level.
describe("per-board roles", () => {
  const path = (uid, docId) =>
    setDoc(doc(db(uid), `boards/boardWrite/paths/${docId}`), { userId: uid });
  const audio = (uid, docId) =>
    setDoc(doc(db(uid), `boards/boardWrite/audio/${docId}`), { userId: uid });

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

  // Month 5 — voice notes' `audio` match uses the same isBoardEditor() write
  // gate as `paths` above; proves it actually denies a viewer rather than
  // merely mirroring the images rule in text.
  it("viewer write denied: a workspace viewer cannot write to the audio subcollection", async () => {
    await assertFails(audio(CAROL, "byCarol"));
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

// ── Month 6: voice notes are Pro-tier — enforced in rules, not just the
// advisory client check (src/services/audioService.ts's `canRecordVoiceNotes`
// header). boardWrite is wsA (free); boardProFull is wsPro (pro), same shape
// of membership — only the workspace's plan differs between the two.
describe("voice notes: Pro-tier plan gate (Month 6)", () => {
  it("denies creating a voice note on a free-plan board, even for an editor", async () => {
    // dave is boardWrite's default effective editor (see "per-board roles"
    // above, which already proves he can write `paths` there) — the ONLY
    // thing wrong with this write is the workspace's plan. If the plan
    // predicate were missing (pre-Month-6 behavior), this would succeed.
    await assertFails(
      setDoc(doc(db(DAVE), "boards/boardWrite/audio/byDave"), { userId: DAVE })
    );
  });

  it("lets an editor create a voice note on a pro-plan board (positive control)", async () => {
    // Same actor, same role, same board shape as the denied case above —
    // only the workspace's plan differs. Proves the predicate isn't `false`
    // for everyone, which the denial test alone couldn't rule out.
    await assertSucceeds(
      setDoc(doc(db(DAVE), "boards/boardProFull/audio/byDave"), { userId: DAVE })
    );
  });

  it("an unrecognized plan string fails closed to the free gate (reuses planOfWorkspace's own fallback, not a second plan reader)", async () => {
    await assertFails(
      setDoc(doc(db(DAVE), "boards/boardWeirdFull/audio/byDave"), { userId: DAVE })
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

// ── Month 6: reactions (👍 ❤️ ❓ ⭐ 💡) — read = board member, write =
// commenter+, same boundary as comments. Reuses isBoardCommenter directly
// (never a second commenter check), so its legacy-board tolerance and
// per-board-override floor-capping apply here unchanged.
describe("reactions", () => {
  const reactionId = (elementId, emoji, userId) => `${elementId}_${emoji}_${userId}`;
  const react = (actorUid, elementId, emoji, userId) =>
    setDoc(doc(db(actorUid), `boards/boardWrite/reactions/${reactionId(elementId, emoji, userId)}`), {
      schemaVersion: 1,
      anchorElementId: elementId,
      anchorKind: "shape",
      emoji,
      userId,
    });

  it("a board member can read reactions (read follows board access)", async () => {
    await assertSucceeds(getDoc(doc(db(CAROL), "boards/boardWrite/reactions/seed_👍_alice")));
    await assertSucceeds(getDoc(doc(db(FRANK), "boards/boardWrite/reactions/seed_👍_alice")));
  });

  it("a cross-workspace member cannot read reactions", async () => {
    // evil is in boardPrivate.members but not in wsA — denied through the
    // same workspace gate the "comments" and canvas-content describes above
    // already prove; this is reactions' own instance of that boundary.
    await assertFails(getDoc(doc(db(EVIL), "boards/boardPrivate/reactions/seed_👍_alice")));
  });

  // Positive control for "denies a viewer reacting" below: same board,
  // element and emoji shape, only the actor's ROLE differs (commenter vs.
  // viewer). If isBoardCommenter were replaced with `if false`, THIS test —
  // not just the denial below — would fail, proving the denial denies for
  // the right reason rather than because nothing here can ever succeed.
  it("lets a board commenter react", async () => {
    // carol is a wsA viewer with an 'editor' override, floor-capped to
    // commenter (see "comments" above) — still allowed to react.
    await assertSucceeds(react(CAROL, "seed", "👍", CAROL));
  });

  it("a workspace member (effective editor, a fortiori a commenter) can react", async () => {
    await assertSucceeds(react(DAVE, "seed", "❤️", DAVE));
  });

  it("denies a viewer reacting", async () => {
    // frank's per-board override is 'viewer' (see "comments" above) — the
    // only difference from the successful carol case is the role.
    await assertFails(react(FRANK, "seed", "👍", FRANK));
  });

  it("denies reacting as another user (the userId FIELD must match auth, not merely be present)", async () => {
    // dave is a genuine commenter here (proven by the case above) — the only
    // thing wrong with this write is that the userId field (and doc id) name
    // carol instead of the caller. If the userId-pin check were dropped and
    // only isBoardCommenter(boardId) remained, this would succeed.
    await assertFails(react(DAVE, "seed", "👍", CAROL));
  });

  it("a legacy board (no workspaceId) lets any member react", async () => {
    await assertSucceeds(
      setDoc(doc(db(EVIL), "boards/boardLegacy/reactions/p1_⭐_" + EVIL), {
        schemaVersion: 1,
        anchorElementId: "p1",
        anchorKind: "path",
        emoji: "⭐",
        userId: EVIL,
      })
    );
  });

  it("the reacting user can remove their own reaction", async () => {
    await assertSucceeds(deleteDoc(doc(db(ALICE), "boards/boardWrite/reactions/seed_👍_alice")));
  });

  it("a non-admin commenter cannot remove someone else's reaction", async () => {
    // dave is a real commenter (and effective editor) on boardWrite, but the
    // seeded reaction belongs to alice and dave is not the board admin.
    await assertFails(deleteDoc(doc(db(DAVE), "boards/boardWrite/reactions/seed_👍_alice")));
  });

  // The board admin CAN remove another member's reaction (moderation, same
  // shape as comments' own admin-delete arm) — required by
  // `clearBoardReactions` (reactionService.ts): a "clear board" batch-deletes
  // every reaction, and a Firestore batched write is atomic, so ONE reaction
  // the clearing admin doesn't own would reject the WHOLE batch and leave the
  // board half-cleared (elements/comments already gone, reactions not) if
  // this arm were missing. dave (not alice, the admin) owns the reaction
  // being deleted here, so this is genuinely the "someone else's" case, not
  // the admin deleting their own.
  it("the board admin can delete another member's reaction (moderation / board-clear)", async () => {
    await react(DAVE, "seed", "💡", DAVE);
    await assertSucceeds(deleteDoc(doc(db(ALICE), "boards/boardWrite/reactions/seed_💡_dave")));
  });

  it("updates are never allowed — react/un-react is create/delete only", async () => {
    await assertFails(
      updateDoc(doc(db(ALICE), "boards/boardWrite/reactions/seed_👍_alice"), { emoji: "❤️" })
    );
  });

  // The document id must equal `anchorElementId_emoji_userId` exactly — the
  // `userId` FIELD check alone stops reacting AS someone else, but does
  // nothing to stop the SAME authorized user from writing extra ids that
  // still pass every field check.
  it("denies when the doc id names a different user than the userId field, even though the field matches auth", async () => {
    // carol's field says carol (her own uid — the field check alone would
    // pass) but the doc id names dave. Unlike "denies reacting as another
    // user" above (which builds id and field consistently with EACH OTHER,
    // just wrong versus the actor), this is the case that only an id-binding
    // check — not the field check alone — can catch.
    await assertFails(
      setDoc(doc(db(CAROL), "boards/boardWrite/reactions/seed_👍_dave"), {
        schemaVersion: 1,
        anchorElementId: "seed",
        anchorKind: "shape",
        emoji: "👍",
        userId: CAROL,
      })
    );
  });

  it("denies an id with an extra segment, even with a fully valid userId field (stops unbounded duplicate reactions)", async () => {
    // dave is a genuine commenter reacting with his own uid in the field —
    // the field check alone would allow this. Without the id-binding check,
    // dave could repeat this with `_3`, `_4`, … and inflate this (element,
    // emoji) pair's count in countsFor without limit, permanently (toggle
    // only ever deletes the canonical id).
    await assertFails(
      setDoc(doc(db(DAVE), "boards/boardWrite/reactions/seed_❤️_dave_2"), {
        schemaVersion: 1,
        anchorElementId: "seed",
        anchorKind: "shape",
        emoji: "❤️",
        userId: DAVE,
      })
    );
  });

  it("denies an emoji outside the fixed 5-value set, even with an otherwise valid id/field pair", async () => {
    await assertFails(
      setDoc(doc(db(DAVE), "boards/boardWrite/reactions/seed_🚀_dave"), {
        schemaVersion: 1,
        anchorElementId: "seed",
        anchorKind: "shape",
        emoji: "🚀",
        userId: DAVE,
      })
    );
  });
});

// ── Month 6: polls — persisted votes (never ephemeral / the cursor side
// channel), quiz sequencing, dot voting. Creating the POLL element itself
// (question/options/position) is editor-only, like any other canvas content
// (paths/shapes/textElements) — a poll carries its own board-space (x, y),
// unlike a reaction which only ever anchors to something that already
// exists. VOTING is commenter+ (the same boundary as reacting/commenting):
// a viewer sees a poll's canvas position but cannot cast a vote.
//
// The document id under `votes/{voterId}` IS the uid — this is what enforces
// one vote doc per user. UNLIKE reactions (react/un-react is create/delete
// only — `allow update: if false`), changing your vote is a legitimate
// UPDATE to that SAME doc, and this is the one place this rules file must
// diverge from the reactions shape it otherwise mirrors closely.
describe("polls", () => {
  const pollRef = (uid, pollId) => doc(db(uid), `boards/boardWrite/polls/${pollId}`);
  const voteRef = (uid, pollId, voterId) => doc(db(uid), `boards/boardWrite/polls/${pollId}/votes/${voterId}`);

  const newPoll = (overrides = {}) => ({
    schemaVersion: 1,
    boardId: "boardWrite",
    question: "Q?",
    options: ["A", "B"],
    anonymous: false,
    mode: "single",
    x: 0,
    y: 0,
    createdById: ALICE,
    ...overrides,
  });

  // Fix round 2 — every vote doc must stamp `anonymous` matching the poll
  // it's actually cast on, or firestore.rules' create-time match check
  // (`request.resource.data.anonymous == pollData(...).anonymous`) denies
  // the write for a reason unrelated to whatever the test is actually
  // checking. Keyed by pollId rather than threaded through every call site
  // above, so none of them had to change shape. Extend this map before
  // pointing `vote()` at a new fixture poll.
  const POLL_ANONYMITY = { pollSingle: false, pollDots: false };
  const vote = (actorUid, pollId, voterId, optionIndices) =>
    setDoc(voteRef(actorUid, pollId, voterId), {
      userId: voterId,
      optionIndices,
      anonymous: POLL_ANONYMITY[pollId],
    });

  // ── reading the poll itself: any board member ──────────────────────────────
  it("a board member can read a poll (read follows board access)", async () => {
    await assertSucceeds(getDoc(pollRef(FRANK, "pollSingle")));
  });

  it("a cross-workspace member cannot read a poll", async () => {
    // evil is in boardPrivate.members but not in wsA — same workspace gate
    // the comments/reactions describes above already prove.
    await assertFails(getDoc(pollRef(EVIL, "pollP")));
  });

  // ── creating the poll element: editor-only, like other canvas content ──────
  // Positive control for "denies a viewer creating a poll" below: same
  // board, same shape, only the actor's ROLE differs.
  it("an effective editor can create a poll", async () => {
    await assertSucceeds(setDoc(pollRef(ALICE, "newByAlice"), newPoll()));
    await assertSucceeds(setDoc(doc(db(DAVE), "boards/boardWrite/polls/newByDave"), newPoll({ createdById: DAVE })));
  });

  it("denies a viewer creating a poll", async () => {
    // frank's per-board override is 'viewer' (see "comments"/"reactions"
    // above) — the only difference from the successful dave case above.
    await assertFails(
      setDoc(doc(db(FRANK), "boards/boardWrite/polls/byFrank"), newPoll({ createdById: FRANK }))
    );
  });

  it("denies a poll with fewer than 2 options", async () => {
    await assertFails(setDoc(pollRef(ALICE, "tooFew"), newPoll({ options: ["only one"] })));
  });

  it("denies a poll with more than 6 options", async () => {
    await assertFails(
      setDoc(pollRef(ALICE, "tooMany"), newPoll({ options: ["A", "B", "C", "D", "E", "F", "G"] }))
    );
  });

  it("denies creating a poll whose createdById names someone other than the caller", async () => {
    await assertFails(setDoc(doc(db(DAVE), "boards/boardWrite/polls/spoofed"), newPoll({ createdById: ALICE })));
  });

  // Fix round 1, item 9 — mapPollDoc (pollService.ts) and isAnonymousPoll
  // (this file) used to default a MISSING `anonymous` field oppositely
  // (false vs. true), so a poll written without it would render forever as
  // "no votes yet" with a silent permission error. Requiring the field to
  // exist as a real boolean on create means that divergence can never be
  // reached by any doc this rule allowed to be written.
  it("denies creating a poll whose anonymous field is missing or not a boolean", async () => {
    const { anonymous: _omit, ...withoutAnonymous } = newPoll();
    await assertFails(setDoc(pollRef(ALICE, "noAnonymousField"), withoutAnonymous));
    await assertFails(setDoc(pollRef(ALICE, "stringAnonymous"), newPoll({ anonymous: "no" })));
  });

  it("a legacy board (no workspaceId) lets any member create a poll", async () => {
    await assertSucceeds(
      setDoc(doc(db(EVIL), "boards/boardLegacy/polls/byEvil"), {
        schemaVersion: 1,
        boardId: "boardLegacy",
        question: "Q?",
        options: ["A", "B"],
        anonymous: false,
        mode: "single",
        x: 0,
        y: 0,
        createdById: EVIL,
      })
    );
  });

  // ── voting: one doc per uid, update allowed for the voter's own doc ────────
  it("allows one vote per user per poll — second write to same doc is an update, still one row", async () => {
    await assertSucceeds(vote(DAVE, "pollSingle", DAVE, [0]));
    await assertSucceeds(vote(DAVE, "pollSingle", DAVE, [2])); // changed their mind

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDocs(collection(ctx.firestore(), "boards/boardWrite/polls/pollSingle/votes"));
      const daveRows = snap.docs.filter((d) => d.id === DAVE);
      expect(daveRows).toHaveLength(1);
      expect(daveRows[0].data().optionIndices).toEqual([2]);
    });
  });

  // Positive control for "denies voting as another user" below: same actor,
  // same poll, only the voter identity differs.
  it("lets a board commenter vote as themselves", async () => {
    await assertSucceeds(vote(CAROL, "pollSingle", CAROL, [1]));
  });

  it("denies voting as another user", async () => {
    // dave is a genuine commenter (proven above) — the only thing wrong with
    // this write is that the doc id AND the userId field name alice instead
    // of the caller.
    await assertFails(vote(DAVE, "pollSingle", ALICE, [0]));
  });

  it("denies a non-member voting", async () => {
    // bob owns wsB entirely — not a member of boardWrite at all (unlike
    // frank/evil below, who ARE board members with a weaker role/workspace).
    await assertFails(vote(BOB, "pollSingle", BOB, [0]));
  });

  it("denies a viewer voting", async () => {
    await assertFails(vote(FRANK, "pollSingle", FRANK, [0]));
  });

  it("denies a vote whose optionIndices isn't a list at all", async () => {
    // anonymous: false matches pollSingle's real value — the ONLY thing
    // wrong here is optionIndices' type, isolating that as the actual cause
    // of the denial rather than an incidental anonymous-stamp mismatch.
    await assertFails(
      setDoc(voteRef(DAVE, "pollSingle", DAVE), { userId: DAVE, optionIndices: "zero", anonymous: false })
    );
  });

  // Fix round 1, item 5 — [0,0,0] passes a bare size<=3 bound (dots mode)
  // even though `toggleDotVote` (pollService.ts) can never produce a
  // doc like this itself; without a uniqueness check one voter could
  // inflate a single option's count 3x via a raw write.
  it("denies a dots-mode vote with duplicate option indices, even though the size bound alone would allow it", async () => {
    await assertFails(vote(DAVE, "pollDots", DAVE, [0, 0, 0]));
  });

  // Fix round 1, item 6 — a genuine commenter voting as themselves, with an
  // otherwise perfectly valid payload, but one extra field smuggled in.
  it("denies a vote payload carrying a field outside {userId, optionIndices, anonymous, createdAt}", async () => {
    // anonymous: false matches pollSingle's real value — the ONLY thing
    // wrong here is the extra `secret` field.
    await assertFails(
      setDoc(voteRef(DAVE, "pollSingle", DAVE), {
        userId: DAVE,
        optionIndices: [0],
        anonymous: false,
        secret: "nope",
      })
    );
  });

  // ── anonymity: hides voter identity from MEMBERS, never from the system ────
  // Positive control: the identical read succeeds against the NON-anonymous
  // twin poll for the same actor — proving the denial below is specific to
  // anonymous mode, not a rule that denies every votes read unconditionally
  // (which would make the "hides voter identity" test below pass for the
  // wrong reason).
  it("a member can read a non-anonymous poll's votes", async () => {
    await assertSucceeds(getDoc(voteRef(FRANK, "pollSingle", ALICE)));
  });

  it("hides voter identity from members in anonymous mode", async () => {
    await assertFails(getDoc(voteRef(FRANK, "pollAnon", ALICE)));
  });

  it("even the board admin cannot read anonymous votes — anonymous-to-USERS means every user", async () => {
    await assertFails(getDoc(voteRef(ALICE, "pollAnon", ALICE)));
  });

  it("denies a count() aggregation on an anonymous poll's votes too — count() needs read permission on the collection, which is exactly why anonymous results need the trigger-maintained tally instead", async () => {
    await assertFails(getCountFromServer(collection(db(FRANK), "boards/boardWrite/polls/pollAnon/votes")));
  });

  it("still allows a count() aggregation on a non-anonymous poll's votes, filtered the same way pollService.subscribeToVotes queries (the positive control for the denial above)", async () => {
    // Fix round 2 — votes-read now gates on each vote's OWN `anonymous`
    // field (a per-document condition), so even a NON-anonymous poll's
    // count() needs the matching `where` filter for Firestore to prove the
    // query is safe without inspecting every result — an unfiltered
    // `collection(...)` count would be rejected here too, same as an
    // unfiltered list. See firestore.rules' votes-read header.
    const q = query(
      collection(db(FRANK), "boards/boardWrite/polls/pollSingle/votes"),
      where("anonymous", "==", false)
    );
    await assertSucceeds(getCountFromServer(q));
  });

  // ── the tally subcollection: member-readable, but client writes are always denied ──
  it("a member can read an anonymous poll's tally doc even though votes are denied", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "boards/boardWrite/polls/pollAnon/tally/summary"), {
        counts: { "1": 1 },
        totalVotes: 1,
      });
    });
    await assertSucceeds(getDoc(doc(db(FRANK), "boards/boardWrite/polls/pollAnon/tally/summary")));
  });

  it("denies a client write to the tally doc — only the Admin-SDK trigger may write it", async () => {
    await assertFails(
      setDoc(doc(db(ALICE), "boards/boardWrite/polls/pollAnon/tally/summary"), { counts: {}, totalVotes: 0 })
    );
  });

  // ── dot voting: up to MAX_DOT_VOTES (3) options at once, still one doc ─────
  it("allows a dots-mode vote with multiple option indices", async () => {
    await assertSucceeds(vote(DAVE, "pollDots", DAVE, [0, 1]));
  });

  it("denies a dots-mode vote past the 3-dot cap", async () => {
    await assertFails(vote(DAVE, "pollDots", DAVE, [0, 1, 2, 3]));
  });

  it("denies a single-mode vote with more than one option index", async () => {
    // pollSingle is mode: 'single' — even a genuine commenter voting as
    // themselves cannot pick two options on a single-choice poll.
    await assertFails(vote(DAVE, "pollSingle", DAVE, [0, 1]));
  });

  it("denies a vote with zero option indices — a zero-length selection isn't a vote", async () => {
    await assertFails(vote(DAVE, "pollSingle", DAVE, []));
  });

  // ── updating the poll: editor-only — quiz sequencing (advanceQuiz) flips
  // `active` via exactly this rule, so it must actually allow an editor
  // update, not just a create/delete.
  it("an effective editor can update a poll (e.g. advancing a quiz's active flag)", async () => {
    await assertSucceeds(updateDoc(pollRef(DAVE, "pollSingle"), { active: true }));
  });

  it("denies a viewer updating a poll", async () => {
    await assertFails(updateDoc(pollRef(FRANK, "pollSingle"), { active: true }));
  });

  // Fix round 1, item 1 (CRITICAL) — an earlier version of this rule was
  // `allow update, delete: if isBoardEditor(boardId)` with no field
  // constraint at all, which let ANY editor retroactively de-anonymize
  // every vote already cast on `pollAnon` by flipping this one field:
  // `isAnonymousPoll` reads the CURRENT (post-update) value, so
  // `updateDoc({anonymous: false})` followed by a votes read would then
  // succeed where "hides voter identity from members in anonymous mode"
  // above proved it must fail. This MUST fail against the buggy rule — that
  // is what proves the fix, not merely that some update somewhere succeeds.
  it("denies an effective editor flipping a poll's anonymous flag — this is the fix for a real de-anonymization hole", async () => {
    await assertFails(updateDoc(pollRef(DAVE, "pollAnon"), { anonymous: false }));
  });

  it("denies an effective editor reassigning a poll's createdById", async () => {
    await assertFails(updateDoc(pollRef(DAVE, "pollSingle"), { createdById: DAVE }));
  });

  it("denies an effective editor rewriting a poll's options to fall outside [2, 6] via update", async () => {
    await assertFails(updateDoc(pollRef(DAVE, "pollSingle"), { options: ["only one"] }));
    await assertFails(
      updateDoc(pollRef(DAVE, "pollSingle"), { options: ["A", "B", "C", "D", "E", "F", "G"] })
    );
  });

  // Fix round 2 — switching a live poll between "single" and "dots"
  // reinterprets every vote already cast (a "single" vote's one-element
  // optionIndices means something different once the poll claims dots are
  // allowed), exactly the reasoning that was already used to accept
  // creation-time-only mode selection in the first place. Pinned alongside
  // anonymous/createdById/options above.
  it("denies an effective editor switching a poll's mode via update — mode selection is creation-time only", async () => {
    await assertFails(updateDoc(pollRef(DAVE, "pollSingle"), { mode: "dots" }));
    await assertFails(updateDoc(pollRef(DAVE, "pollDots"), { mode: "single" }));
  });

  // Fix round 2 (CRITICAL) — round 1 only closed the "flip anonymous via
  // UPDATE" half of this hole. An effective editor can also DELETE the poll
  // directly (skipping pollService.deletePoll's own votes/tally cleanup —
  // Firestore never cascade-deletes subcollections) and RECREATE the same
  // poll id non-anonymously: `resource` is null right after the delete, so
  // this second write is a `create`, which round 1's `allow update` pin
  // never runs against. The OLD vote doc (alice's, seeded in beforeEach) is
  // untouched by either step — it just sits there under the recreated
  // poll's own path.
  //
  // This test MUST fail against the pre-round-2 rule, which re-derived
  // votes-read from the PARENT poll's CURRENT `anonymous` field
  // (`isAnonymousPoll`): after the recreate that field reads `false`, so
  // the old rule would have opened the entire subcollection — whose
  // document ids ARE the voters' uids — to every member. It passes now
  // because votes-read instead gates on the VOTE's OWN stamped field, fixed
  // at the moment THAT doc was first created and untouched by anything a
  // later delete/recreate of the PARENT poll does.
  it("denies reading old anonymous votes after a delete-then-recreate of the poll — the fix round 2 critical", async () => {
    await assertSucceeds(deleteDoc(pollRef(DAVE, "pollAnon")));
    await assertSucceeds(
      setDoc(pollRef(DAVE, "pollAnon"), newPoll({ anonymous: false, createdById: DAVE }))
    );

    // boards/boardWrite/polls/pollAnon/votes/alice (seeded in beforeEach,
    // stamped anonymous: true) was never deleted by either step above — it
    // is STILL sitting there, under the recreated (now non-anonymous)
    // poll's own path — and must stay unreadable to everyone, including
    // the editor who just did the recreate.
    await assertFails(getDoc(voteRef(FRANK, "pollAnon", ALICE)));
    await assertFails(getDoc(voteRef(DAVE, "pollAnon", ALICE)));
  });

  // ── deleting the poll: editor-only, like create ─────────────────────────────
  it("an effective editor can delete a poll", async () => {
    await setDoc(pollRef(ALICE, "toDelete"), newPoll());
    await assertSucceeds(deleteDoc(pollRef(DAVE, "toDelete")));
  });

  it("denies a viewer deleting a poll", async () => {
    await assertFails(deleteDoc(pollRef(FRANK, "pollSingle")));
  });

  // Fix round 3 — pollService.deletePoll USED TO batch-delete a poll's
  // votes/tally docs together with the poll doc itself in one atomic
  // batch. `tally/{tallyId}`'s rule is `allow write: if false`
  // unconditionally (no client may ever delete it), and Firestore batched
  // writes are atomic — one denied delete fails the WHOLE batch — so that
  // old approach threw whenever the poll being deleted had a tally doc,
  // i.e. every anonymous poll that had been voted on. Not an edge case:
  // the routine "delete my poll" action, for exactly the poll kind
  // pollTally.ts's whole design exists to serve.
  //
  // `pollAnon` (seeded in beforeEach) already has alice's vote; seed a
  // tally doc here too (bypassing rules, simulating what
  // functions/src/triggers/pollTally.ts's onPollVoteWritten would have
  // written for real votes) so this poll is in EXACTLY the state that used
  // to make deletion impossible.
  it("an effective editor can delete a poll even when it has votes and a tally doc (fix round 3 — cleanup is server-side now)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "boards/boardWrite/polls/pollAnon/tally/summary"), {
        counts: { "1": 1 },
        totalVotes: 1,
      });
    });

    // Demonstrates the OLD deletePoll's exact shape still fails, so this
    // test doesn't just exercise a strawman: batching the vote + tally +
    // poll deletes together (mirroring pollService.deletePoll before this
    // fix) is denied. This alone does NOT isolate the tally delete as the
    // cause, though — DAVE is an effective editor but not the board admin,
    // and firestore.rules' votes `allow delete` permits only
    // isBoardAdmin(boardId) or the voter deleting their own doc, so DAVE's
    // vote-delete line is independently denied too; removing the tally
    // line here would not make this particular batch succeed. The
    // differential pair in the next test isolates the tally as the actual,
    // sole cause. ONE shared `daveDb` for every ref in the batch —
    // `writeBatch` and every doc it deletes must come from the SAME
    // Firestore instance, and `db(uid)` (like `pollRef`/`voteRef`, which
    // call it internally) mints a FRESH instance on every call.
    const daveDb = db(DAVE);
    const oldStyleBatch = writeBatch(daveDb);
    oldStyleBatch.delete(doc(daveDb, "boards/boardWrite/polls/pollAnon/votes/alice"));
    oldStyleBatch.delete(doc(daveDb, "boards/boardWrite/polls/pollAnon/tally/summary"));
    oldStyleBatch.delete(doc(daveDb, "boards/boardWrite/polls/pollAnon"));
    await assertFails(oldStyleBatch.commit());

    // The FIX: pollService.deletePoll now only ever deletes the poll doc
    // itself — something an effective editor IS permitted to do — and
    // leaves the votes/tally cleanup to onPollDeleted (a server-side
    // trigger using the Admin SDK, which bypasses the very rule that made
    // the batch above fail).
    await assertSucceeds(deleteDoc(pollRef(DAVE, "pollAnon")));
  });

  // Isolates the tally delete as the SOLE cause of an old-style batch's
  // denial — the test above cannot, by itself, because DAVE (an effective
  // editor, not the board admin) is independently denied on the vote-delete
  // line too. Run instead as ALICE, the board admin: `isBoardAdmin(boardId)`
  // lets her delete any vote doc regardless of who cast it, and she is also
  // the board owner so `isBoardEditor(boardId)` lets her delete the poll —
  // so both non-tally lines succeed for her on their own, and the tally
  // line is the only thing left that can make a batch fail. A batch that
  // succeeds actually deletes its poll, so the pair runs against two
  // otherwise-identical fresh polls rather than sharing one: `[vote, poll]`
  // succeeds; `[vote, tally, poll]` — the same two deletes, plus the tally
  // line — fails.
  it("a differential pair proves the tally delete alone is what fails an old-style batch", async () => {
    const aliceDb = db(ALICE);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const raw = ctx.firestore();
      for (const pollId of ["diffNoTally", "diffWithTally"]) {
        await setDoc(doc(raw, `boards/boardWrite/polls/${pollId}`), newPoll({ anonymous: true }));
        await setDoc(doc(raw, `boards/boardWrite/polls/${pollId}/votes/alice`), {
          userId: ALICE,
          optionIndices: [0],
          anonymous: true,
        });
      }
      await setDoc(doc(raw, "boards/boardWrite/polls/diffWithTally/tally/summary"), {
        counts: { "0": 1 },
        totalVotes: 1,
      });
    });

    // [vote, poll] — no tally line — succeeds.
    const noTallyBatch = writeBatch(aliceDb);
    noTallyBatch.delete(doc(aliceDb, "boards/boardWrite/polls/diffNoTally/votes/alice"));
    noTallyBatch.delete(doc(aliceDb, "boards/boardWrite/polls/diffNoTally"));
    await assertSucceeds(noTallyBatch.commit());

    // [vote, tally, poll] — the identical vote + poll deletes that just
    // succeeded above, plus the tally line — fails. The tally delete is the
    // only variable between the two batches, which is what proves it's the
    // cause.
    const withTallyBatch = writeBatch(aliceDb);
    withTallyBatch.delete(doc(aliceDb, "boards/boardWrite/polls/diffWithTally/votes/alice"));
    withTallyBatch.delete(doc(aliceDb, "boards/boardWrite/polls/diffWithTally/tally/summary"));
    withTallyBatch.delete(doc(aliceDb, "boards/boardWrite/polls/diffWithTally"));
    await assertFails(withTallyBatch.commit());
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

// ── Month 6: board Q&A embedding write path ───────────────────────────────────
// `boards/{boardId}/embeddings/{elementId}` (functions/src/ai/embeddings.ts).
// UNLIKE ocrCache above, this collection has NO match block in firestore.rules
// at all — mirroring flashcardCache.ts's precedent, not ocrCache's: no client
// surface ever reads a raw embedding vector (retrieval runs entirely
// server-side, inside the Cloud Function that will call `findNearest` and
// hand back an answer plus cited element ids, never the vectors themselves),
// so there is no read to grant. Denied for get, list AND write by the file's
// default deny.
//
// Every denial below is paired with a positive control on the SAME actor
// against a genuinely-open collection (`boards/boardCoded/paths`, already
// proven member/editor-writable above) so a rule that failed EVERY request —
// not just this collection — could not slip through as a false pass. The
// list-query case is included deliberately: this suite learned the hard way
// (see the education-pilot "list-query provability" section below) that a
// suite testing only `getDoc` cannot detect an enumeration hole, so any
// collection this file discusses gets its list path exercised explicitly too.
describe("board Q&A embeddings (Month 6)", () => {
  it("denies a client GET of an embedding doc, even a board member/owner", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "boards/boardCoded/paths/p1")));
    await assertFails(getDoc(doc(db(ALICE), "boards/boardCoded/embeddings/el1")));
  });

  it("denies a client LIST over the embeddings collection, even a board member/owner", async () => {
    await assertSucceeds(getDocs(collection(db(ALICE), "boards/boardCoded/paths")));
    await assertFails(getDocs(collection(db(ALICE), "boards/boardCoded/embeddings")));
  });

  it("denies a client write to embeddings — Functions (Admin SDK) only, even a board member/owner", async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), "boards/boardCoded/paths/p1"), { userId: ALICE }));
    await assertFails(
      setDoc(doc(db(ALICE), "boards/boardCoded/embeddings/el1"), {
        text: "hello", elementType: "note", contentHash: "h", updatedAt: 0,
      })
    );
  });
});

// ── Month 6: math elements ────────────────────────────────────────────────────
// `boards/{boardId}/mathElements/{elementId}` — a LaTeX equation stored as
// flat SVG path data. Member-read / editor-write, like every other canvas-
// content subcollection, PLUS two deliberate absences this section proves:
//
//   1. No `isEmbedEditor` disjunct on the write, unlike paths/notes/shapes/
//      textElements. An embed identity is never a board MEMBER, and creating
//      a math element requires the `renderMath` callable, whose own trust
//      boundary is exactly that membership — so an embed editor allowed to
//      write here could only ever create an element whose `svgPath` it had no
//      way to obtain.
//   2. No `mathCache` match block at all (flashcardCache's precedent, not
//      ocrCache's): nothing client-side reads a cached rendering, so there is
//      no read to grant, and the file's default deny covers it.
//
// Every denial is paired with a positive control — the SAME actor against a
// collection already proven open to them — so a rule that failed every
// request could not slip through as a false pass. The list path is exercised
// explicitly alongside the get path, for the reason the embeddings section
// above states.
describe("math elements (Month 6)", () => {
  const mathDoc = (uid, boardId, docId) =>
    setDoc(doc(db(uid), `boards/${boardId}/mathElements/${docId}`), {
      schemaVersion: 1,
      type: "math",
      boardId,
      userId: uid,
      latex: "y^2",
      svgPath: "M 0 0",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      scale: 1,
    });

  it("a board member reads a math element", async () => {
    await assertSucceeds(getDoc(doc(db(CAROL), "boards/boardWrite/mathElements/m1")));
  });

  it("a non-member cannot read a math element", async () => {
    // The same read succeeds for carol above, so this denial is bob and not
    // a rule that refuses everyone.
    await assertFails(getDoc(doc(db(BOB), "boards/boardWrite/mathElements/m1")));
  });

  it("a non-member cannot LIST the math elements either", async () => {
    // A get-only suite cannot detect an enumeration hole.
    await assertSucceeds(getDocs(collection(db(CAROL), "boards/boardWrite/mathElements")));
    await assertFails(getDocs(collection(db(BOB), "boards/boardWrite/mathElements")));
  });

  it("an editor writes a math element", async () => {
    await assertSucceeds(mathDoc(DAVE, "boardWrite", "byDave"));
  });

  it("a workspace viewer cannot write one, though they can read", async () => {
    // carol reads m1 above, so this denial is the WRITE gate and not carol.
    await assertFails(mathDoc(CAROL, "boardWrite", "byCarol"));
  });

  it("a member demoted to viewer by a per-board override cannot write one", async () => {
    await assertFails(mathDoc(FRANK, "boardWrite", "byFrank"));
  });

  it("an edit-scoped embed identity cannot write one, though it CAN write paths", async () => {
    // The positive control is the same identity on the same board: the
    // denial is this collection, not the claim.
    const edb = embedEditDb("boardWrite");
    await assertSucceeds(
      setDoc(doc(edb, "boards/boardWrite/paths/fromEmbedMath"), { userId: EMBED_EDIT_UID })
    );
    await assertFails(
      setDoc(doc(edb, "boards/boardWrite/mathElements/fromEmbed"), {
        schemaVersion: 1,
        type: "math",
        latex: "x",
        svgPath: "M 0 0",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        scale: 1,
      })
    );
  });

  it("a view-scoped embed identity can READ one (the embed renders the board)", async () => {
    // An equation is canvas content; a read-only embed that could not read it
    // would render a board with holes in it.
    await assertSucceeds(
      getDoc(doc(embedDb("boardWrite"), "boards/boardWrite/mathElements/m1"))
    );
  });

  // Grouped last for readability, not because order matters: `beforeEach`
  // (above) clears and re-seeds Firestore before every test in this file, so
  // these deletes cannot starve an earlier read case of its seeded `m1`.
  it("a viewer cannot delete one", async () => {
    await assertFails(deleteDoc(doc(db(CAROL), "boards/boardWrite/mathElements/m1")));
  });

  it("an editor can delete one", async () => {
    await assertSucceeds(deleteDoc(doc(db(DAVE), "boards/boardWrite/mathElements/m1")));
  });
});

// ── Month 6: the math render cache ────────────────────────────────────────────
describe("math render cache (mathCache, Month 6)", () => {
  it("denies a client GET of a cached rendering, even a board member/owner", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "boards/boardCoded/paths/p1")));
    await assertFails(getDoc(doc(db(ALICE), "boards/boardCoded/mathCache/hash1")));
  });

  it("denies a client LIST over the cache", async () => {
    await assertSucceeds(getDocs(collection(db(ALICE), "boards/boardCoded/paths")));
    await assertFails(getDocs(collection(db(ALICE), "boards/boardCoded/mathCache")));
  });

  it("denies a client write — the Cloud Function (Admin SDK) is the only writer", async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), "boards/boardCoded/paths/p1"), { userId: ALICE }));
    await assertFails(
      setDoc(doc(db(ALICE), "boards/boardCoded/mathCache/forged"), {
        svgPath: "M 0 0", width: 1, height: 1, createdAt: 0,
      })
    );
  });
});

// ── Month 6: flashcard decks + cards ──────────────────────────────────────────
// Per-user scheduling (`users/{uid}/decks/{deckId}/cards/{cardId}`), gated
// strictly on the owning uid — deliberately NOT as permissive as the parent
// `users/{uid}` document (whose read is any-signed-in-user, for profile
// lookup). Every denial below is paired with the matching owner success so a
// rule that denied EVERYONE (not just non-owners) would still be caught.
describe("flashcard decks (Month 6)", () => {
  it("the owner reads their own deck", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "users/alice/decks/deck1")));
  });

  it("a different user cannot read someone else's deck", async () => {
    await assertFails(getDoc(doc(db(BOB), "users/alice/decks/deck1")));
  });

  it("the owner creates a new deck", async () => {
    await assertSucceeds(
      setDoc(doc(db(ALICE), "users/alice/decks/deck2"), {
        schemaVersion: 1,
        name: "Chemistry",
      })
    );
  });

  it("a different user cannot create a deck under someone else's uid", async () => {
    await assertFails(
      setDoc(doc(db(BOB), "users/alice/decks/deck2"), {
        schemaVersion: 1,
        name: "Planted",
      })
    );
  });

  it("the owner deletes their own deck", async () => {
    await assertSucceeds(deleteDoc(doc(db(ALICE), "users/alice/decks/deck1")));
  });

  it("a different user cannot delete someone else's deck", async () => {
    await assertFails(deleteDoc(doc(db(BOB), "users/alice/decks/deck1")));
  });

  it("the owner reads a card in their own deck", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "users/alice/decks/deck1/cards/card1")));
  });

  it("a different user cannot read a card in someone else's deck", async () => {
    await assertFails(getDoc(doc(db(BOB), "users/alice/decks/deck1/cards/card1")));
  });

  it("the owner updates their own card's schedule after a review", async () => {
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "users/alice/decks/deck1/cards/card1"), {
        repetitions: 1,
        intervalDays: 1,
        easeFactor: 2.5,
        dueAtMs: 86_400_000,
      })
    );
  });

  it("a different user cannot update someone else's card", async () => {
    await assertFails(
      updateDoc(doc(db(BOB), "users/alice/decks/deck1/cards/card1"), {
        repetitions: 99,
      })
    );
  });

  it("the owner adds a newly generated card to their own deck", async () => {
    await assertSucceeds(
      setDoc(doc(db(ALICE), "users/alice/decks/deck1/cards/card2"), {
        schemaVersion: 1,
        front: "Q",
        back: "A",
        repetitions: 0,
        intervalDays: 0,
        easeFactor: 2.5,
        dueAtMs: 0,
      })
    );
  });

  it("a different user cannot plant a card under someone else's deck", async () => {
    await assertFails(
      setDoc(doc(db(BOB), "users/alice/decks/deck1/cards/card2"), {
        schemaVersion: 1,
        front: "Planted",
        back: "Card",
        repetitions: 0,
        intervalDays: 0,
        easeFactor: 2.5,
        dueAtMs: 0,
      })
    );
  });

  it("the owner deletes their own card", async () => {
    await assertSucceeds(deleteDoc(doc(db(ALICE), "users/alice/decks/deck1/cards/card1")));
  });

  it("a different user cannot delete someone else's card", async () => {
    await assertFails(deleteDoc(doc(db(BOB), "users/alice/decks/deck1/cards/card1")));
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

// ── Month 5: editable embed identity ──────────────────────────────────────────
// A v2 embed token carries a host-asserted subject, so the exchange mints a uid
// namespaced by the issuing host (`embed:<iss>:<sub>` — exchangeEmbedToken.
// embedIdentityUid) instead of the shared anonymous `embed:<boardId>`. The claim
// set is identical to a view embed's apart from `embedScope`, which is the ONLY
// thing separating the write grant from the read one — so every case below is
// paired against its view-scoped twin.
const EMBED_ISS = "meet";
const EMBED_SUB = "u9";
const EMBED_EDIT_UID = `embed:${EMBED_ISS}:${EMBED_SUB}`;

function embedEditDb(boardId) {
  return testEnv
    .authenticatedContext(EMBED_EDIT_UID, {
      embed: true,
      embedBoardId: boardId,
      embedScope: "edit",
      embedIssuer: EMBED_ISS,
      embedSubject: EMBED_SUB,
    })
    .firestore();
}

describe("editable embed identity", () => {
  // boardWrite and boardPrivate are both seeded, both in wsA, and both already
  // carry a paths/ doc — so a denial below is the embed claim, never a missing
  // board, a missing workspace or an unwritable path.
  it("lets an edit-scoped embed identity write to its own board", async () => {
    await assertSucceeds(
      setDoc(doc(embedEditDb("boardWrite"), "boards/boardWrite/paths/fromEmbed"), {
        userId: EMBED_EDIT_UID,
      })
    );
  });

  it("denies an edit-scoped embed identity writing to a different board", async () => {
    // Identical write to the accepted one above, on a board the claim does not
    // name. EMBED_EDIT_UID is not in boardPrivate.members either, so no other arm
    // could let it through.
    await assertFails(
      setDoc(doc(embedEditDb("boardWrite"), "boards/boardPrivate/paths/fromEmbed"), {
        userId: EMBED_EDIT_UID,
      })
    );
  });

  it("denies a view-scoped embed identity writing at all", async () => {
    // The same write, on the same board and the same document path, by an identity
    // whose claims differ only in `embedScope` ('view' vs 'edit') — the uid and the
    // `userId` payload differ too, but neither is read by the paths rule. If
    // isEmbedEditor stopped checking the scope, this would start passing.
    await assertFails(
      setDoc(doc(embedDb("boardWrite"), "boards/boardWrite/paths/fromEmbed"), {
        userId: "embed:boardWrite",
      })
    );
  });

  it("an edit-scoped embed identity writes the vector canvas collections", async () => {
    const edb = embedEditDb("boardWrite");
    await assertSucceeds(setDoc(doc(edb, "boards/boardWrite/notes/fromEmbed"), { content: "hi" }));
    await assertSucceeds(setDoc(doc(edb, "boards/boardWrite/shapes/fromEmbed"), { kind: "rect" }));
    await assertSucceeds(setDoc(doc(edb, "boards/boardWrite/textElements/fromEmbed"), { text: "hi" }));
    await assertSucceeds(setDoc(doc(edb, "boards/boardWrite/snapshots/fromEmbed"), { userId: EMBED_EDIT_UID }));
  });

  it("an edit-scoped embed identity cannot write images or audio (bytes are member-gated)", async () => {
    // storage.rules gates the image/audio BYTES on isBoardMember, which this
    // identity is not — so the Firestore grant deliberately stops short of these
    // two, rather than letting it create an element pointing at an object it can
    // neither upload nor read back. The same identity writes notes/shapes above,
    // so the denial is these collections and not the identity.
    const edb = embedEditDb("boardWrite");
    await assertFails(setDoc(doc(edb, "boards/boardWrite/images/fromEmbed"), { uri: "x" }));
    await assertFails(setDoc(doc(edb, "boards/boardWrite/audio/fromEmbed"), { uri: "x" }));
  });

  it("an edit-scoped embed identity still cannot touch the board document", async () => {
    // boardWrite has no inviteCode, so the self-join arm is structurally
    // inapplicable here; this pins the admin/editor/member arms only. The
    // "cannot become a member" claim is pinned separately, on boardLegacyOpen
    // below, where the self-join arm IS live.
    await assertFails(
      updateDoc(doc(embedEditDb("boardWrite"), "boards/boardWrite"), { title: "hijacked" })
    );
  });

  it("an edit-scoped embed identity still cannot comment", async () => {
    // Comments carry an authorId and a notification path; they stay member-only
    // until a host integration needs them.
    await assertFails(
      setDoc(doc(embedEditDb("boardWrite"), "boards/boardWrite/comments/fromEmbed"), {
        anchorElementId: "seed",
        anchorKind: "shape",
        authorId: EMBED_EDIT_UID,
        body: "hi",
        replies: [],
        resolved: false,
      })
    );
  });

  // ── the invite-code self-join arm ───────────────────────────────────────────
  // boardLegacyOpen is legacy + invite-coded + under cap, so the self-join arm is
  // genuinely live on it and nothing else can be what denies a join. The first
  // test establishes exactly that; the rest would all pass vacuously without it.
  it("a signed-in non-member CAN self-join boardLegacyOpen (the fixture has teeth)", async () => {
    await assertSucceeds(
      updateDoc(doc(db(BOB), "boards/boardLegacyOpen"), { members: [ALICE, BOB] })
    );
  });

  it("an edit-scoped embed identity cannot self-join an invite-coded legacy board", async () => {
    // Identical write to BOB's above, by an embed identity scoped to a DIFFERENT
    // board. Before the isEmbedIdentity guard this succeeded — and on a legacy
    // board, membership means isBoardEditor's null-workspace disjunct fires, so it
    // was a full editor of a board it was never scoped to.
    await assertFails(
      updateDoc(doc(embedEditDb("boardWrite"), "boards/boardLegacyOpen"), {
        members: [ALICE, EMBED_EDIT_UID],
      })
    );
  });

  it("a VIEW-scoped embed identity cannot self-join either", async () => {
    // The read-only embed has produced a signed-in identity since Phase 8, so it
    // reached this arm too. Scope is irrelevant here: no embed identity self-joins.
    await assertFails(
      updateDoc(doc(embedDb("boardPrivate"), "boards/boardLegacyOpen"), {
        members: [ALICE, "embed:boardPrivate"],
      })
    );
  });

  it("an embed identity that cannot self-join also cannot reach the board's canvas", async () => {
    // The consequence the self-join was worth having: with membership denied, the
    // legacy board's canvas stays closed to it for both read and write.
    const edb = embedEditDb("boardWrite");
    await assertFails(getDoc(doc(edb, "boards/boardLegacyOpen/paths/pLO")));
    await assertFails(setDoc(doc(edb, "boards/boardLegacyOpen/paths/forged"), { userId: EMBED_EDIT_UID }));
  });

  it("an edit-scoped embed identity writes its own presence but not a member's", async () => {
    const edb = embedEditDb("boardWrite");
    await assertSucceeds(
      setDoc(doc(edb, `boards/boardWrite/presence/${EMBED_EDIT_UID}`), { online: true })
    );
    // ALICE is a real seeded member of boardWrite — the denial is the own-doc
    // guard, not an unknown user.
    await assertFails(
      setDoc(doc(edb, `boards/boardWrite/presence/${ALICE}`), { online: true })
    );
  });
});

// ── M5: `plan` is not client-writable ─────────────────────────────────────────
// The single highest-value field in the database. Every server-side quota gate
// (checkAiQuota, handleCreateBoard, handleCreateSession, and the seat cap above)
// reads workspace.plan, so a client that could write it would hand itself Pro and
// every one of those gates would agree. The Stripe webhook writes it via the
// Admin SDK, which bypasses these rules.
describe("M5 workspace plan is not client-writable", () => {
  it("denies the workspace OWNER setting plan to pro", async () => {
    await assertFails(
      updateDoc(doc(db(ALICE), "workspaces/wsA"), { plan: "pro" })
    );
  });

  it("denies the owner setting plan to edu", async () => {
    await assertFails(
      updateDoc(doc(db(ALICE), "workspaces/wsA"), { plan: "edu" })
    );
  });

  it("denies smuggling plan in alongside a legitimate field", async () => {
    // The interesting attack: bury the field in an otherwise-valid rename.
    await assertFails(
      updateDoc(doc(db(ALICE), "workspaces/wsA"), { name: "Renamed", plan: "pro" })
    );
  });

  it("denies DOWNGRADING plan too — clients don't write the field at all", async () => {
    // Not a privilege escalation, but billing state belongs to the webhook. A rule
    // that only blocked upgrades would still let a client desync from Stripe.
    await assertFails(
      updateDoc(doc(db(ALICE), "workspaces/wsPro"), { plan: "free" })
    );
  });

  it("still lets the owner rename the workspace", async () => {
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "workspaces/wsA"), { name: "Alice WS renamed" })
    );
  });

  it("still lets a plain member rename the workspace (the name-only arm)", async () => {
    await assertSucceeds(
      updateDoc(doc(db(DAVE), "workspaces/wsA"), { name: "Dave's rename" })
    );
  });

  it("still lets the owner manage members and memberIds", async () => {
    // workspaceService.addMember / addMemberByEmail / updateMemberRole /
    // removeMember all land on this arm.
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "workspaces/wsA"), {
        "members.bob": "member",
        memberIds: [ALICE, CAROL, DAVE, FRANK, BOB],
      })
    );
  });

  it("still lets the owner write an unrelated new field", async () => {
    // The restriction is on the `plan` field, not a field allowlist — fields this
    // rule has never heard of keep their existing role gate.
    await assertSucceeds(
      updateDoc(doc(db(ALICE), "workspaces/wsA"), { settings: { theme: "dark" } })
    );
  });

  it("allows a create that stamps the free plan (the signup path)", async () => {
    await assertSucceeds(
      setDoc(doc(db(BOB), "workspaces/newFree"), {
        name: "Personal",
        ownerId: BOB,
        members: { [BOB]: "owner" },
        memberIds: [BOB],
        plan: "free",
      })
    );
  });

  it("allows a create that omits plan entirely", async () => {
    await assertSucceeds(
      setDoc(doc(db(BOB), "workspaces/newNoPlan"), {
        name: "Personal",
        ownerId: BOB,
        members: { [BOB]: "owner" },
        memberIds: [BOB],
      })
    );
  });

  it("denies a create that stamps a paid plan", async () => {
    // Without this, the update rule is pointless: delete-and-recreate, or just
    // create a fresh workspace, would mint Pro.
    await assertFails(
      setDoc(doc(db(BOB), "workspaces/newPro"), {
        name: "Free Pro",
        ownerId: BOB,
        members: { [BOB]: "owner" },
        memberIds: [BOB],
        plan: "pro",
      })
    );
  });

  it("denies a create that stamps the edu plan", async () => {
    await assertFails(
      setDoc(doc(db(BOB), "workspaces/newEdu"), {
        name: "Free Edu",
        ownerId: BOB,
        members: { [BOB]: "owner" },
        memberIds: [BOB],
        plan: "edu",
      })
    );
  });
});

// ── M5: plan metering collections (usage / billing) ────────────────────────────
// Both are written ONLY by Cloud Functions via the Admin SDK (which bypasses
// rules); every client write must be denied, and reads are limited to workspace
// owner/admins, mirroring the aiUsage/aiLog gate above.
describe("M5 metering collections", () => {
  it("denies a client write to usage", async () => {
    await assertFails(
      setDoc(doc(db(ALICE), "workspaces/wsA/usage/2026-09"), { sessions: 0, updatedAt: 0 })
    );
  });

  it("denies a client write to billing", async () => {
    await assertFails(
      setDoc(doc(db(ALICE), "workspaces/wsA/billing/subscription"), { plan: "pro" })
    );
  });

  // setDoc against an already-seeded doc exercises `update`; deleting the doc
  // outright is a distinct verb and the highest-value attack on a monthly
  // meter (wipe the doc, reset the quota) — mirrors the two-verb aiUsage gate.
  it("denies a client deleting usage — the highest-value attack on a monthly meter", async () => {
    await assertFails(deleteDoc(doc(db(ALICE), "workspaces/wsA/usage/2026-09")));
  });

  it("denies a client deleting billing", async () => {
    await assertFails(deleteDoc(doc(db(ALICE), "workspaces/wsA/billing/subscription")));
  });

  it("lets a workspace owner read usage", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "workspaces/wsA/usage/2026-09")));
  });

  it("denies a plain member reading usage", async () => {
    // dave is a plain workspace member, not owner/admin.
    await assertFails(getDoc(doc(db(DAVE), "workspaces/wsA/usage/2026-09")));
  });

  it("lets a workspace owner read billing", async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), "workspaces/wsA/billing/subscription")));
  });

  it("denies a plain member reading billing", async () => {
    await assertFails(getDoc(doc(db(DAVE), "workspaces/wsA/billing/subscription")));
  });

  it("denies a non-member reading usage or billing", async () => {
    await assertFails(getDoc(doc(db(BOB), "workspaces/wsA/usage/2026-09")));
    await assertFails(getDoc(doc(db(BOB), "workspaces/wsA/billing/subscription")));
  });
});

// ── usage-dashboard board count (src/services/usageService.ts) ──────────────
// countWorkspaceBoards cannot run the server's exact countBoards query
// (`workspaceId==X` alone) — Firestore's query-provability check rejects that
// filter because the board read rule's ownerId/members disjuncts aren't
// provable from it, so it adds `inviteCode != null` to make the rule's third
// disjunct provable instead. That filter has a real cost: scripts/migrate-
// workspaces.js (the M3 backfill) stamps workspaceId onto legacy boards
// without ever touching inviteCode, so a migrated board can have workspaceId
// set and inviteCode null — counted by the server's countBoards, NOT by this
// query. This suite proves that divergence mechanically rather than resting
// on a comment, using the boardMigratedNoCode fixture seeded above.
describe("usage-dashboard board count excludes a migrated board with no invite code", () => {
  it("workspaceId + inviteCode!=null does not return a board whose workspaceId was backfilled without ever getting an invite code", async () => {
    const q = query(
      collection(db(ALICE), "boards"),
      where("workspaceId", "==", "wsA"),
      where("inviteCode", "!=", null)
    );

    const snap = await getDocs(q);
    const ids = snap.docs.map((d) => d.id);
    expect(ids).not.toContain("boardMigratedNoCode");
    // Sanity: the query isn't vacuously empty (which would make the assertion
    // above trivially true) — it does return wsA boards that DO carry an
    // invite code, so the exclusion is specifically about the missing code,
    // not about the whole query failing.
    expect(ids).toContain("boardCoded");

    // getCountFromServer (the actual aggregation usageService.ts calls) must
    // agree with the getDocs-based membership check above, not just return
    // some other number.
    const countSnap = await getCountFromServer(q);
    expect(countSnap.data().count).toBe(ids.length);
  });

  it("a bare workspaceId filter (the server's own countBoards shape) is rejected outright for the client", async () => {
    // The other half of the divergence this suite documents: the server can
    // run `workspaceId==X` alone (Admin SDK, bypasses rules) and would count
    // boardMigratedNoCode; a client cannot run that query at all.
    const q = query(collection(db(ALICE), "boards"), where("workspaceId", "==", "wsA"));
    await assertFails(getCountFromServer(q));
  });
});

// ── M6 education pilot: assignment board isolation ──────────────────────────
// The hard property this task's brief calls out by name: a board's `classId`
// linkage must let ONLY that class's instructor read across students, and
// must isolate cleanly between two different classes. Every denial below is
// paired with a positive control proving the corresponding read genuinely
// succeeds for someone — otherwise a rule that denies everyone would pass
// the denial tests too.
describe("education pilot: assignment board isolation", () => {
  it("denies a student reading another student's assignment board", async () => {
    await assertFails(getDoc(doc(db(STUDENT_A2), "boards/boardA1")));
  });

  // Positive control for the test above.
  it("still lets that student read their OWN assignment board", async () => {
    await assertSucceeds(getDoc(doc(db(STUDENT_A1), "boards/boardA1")));
  });

  it("lets the instructor read every assignment board in the class", async () => {
    // Asserted against MORE THAN ONE student's board — a rule that only
    // happened to cover the first board seeded would still pass a
    // single-board check.
    await assertSucceeds(getDoc(doc(db(INSTRUCTOR_A), "boards/boardA1")));
    await assertSucceeds(getDoc(doc(db(INSTRUCTOR_A), "boards/boardA2")));
  });

  it("denies an instructor of class A reading class B", async () => {
    await assertFails(getDoc(doc(db(INSTRUCTOR_A), "boards/boardB1")));
  });

  // Positive control for the test above: without this, "denies instructor A"
  // would pass even against a rule that denies every instructor everywhere —
  // proving boardB1 is genuinely readable BY ITS OWN instructor is what
  // makes the cross-class denial meaningful rather than vacuous.
  it("still lets class B's own instructor read class B's board", async () => {
    await assertSucceeds(getDoc(doc(db(INSTRUCTOR_B), "boards/boardB1")));
  });

  it("denies a random signed-in stranger reading an assignment board via the class path", async () => {
    await assertFails(getDoc(doc(db(STUDENT_C), "boards/boardA1")));
  });
});

// ── M6 board classId is pinned ───────────────────────────────────────────────
// Mirrors "M5 board workspaceId is pinned" above — same pin-the-transition
// shape, for the same reason: without it, a board's own owner (typically
// the exact student who submitted it) could re-parent or clear the class
// linkage and escape the instructor's cohort view after the fact.
describe("M6 board classId is pinned", () => {
  it("lets an enrolled student attach their own board to a class for the first time", async () => {
    await assertSucceeds(
      updateDoc(doc(db(STUDENT_A1), "boards/boardNoClass"), { classId: "classA" })
    );
  });

  it("denies attaching a board to a class the caller is not enrolled in", async () => {
    // studentA1 is enrolled in classA/classC, NOT classB.
    await assertFails(
      updateDoc(doc(db(STUDENT_A1), "boards/boardNoClass"), { classId: "classB" })
    );
  });

  it("denies a non-admin board member from attaching classId, even though they ARE enrolled", async () => {
    // studentA2 is enrolled in classA and IS a member of boardSharedNoClass —
    // but is not its admin/owner. Enrollment alone must not be enough: the
    // caller must also hold write access to the board itself.
    await assertFails(
      updateDoc(doc(db(STUDENT_A2), "boards/boardSharedNoClass"), { classId: "classA" })
    );
  });

  it("denies re-parenting an already-attached board to a different class, even one the caller IS enrolled in", async () => {
    // studentA1 owns boardA1 (classId: classA) and is ALSO enrolled in
    // classC — this isolates the PIN from the enrollment gate: the write
    // must fail because classId is already SET, not merely because of who
    // is enrolled where.
    await assertFails(
      updateDoc(doc(db(STUDENT_A1), "boards/boardA1"), { classId: "classC" })
    );
  });

  it("denies unsetting classId once set", async () => {
    await assertFails(
      updateDoc(doc(db(STUDENT_A1), "boards/boardA1"), { classId: deleteField() })
    );
  });

  it("denies setting classId to null once set", async () => {
    await assertFails(updateDoc(doc(db(STUDENT_A1), "boards/boardA1"), { classId: null }));
  });

  it("still allows re-sending the SAME classId", async () => {
    await assertSucceeds(
      updateDoc(doc(db(STUDENT_A1), "boards/boardA1"), { classId: "classA", title: "Renamed" })
    );
  });

  it("still allows an ordinary admin edit that leaves classId alone", async () => {
    await assertSucceeds(
      updateDoc(doc(db(STUDENT_A1), "boards/boardA1"), { title: "Renamed again" })
    );
  });
});

// ── M6 classes collection ────────────────────────────────────────────────────
describe("M6 classes collection", () => {
  it("denies a direct client class create, even a fully legitimate-looking one", async () => {
    // Creating a class is Cloud-Function-only (functions/src/callable/
    // createClass.ts) so the join code can't be client-chosen — mirrors
    // "board create is Cloud-Function-only" above.
    await assertFails(
      setDoc(doc(db(INSTRUCTOR_A), "classes/newClass"), {
        name: "New Class",
        instructorId: INSTRUCTOR_A,
        joinCode: "AAAAAA",
        studentIds: [],
      })
    );
  });

  // Fix round 1, I4 — a class's full document (roster included) is no
  // longer readable merely by knowing/guessing its classId; that lookup
  // moved to the narrow `joinCodes/{code}` collection tested below. This is
  // the explicit "stranger holding a classId can no longer read the class"
  // proof the fix round asked for, replacing the old (now-wrong) version of
  // this test that asserted the opposite.
  it("denies a signed-in stranger reading a class doc merely by knowing its classId", async () => {
    await assertFails(getDoc(doc(db(STUDENT_C), "classes/classA")));
  });

  it("lets a signed-in user self-enroll by appending only their own uid", async () => {
    await assertSucceeds(
      updateDoc(doc(db(STUDENT_C), "classes/classA"), {
        studentIds: [STUDENT_A1, STUDENT_A2, STUDENT_C],
      })
    );
  });

  // Fix round 1, C1 (CRITICAL) — idempotent resend: an ALREADY-enrolled
  // caller resubmitting the exact same roster (what `arrayUnion` computes
  // for them) must not be rejected outright, since classroomService.
  // enrollInClass no longer pre-checks membership before writing.
  it("lets an already-enrolled caller's redundant self-enroll resubmit succeed as a no-op", async () => {
    await assertSucceeds(
      updateDoc(doc(db(STUDENT_A1), "classes/classA"), {
        studentIds: [STUDENT_A1, STUDENT_A2],
      })
    );
  });

  // Fix round 2, S1 — renamed from "the self-enroll path cannot be used to
  // add a third party": studentC here is NOT already enrolled, so this
  // exercises a different (also real) property than C1's fix — the newly
  // added entry must be the caller, not that an already-enrolled caller
  // can't smuggle one in. Kept (it's a genuine, separate case); only the
  // name was wrong.
  it("a non-enrolled caller cannot add someone else instead of themselves", async () => {
    await assertFails(
      updateDoc(doc(db(STUDENT_C), "classes/classA"), {
        studentIds: [STUDENT_A1, STUDENT_A2, "someoneElse"],
      })
    );
  });

  // Fix round 1, C1 (CRITICAL) — confirmed empirically on the emulator: the
  // ORIGINAL rule only checked `hasAll(prev)` + `size==prev+1` +
  // `hasAny([caller])`, which an ALREADY-ENROLLED caller trivially
  // satisfies while adding an ARBITRARY third uid (they're already in
  // `prev`, so trivially in `next` too) — nothing pinned the ADDED element
  // to the caller specifically. `!(caller in prev)` on the "grow by one"
  // branch closes this: an already-enrolled caller can only ever produce
  // the idempotent no-op above, never a genuine roster growth.
  it("CRITICAL: denies an ALREADY-ENROLLED caller from adding an arbitrary third party", async () => {
    await assertFails(
      updateDoc(doc(db(STUDENT_A1), "classes/classA"), {
        studentIds: [STUDENT_A1, STUDENT_A2, "evilThirdParty"],
      })
    );
  });

  it("the self-enroll path cannot smuggle other field changes alongside the roster append", async () => {
    await assertFails(
      updateDoc(doc(db(STUDENT_C), "classes/classA"), {
        studentIds: [STUDENT_A1, STUDENT_A2, STUDENT_C],
        instructorId: STUDENT_C,
      })
    );
  });

  it("denies a non-instructor renaming someone else's class", async () => {
    await assertFails(updateDoc(doc(db(STUDENT_A1), "classes/classA"), { name: "Hacked" }));
  });

  it("lets the instructor rename their own class", async () => {
    await assertSucceeds(updateDoc(doc(db(INSTRUCTOR_A), "classes/classA"), { name: "Renamed" }));
  });

  it("lets the instructor delete their own class", async () => {
    await assertSucceeds(deleteDoc(doc(db(INSTRUCTOR_A), "classes/classA")));
  });

  it("denies a student deleting their instructor's class", async () => {
    await assertFails(deleteDoc(doc(db(STUDENT_A1), "classes/classA")));
  });
});

// ── Fix round 1, I2: list-query provability ──────────────────────────────────
// Every education-pilot rules test written up to this point was a single-document
// getDoc/updateDoc — nothing proved a `where()` LIST query behaves the same
// way, and per-document gating breaking silently under a list query is
// exactly what cost this branch a round on poll votes previously. Confirmed
// empirically on the emulator (per the fix-round review): a `classId==`
// query against `boards` is a get()-gated predicate, not a bare field
// comparison Firestore can prove safe from the query's own filter alone, so
// the ENTIRE query is denied outright for anyone but that class's own
// instructor — it does NOT silently filter down to a subset.
describe("education pilot: list-query provability (fix round 1, I2)", () => {
  it("lets the instructor list every board in their class via a classId== query", async () => {
    const snap = await assertSucceeds(
      getDocs(query(collection(db(INSTRUCTOR_A), "boards"), where("classId", "==", "classA")))
    );
    const ids = snap.docs.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(["boardA1", "boardA2"]));
  });

  // Denial control 1/2: an enrolled STUDENT of the class running the exact
  // same query shape.
  it("denies an enrolled student the same classId== query (whole-query denial, not silent filtering)", async () => {
    await assertFails(
      getDocs(query(collection(db(STUDENT_A1), "boards"), where("classId", "==", "classA")))
    );
  });

  // Denial control 2/2: a DIFFERENT class's instructor running the same
  // query shape against a class they don't teach.
  it("denies a different class's instructor the same classId== query", async () => {
    await assertFails(
      getDocs(query(collection(db(INSTRUCTOR_B), "boards"), where("classId", "==", "classA")))
    );
  });

  it("lets an instructor list the classes they teach via an instructorId== query", async () => {
    const snap = await assertSucceeds(
      getDocs(query(collection(db(INSTRUCTOR_A), "classes"), where("instructorId", "==", INSTRUCTOR_A)))
    );
    expect(snap.docs.map((d) => d.id)).toContain("classA");
  });

  // Denial control: a signed-in stranger running the exact same query shape
  // about someone ELSE's classes (`instructorId == "instructorA"` while
  // authenticated as studentC, not instructorA). Confirmed empirically on
  // the emulator: Firestore denies the WHOLE list operation here too (same
  // "prove it for every possible match, or reject the entire query" model
  // as the classId== case above) — it does not silently return zero rows.
  it("denies a stranger's instructorId== query about another instructor's classes", async () => {
    await assertFails(
      getDocs(query(collection(db(STUDENT_C), "classes"), where("instructorId", "==", INSTRUCTOR_A)))
    );
  });

  // classroomService.getEnrolledClasses — the same list-provability question
  // for the OTHER new query this fix round's UI wiring introduces.
  it("lets a student list the classes they're enrolled in via a studentIds array-contains query", async () => {
    const snap = await assertSucceeds(
      getDocs(query(collection(db(STUDENT_A1), "classes"), where("studentIds", "array-contains", STUDENT_A1)))
    );
    expect(snap.docs.map((d) => d.id)).toEqual(expect.arrayContaining(["classA", "classC"]));
  });

  it("denies a stranger's array-contains query about another student's enrollment", async () => {
    await assertFails(
      getDocs(query(collection(db(STUDENT_C), "classes"), where("studentIds", "array-contains", STUDENT_A1)))
    );
  });
});

// ── Fix round 1, I3: roster removal + classId cleanup ────────────────────────
// Without a removal lever, a roster polluted via a bad write (or C1, before
// its fix) had NO cleanup path at all: `joinCode` is immutable and deleting
// the whole class is destructive. These two levers are the fix.
describe("fix round 1, I3: instructor roster removal", () => {
  it("lets the instructor remove exactly one student from the roster", async () => {
    await assertSucceeds(
      updateDoc(doc(db(INSTRUCTOR_A), "classes/classA"), { studentIds: [STUDENT_A1] })
    );
  });

  it("denies a non-instructor removing a student from the roster", async () => {
    await assertFails(
      updateDoc(doc(db(STUDENT_A1), "classes/classA"), { studentIds: [STUDENT_A1] })
    );
  });

  // Fix round 2, S1 — renamed from "denies the instructor removing more
  // than one student in a single write": that name claimed a property the
  // rule (before this round) didn't have. This test itself only exercises
  // shrinking the WHOLE roster to `[]`, which the plain size check alone
  // already denies (0 != 2-1) — it says nothing about the duplicate-uid
  // case below, which needed a separate clause.
  it("denies the instructor shrinking the roster by more than one entry in a single write", async () => {
    await assertFails(updateDoc(doc(db(INSTRUCTOR_A), "classes/classA"), { studentIds: [] }));
  });

  // Fix round 2, S1 (new) — confirmed empirically that the PRE-fix rule
  // allowed this: `hasAll(prev)` ignores duplicates and `size==prev-1`
  // only counts array length, so on a 3-entry roster, `[s1,s1]` (2 ==
  // 3-1, passes both) actually removes TWO distinct entries while
  // duplicating a third — the exact opposite of "removing one student".
  // Uses classD (3 students) — classA's 2-student roster can't exercise
  // this shape at all (a 2-entry duplicate array isn't even a size-1
  // shrink from size 2). Tightened with one clause
  // (`toSet().size()==size()`) rather than merely softening the claim,
  // since the fix was that cheap; also closes a duplicate-React-key
  // hazard in ClassroomHome's roster list.
  it("denies the instructor 'removing' a student by duplicating another uid instead", async () => {
    await assertFails(
      updateDoc(doc(db(INSTRUCTOR_A), "classes/classD"), {
        studentIds: [STUDENT_A1, STUDENT_A1],
      })
    );
  });

  // Proves the removal arm can't be repurposed to ADD someone under cover
  // of "shrinking" — hasAll(prev) requires next ⊆ prev.
  it("denies the instructor using the removal arm to add a student instead", async () => {
    await assertFails(
      updateDoc(doc(db(INSTRUCTOR_A), "classes/classA"), {
        studentIds: [STUDENT_A1, STUDENT_A2, "newStudent"],
      })
    );
  });

  // Fix round 2, S2 — an instructor "removing" a uid that's already gone
  // (a resend of the CURRENT roster, unchanged) must succeed as a no-op
  // rather than being denied by the removal arm's own strict size-1
  // check. It does — REDUNDANTLY, via two OTHER arms at once, neither of
  // them a removal-specific clause: the rename arm (an unchanged-
  // `studentIds` write has an empty/`updatedAt`-only `affectedKeys()`
  // diff, which `hasOnly(['name','updatedAt'])` accepts vacuously) and
  // the self-enroll arm's own `next==prev` branch (open to any signed-in
  // caller, not instructor-specific). Fix round 3 — a removal-arm
  // idempotent clause was tried and its removal verified by ARM
  // ISOLATION (disable rename alone: still passes; disable self-enroll's
  // idempotent branch alone: still passes; disable both: only then
  // fails) — an earlier verification pass had checked only "disable the
  // removal-specific clause," which cannot distinguish two redundant
  // grantors from three, and wrongly credited self-enroll alone.
  it("lets the instructor resubmit the SAME roster as a no-op", async () => {
    await assertSucceeds(
      updateDoc(doc(db(INSTRUCTOR_A), "classes/classA"), {
        studentIds: [STUDENT_A1, STUDENT_A2],
      })
    );
  });
});

describe("fix round 1, I3: classId clears once its class is deleted", () => {
  it("denies clearing classId while the class still exists", async () => {
    // boardA1's classId is classA, which still exists in this test — same
    // property "denies unsetting classId once set" above already covers,
    // restated here as the explicit negative control for the test below.
    await assertFails(updateDoc(doc(db(STUDENT_A1), "boards/boardA1"), { classId: null }));
  });

  it("lets the board admin clear classId once its class has been deleted", async () => {
    await assertSucceeds(deleteDoc(doc(db(INSTRUCTOR_C), "classes/classC")));
    await assertSucceeds(
      updateDoc(doc(db(STUDENT_A1), "boards/boardInClassC"), { classId: null })
    );
  });
});

// ── Fix round 1, I4: joinCodes lookup collection ─────────────────────────────
// The narrow self-enrollment credential: holds ONLY `{classId}` per code, so
// resolving a code never requires (or grants) reading the class document's
// roster.
describe("fix round 1, I4: joinCodes collection", () => {
  it("lets any signed-in user read a joinCodes lookup doc", async () => {
    const snap = await assertSucceeds(getDoc(doc(db(STUDENT_C), "joinCodes/CLASSA1")));
    expect(snap.data()).toEqual({ classId: "classA" });
  });

  it("denies a client creating a joinCodes doc", async () => {
    await assertFails(
      setDoc(doc(db(INSTRUCTOR_A), "joinCodes/HACKED1"), { classId: "classA" })
    );
  });

  it("denies a client overwriting an existing joinCodes doc", async () => {
    await assertFails(
      setDoc(doc(db(INSTRUCTOR_A), "joinCodes/CLASSA1"), { classId: "classB" })
    );
  });

  it("denies a client deleting a joinCodes doc", async () => {
    await assertFails(deleteDoc(doc(db(INSTRUCTOR_A), "joinCodes/CLASSA1")));
  });

  // Fix round 2, N1 (CRITICAL, caught on re-review) — `allow read` with no
  // `resource` reference covers `list` as well as `get`, and is trivially
  // list-provable. Confirmed empirically: a signed-in stranger could
  // enumerate EVERY join code in the system in one query, then self-enroll
  // into and read the full roster of each — worse than the pre-fix-round-1
  // state, which needed one classId per class. This is the explicit test
  // that hole was missing entirely; `get`/`list` split in firestore.rules
  // closes it.
  it("denies listing the joinCodes collection — get-by-id only, never enumerable", async () => {
    await assertFails(getDocs(collection(db(STUDENT_C), "joinCodes")));
  });
});
