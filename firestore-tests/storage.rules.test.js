/**
 * Emulator-backed Cloud Storage security-rules tests.
 *
 * `storage.rules` shipped in Month 2 and was never wired into `firebase.json`
 * and never tested, so until this file existed nothing — not one assertion —
 * exercised it. It is STILL not deployed (see the banner at the top of
 * storage.rules); this suite is what makes it safe to deploy, not a record
 * that it was.
 *
 * Runs under `firebase emulators:exec --only firestore,storage` (see
 * `npm run test:rules`). BOTH emulators are required, and not incidentally:
 * every predicate in storage.rules resolves board membership cross-service via
 *   firestore.get(/databases/(default)/documents/boards/$(boardId)).data.members
 * so with the Firestore emulator absent, or the board doc unseeded, every
 * assertion here — including the positive ones — collapses to "denied". That
 * is the vacuous-pass trap this file is shaped to avoid: every deny below is
 * paired with a positive control that only passes if membership genuinely
 * resolved.
 *
 * Fixture:
 *   boards/boardOpen   members [alice]       — the one board that exists
 *   boardMissing       no Firestore doc at all
 *
 *   alice — member          bob — signed in, NOT a member       (+ unauthenticated)
 *
 * API NOTE — the compat/modular split below is the library's, not a choice.
 * `RulesTestContext.firestore()` returns a MODULAR `Firestore` (so the seeding
 * code uses `firebase/firestore`'s `doc`/`setDoc`, matching
 * firestore.rules.test.js), but `RulesTestContext.storage()` is typed
 * `firebase.storage.Storage` — the COMPAT surface — so every storage call here
 * is compat-style (`ref()`, `put()`, `getDownloadURL()`, `delete()`) rather
 * than the modular `firebase/storage` API the app itself uses. Verified
 * against the installed @firebase/rules-unit-testing 5.0.1
 * (dist/rules-unit-testing/src/public_types: `storage(bucketUrl?: string):
 * firebase.storage.Storage`). Do not "modernise" these calls to match the app.
 */
const { readFileSync } = require("fs");
const path = require("path");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { doc, setDoc } = require("firebase/firestore");

const ALICE = "alice"; // in boardOpen.members
const BOB = "bob"; // signed in, deliberately NOT in boardOpen.members

const BOARD = "boardOpen";
const NO_SUCH_BOARD = "boardMissing"; // no Firestore doc — firestore.get() finds nothing

// Content types the app actually sends: imageService.ts uploads image/jpeg
// (full.jpg / thumb.jpg), audioService.ts uploads audio/mp4 (note.m4a).
const IMAGE_TYPE = "image/jpeg";
const AUDIO_TYPE = "audio/mp4";

// The two ceilings in storage.rules, expressed exactly as the rules do. Both
// are strict `<`, so MAX itself must be DENIED and MAX-1 allowed; the boundary
// tests below pin that direction so a later `<=` slip is caught.
const IMAGE_MAX = 10 * 1024 * 1024;
const AUDIO_MAX = 2 * 1024 * 1024;

// Objects seeded with rules bypassed, so the read-deny tests read a REAL
// object. This matters more than it looks: `assertFails` recognises a storage
// denial by the string "unauthorized" in the error, so a read of a
// NON-existent object (404 object-not-found) does not satisfy it — it reports
// "Expected PERMISSION_DENIED but got unexpected error". Reading a seeded
// object keeps every read-deny honest about WHY it failed.
const SEED_IMAGE = `boards/${BOARD}/images/imgSeed/full.jpg`;
const SEED_AUDIO = `boards/${BOARD}/audio/audSeed/note.m4a`;
const SEED_OUTSIDE = `boards/${BOARD}/exports/report.pdf`;

function bytes(n) {
  return new Uint8Array(n);
}

// Thin promise wrappers. `ref.put()` returns an UploadTask rather than a plain
// Promise; awaiting it inside an async function normalises it so assertFails /
// assertSucceeds see an ordinary rejection carrying the SDK's error code.
async function upload(ctx, objectPath, data, contentType) {
  await ctx.storage().ref(objectPath).put(data, { contentType });
}
function read(ctx, objectPath) {
  return ctx.storage().ref(objectPath).getDownloadURL();
}
function remove(ctx, objectPath) {
  return ctx.storage().ref(objectPath).delete();
}

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-board-rules",
    // Both configs are required. `storage` is the ruleset under test; the
    // `firestore` half is not decoration — it is what connects this
    // environment to the Firestore emulator that storage.rules' cross-service
    // `firestore.get()` reads the board doc from.
    storage: {
      rules: readFileSync(path.resolve(__dirname, "../storage.rules"), "utf8"),
    },
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
  // NOTE: no `testEnv.clearStorage()`. It is implemented as
  // `storage().ref().listAll()` + delete, and `listAll()` does not recurse into
  // prefixes — every object here lives under `boards/...`, so it would clear
  // nothing and only look like isolation. Tests are written not to depend on
  // it: uploads overwrite by path, and each test that asserts a successful
  // write uses its own object name.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `boards/${BOARD}`), {
      title: "Storage fixture",
      ownerId: ALICE,
      adminId: ALICE,
      members: [ALICE],
    });
    const store = ctx.storage();
    await store.ref(SEED_IMAGE).put(bytes(64), { contentType: IMAGE_TYPE });
    await store.ref(SEED_AUDIO).put(bytes(64), { contentType: AUDIO_TYPE });
    await store.ref(SEED_OUTSIDE).put(bytes(64), { contentType: "application/pdf" });
  });
});

describe("harness", () => {
  // A brand-new emulator suite's loudest failure is silence: if the storage
  // emulator never came up, `emulators:exec` would still run jest and every
  // test below would either not run or fail for the wrong reason. Assert the
  // discovery explicitly so "storage emulator missing" reads as a named
  // failure rather than a mystery.
  it("discovered the storage emulator", () => {
    expect(testEnv.emulators.storage).toBeDefined();
    expect(testEnv.emulators.storage.port).toEqual(expect.any(Number));
  });

  it("discovered the firestore emulator storage.rules resolves membership through", () => {
    expect(testEnv.emulators.firestore).toBeDefined();
  });
});

describe("images — board membership", () => {
  it("lets a board member read an image", async () => {
    await assertSucceeds(read(testEnv.authenticatedContext(ALICE), SEED_IMAGE));
  });

  it("lets a board member write an image", async () => {
    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/imgMemberWrite/full.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );
  });

  it("lets a board member delete an image", async () => {
    // Worth its own case: the match has BOTH `allow write` (which in Storage
    // rules subsumes delete, and ANDs in isValidImageUpload) and a separate
    // `allow delete`. On a delete there is no `request.resource`, so the write
    // arm cannot be what grants this — the standalone delete arm has to.
    await assertSucceeds(remove(testEnv.authenticatedContext(ALICE), SEED_IMAGE));
  });

  it("denies a non-member read", async () => {
    await assertFails(read(testEnv.authenticatedContext(BOB), SEED_IMAGE));
  });

  it("denies a non-member write", async () => {
    await assertFails(
      upload(
        testEnv.authenticatedContext(BOB),
        `boards/${BOARD}/images/imgNonMember/full.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );
  });

  it("denies a non-member delete", async () => {
    await assertFails(remove(testEnv.authenticatedContext(BOB), SEED_IMAGE));
  });

  it("denies an unauthenticated read", async () => {
    await assertFails(read(testEnv.unauthenticatedContext(), SEED_IMAGE));
  });

  it("denies an unauthenticated write", async () => {
    await assertFails(
      upload(
        testEnv.unauthenticatedContext(),
        `boards/${BOARD}/images/imgAnon/full.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );
  });
});

describe("images — 10 MB ceiling", () => {
  it("allows an upload under the ceiling", async () => {
    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/imgSmall/full.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );
  });

  it("allows an upload one byte under the ceiling", async () => {
    // The positive half of the boundary. Without it, "10 MB is denied" would
    // also pass against a rule that denied every image upload outright.
    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/imgJustUnder/full.jpg`,
        bytes(IMAGE_MAX - 1),
        IMAGE_TYPE
      )
    );
  });

  it("denies an upload exactly at the ceiling", async () => {
    // `size < 10 * 1024 * 1024` is strict, so MAX itself must fail.
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/imgAtLimit/full.jpg`,
        bytes(IMAGE_MAX),
        IMAGE_TYPE
      )
    );
  });

  it("denies an upload over the ceiling", async () => {
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/imgTooBig/full.jpg`,
        bytes(IMAGE_MAX + 1024),
        IMAGE_TYPE
      )
    );
  });
});

describe("images — content type", () => {
  it("allows an image/* content type", async () => {
    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/imgTypeOk/full.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );
  });

  it("denies a non-image content type", async () => {
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/imgTypeBad/full.jpg`,
        bytes(64),
        "application/pdf"
      )
    );
  });

  it("denies an audio content type on the image path", async () => {
    // The two match blocks are not interchangeable: the image path enforces
    // its OWN type constraint, not "any of the types this file knows about".
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/imgTypeAudio/full.jpg`,
        bytes(64),
        AUDIO_TYPE
      )
    );
  });
});

describe("audio — board membership", () => {
  it("lets a board member read a voice note", async () => {
    await assertSucceeds(read(testEnv.authenticatedContext(ALICE), SEED_AUDIO));
  });

  it("lets a board member write a voice note", async () => {
    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/audio/audMemberWrite/note.m4a`,
        bytes(64),
        AUDIO_TYPE
      )
    );
  });

  it("lets a board member delete a voice note", async () => {
    await assertSucceeds(remove(testEnv.authenticatedContext(ALICE), SEED_AUDIO));
  });

  it("denies a non-member read", async () => {
    await assertFails(read(testEnv.authenticatedContext(BOB), SEED_AUDIO));
  });

  it("denies a non-member write", async () => {
    await assertFails(
      upload(
        testEnv.authenticatedContext(BOB),
        `boards/${BOARD}/audio/audNonMember/note.m4a`,
        bytes(64),
        AUDIO_TYPE
      )
    );
  });

  it("denies a non-member delete", async () => {
    await assertFails(remove(testEnv.authenticatedContext(BOB), SEED_AUDIO));
  });

  it("denies an unauthenticated read", async () => {
    await assertFails(read(testEnv.unauthenticatedContext(), SEED_AUDIO));
  });

  it("denies an unauthenticated write", async () => {
    await assertFails(
      upload(
        testEnv.unauthenticatedContext(),
        `boards/${BOARD}/audio/audAnon/note.m4a`,
        bytes(64),
        AUDIO_TYPE
      )
    );
  });
});

describe("audio — 2 MB ceiling", () => {
  it("allows an upload under the ceiling", async () => {
    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/audio/audSmall/note.m4a`,
        bytes(64),
        AUDIO_TYPE
      )
    );
  });

  it("allows an upload one byte under the ceiling", async () => {
    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/audio/audJustUnder/note.m4a`,
        bytes(AUDIO_MAX - 1),
        AUDIO_TYPE
      )
    );
  });

  it("denies an upload exactly at the ceiling", async () => {
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/audio/audAtLimit/note.m4a`,
        bytes(AUDIO_MAX),
        AUDIO_TYPE
      )
    );
  });

  it("denies an audio upload sized for the image ceiling", async () => {
    // 4 MB is comfortably legal on the image path and illegal here — proof the
    // audio block carries its own, tighter number rather than sharing one.
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/audio/audImageSized/note.m4a`,
        bytes(4 * 1024 * 1024),
        AUDIO_TYPE
      )
    );
  });
});

describe("audio — content type", () => {
  it("allows the audio/mp4 type audioService.ts actually sends", async () => {
    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/audio/audTypeOk/note.m4a`,
        bytes(64),
        AUDIO_TYPE
      )
    );
  });

  it("denies a non-audio content type", async () => {
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/audio/audTypeBad/note.m4a`,
        bytes(64),
        "application/pdf"
      )
    );
  });

  it("denies an image content type on the audio path", async () => {
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/audio/audTypeImage/note.m4a`,
        bytes(64),
        IMAGE_TYPE
      )
    );
  });
});

describe("membership resolves through the board doc", () => {
  // storage.rules never sees a member list of its own — it reads one out of
  // Firestore. These pin that the cross-service read is what decides, rather
  // than anything about the path or the caller's mere signed-in-ness.
  it("denies a member of NO board on a board that does not exist", async () => {
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${NO_SUCH_BOARD}/images/imgGhost/full.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );
  });

  it("denies reading from a board that does not exist", async () => {
    await assertFails(
      read(testEnv.authenticatedContext(ALICE), `boards/${NO_SUCH_BOARD}/images/imgGhost/full.jpg`)
    );
  });

  it("grants access as soon as the board doc lists the caller", async () => {
    // The same uid, the same path, denied above as a non-member — allowed here
    // only because the board doc changed. This is the control that proves the
    // deny tests above are about MEMBERSHIP and not about bob, or about some
    // unrelated blanket denial.
    await assertFails(
      upload(
        testEnv.authenticatedContext(BOB),
        `boards/${BOARD}/images/imgBobTurn/full.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `boards/${BOARD}`), {
        title: "Storage fixture",
        ownerId: ALICE,
        adminId: ALICE,
        members: [ALICE, BOB],
      });
    });

    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(BOB),
        `boards/${BOARD}/images/imgBobTurn/full.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );
  });
});

describe("paths outside both match blocks", () => {
  // storage.rules' closing line claims "everything else is denied by default
  // (no catch-all match)". Nothing checked that until this block. Each case
  // uses ALICE — a full member of the board — so a denial can only come from
  // the path falling outside both matches, never from membership.
  it("denies a member on a sibling prefix under the same board", async () => {
    await assertFails(read(testEnv.authenticatedContext(ALICE), SEED_OUTSIDE));
  });

  it("denies a member writing to a sibling prefix under the same board", async () => {
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/exports/new.pdf`,
        bytes(64),
        "application/pdf"
      )
    );
  });

  it("denies a member writing to the bucket root", async () => {
    await assertFails(
      upload(testEnv.authenticatedContext(ALICE), "rogue.jpg", bytes(64), IMAGE_TYPE)
    );
  });

  it("denies a member writing outside the boards/ prefix entirely", async () => {
    await assertFails(
      upload(testEnv.authenticatedContext(ALICE), "users/alice/avatar.jpg", bytes(64), IMAGE_TYPE)
    );
  });

  it("denies an image one path segment too short", async () => {
    // The match is exactly /boards/{boardId}/images/{imageId}/{fileName}.
    // Dropping {fileName} leaves a path nothing matches.
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/loose.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );
  });

  it("denies an image nested one segment too deep", async () => {
    // {fileName} is a single segment, not a `=**` wildcard, so nothing under
    // an imageId directory is reachable. imageService.ts writes full.jpg and
    // thumb.jpg directly under {imageId}, so this costs the app nothing — but
    // it is a real constraint and it should be visible here.
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/imgDeep/variants/full.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );
  });

  it("denies audio nested one segment too deep", async () => {
    await assertFails(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/audio/audDeep/takes/note.m4a`,
        bytes(64),
        AUDIO_TYPE
      )
    );
  });

  it("still allows the two matched paths — the control for this whole block", async () => {
    // Without this, every deny above would also pass against a ruleset that
    // denied the member everything.
    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/images/imgControl/full.jpg`,
        bytes(64),
        IMAGE_TYPE
      )
    );
    await assertSucceeds(
      upload(
        testEnv.authenticatedContext(ALICE),
        `boards/${BOARD}/audio/audControl/note.m4a`,
        bytes(64),
        AUDIO_TYPE
      )
    );
  });
});
