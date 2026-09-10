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

    // M5 — plan metering docs (written by Functions in prod). Seeded here with
    // rules bypassed to test client read/write access against them.
    await setDoc(doc(db, "workspaces/wsA/usage/2026-09"), { sessions: 1, updatedAt: 0 });
    await setDoc(doc(db, "workspaces/wsA/billing/subscription"), { plan: "free" });

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
