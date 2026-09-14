import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../config/firebase";
import * as boardService from "./boardService";
import * as sessionService from "./sessionService";
import * as pathService from "./pathService";
import * as templateService from "./templateService";
import type { SessionSummary } from "../types";

/**
 * Month 6 — sample workspace seeding (ROADMAP.md's "Sample workspace
 * seeding": a new signup should land in a populated workspace, never a zero
 * state). NOT the 90-second tutorial — that shipped in Month 5 as
 * `src/components/onboarding/OnboardingTutorial.tsx`; this module never
 * touches it.
 *
 * Wired from ONE place: `authService.ensureUserProvisioned`, guarded to only
 * the branch that is provisioning a genuinely brand-new account (never a
 * returning sign-in) — see that function's own comment for why. That single
 * seam covers both email signup and first Google sign-in (authProviders.ts),
 * so there is exactly one place this runs, not three.
 *
 * Three deliberate design calls, each answering a question the brief itself
 * raises rather than settles:
 *
 * 1. QUOTA — boards and sessions are metered by two DIFFERENT mechanisms, and
 *    the seed's cost lands differently on each: unavoidable but refundable for
 *    boards, and (since the welcome-session grant) zero for sessions.
 *    Conflating the two would misstate the tradeoff, so they're spelled out
 *    separately:
 *    - BOARDS: `countBoards` (functions/src/billing/usage.ts) is a LIVE
 *      count — `.where("workspaceId","==",id).count()` over whatever
 *      documents currently exist. There is no way to create a real board
 *      under this workspace, admin-written or not, without it counting —
 *      going through the capped `boardService.createBoard` here costs
 *      nothing extra over any other route, since every route costs the
 *      same slot. It's also refundable: deleting the sample board later
 *      frees that slot back immediately, because the count is live.
 *    - SESSIONS: the cap is a STORED MONTHLY COUNTER
 *      (`workspaces/{id}/usage/{period}`, bumped only inside
 *      `createSession`'s own transaction —
 *      functions/src/callable/createSession.ts), not a live count, and it
 *      only ever increments: a session charged to it is never given back,
 *      not even by deleting the session. Seeding through the ordinary
 *      metered path therefore cost a free account 1 of its 3 monthly
 *      sessions — a third of the first month, spent on a demo the user never
 *      asked for and could not refund. That cost was disclosed and accepted
 *      here for a while. It is no longer the behaviour.
 *
 *      It is now paid for by a WELCOME-SESSION GRANT: the create below passes
 *      `{ welcomeSessionGrant: true }`, and the callable creates that one
 *      session without touching the counter, marking the workspace
 *      (`welcomeSessionGrantUsed`) inside the SAME transaction so the grant
 *      can never be taken twice. The new user keeps all three.
 *
 *      What did NOT change is the part worth protecting: the seed still goes
 *      through the real `sessionService.createSession` and the one metered
 *      callable. An Admin-SDK seed writing a session document directly would
 *      NOT touch that counter and would be a genuine hole in the enforcement
 *      surface — a second creation path is a second thing to keep in sync
 *      with the cap, which is exactly the failure mode the original "just pay
 *      the cap" choice was avoiding. The grant is an extra branch of the
 *      single metered path, not a way around it, and the un-metered create
 *      and the marker recording it commit together or not at all.
 *
 *      The honest cost that remains: `welcomeSessionGrant` crosses the
 *      callable boundary as client-supplied data, so a patched client can ask
 *      for it on an ordinary session and spend it there. The server-side
 *      marker bounds that to ONE extra session per workspace, ever — 4 in
 *      some month instead of 3, once — and firestore.rules pins the marker
 *      alongside `plan` and `ownerId`, so a client cannot clear it and
 *      re-claim. See the callable's module header for the full reasoning.
 *
 * 2. WHERE THIS RUNS — client-side, calling the real callables, subject to
 *    the real caps described above. For boards this is free (see above — an
 *    Admin-SDK path would cost the same live-counted slot anyway). For
 *    sessions a server-side Admin-SDK seed genuinely WOULD have bypassed the
 *    cap for free — that was a real option, not a non-option — and it is
 *    still deliberately not taken, even now that the session itself is free.
 *    The exemption lives in the callable, decided and recorded server-side in
 *    one transaction, rather than in a bypass here that a future reader would
 *    have to rediscover; and there is still exactly one creation mechanism for
 *    both resource types instead of a board/session split.
 *
 * 3. NO AI CALL (a deliberate divergence from ROADMAP.md's literal wording,
 *    "a finished session with an AI summary") — the "AI summary" on the
 *    seeded session is the canned `SAMPLE_SESSION_SUMMARY` below, written
 *    directly via `sessionService.updateSessionSummary`. Nothing here calls
 *    `generateSummary` or any other AI callable. Reasons, per the brief's own
 *    warning: the four AI callables cost real money per call, are
 *    quota-gated (would spend a brand-new account's `aiCallsPerPeriod`
 *    analyzing placeholder template text before they've done anything), and
 *    their feature flags are off. There's also a trust reason independent of
 *    cost: presenting a fake "we analyzed your session" as though real
 *    analysis occurred is itself a problem, so the copy is written to read
 *    as an example ("this is what a recap looks like"), never as though the
 *    seed board's placeholder template text was actually analyzed.
 *
 * 4. MOCK ROSTER — deliberately NOT a `classes/{id}` document. Task 27's
 *    education pilot (see classroomService.ts and firestore.rules'
 *    `classes` block) is invite-based self-enrollment ONLY, specifically so
 *    no roster of a person who never signed up is ever collected; rules
 *    enforce that a `studentIds` entry can only ever be the caller's own
 *    uid. A "mock roster" of invented names has no legitimate way into that
 *    collection, and manufacturing one would be exactly the bulk-PII-style
 *    artifact the education pilot was reshaped to avoid. Instead the roster
 *    is presentational sample content — a sticky note on the seeded board
 *    naming a few clearly-fictional teammates — never a real class, never a
 *    real `users/` doc, never a real uid.
 *
 * CF-14 — `applyTemplateToBoard` (and this module's own follow-on writes)
 * have no rollback of their own: a throw partway through leaves a freshly
 * created board holding some elements and no cleanup, which is worst here of
 * all call sites, since it's a brand-new user's very first board. This
 * function deliberately does NOT call `templateService.createBoardFromTemplate`
 * (which bundles create + apply with no way for the caller to recover the
 * boardId on a mid-apply throw) — it inlines the same two steps itself so it
 * keeps `boardId` (and later `sessionId`) in hand and can roll back whatever
 * was actually created. Combined with the `sampleSeededAt` marker only being
 * written on full success, a later retry (the user's next sign-in, if this
 * account is ever re-provisioned) converges: either everything from a prior
 * attempt was already cleaned up and it seeds fresh, or it was fully seeded
 * and this is a no-op.
 *
 * Side benefit of that same choice: skipping `createBoardFromTemplate` also
 * means this seed never fires `track("board_created", …)` (that call lives
 * at templateService.ts:274, inside `createBoardFromTemplate` specifically —
 * `applyTemplateToBoard` alone does not call it), and neither
 * `boardService.createBoard` nor `sessionService.createSession`/`endSession`/
 * `updateSessionSummary` fire `track()` internally either. So the seeded
 * board/session never inflate the `board_created` / `session_scheduled` /
 * `session_completed` funnel counters Month 6's analytics work (ROADMAP's
 * A1) depends on for a clean pre-launch baseline. This is a STRUCTURAL
 * guarantee, not just a promise kept today — but it depends on staying off
 * `createBoardFromTemplate`, so don't "simplify" this function back onto it
 * without re-checking that call site's `track()` call first.
 *
 * As of ROADMAP.md:685's funnel instrumentation, the half of that guarantee a
 * comment cannot defend is enforced:
 * `src/services/__tests__/analyticsBoundary.test.ts` scans this file,
 * boardService.ts, sessionService.ts and workspaceService.ts as source text
 * and fails the build if any of them gains a `track(` call or an import of the
 * analytics seam. The funnel is instrumented at the point of USER INTENT
 * instead — the screens and components where a person pressed the button —
 * which is the convention templateService's own `track("board_created")`
 * already set and which this seed depends on.
 *
 * Known gaps, disclosed rather than fixed:
 *  - If a first seeding attempt fails AND its own rollback also fails (a true
 *    double failure), the account is left permanently unseeded: seeding is
 *    gated on `isNewAccount` in authService.ts, which is only ever true once
 *    per uid (the moment the `users/{uid}` profile doc is created), so there
 *    is no later retry. Chosen over a broader "always attempt, check the
 *    flag" gate specifically to guarantee the more important property: an
 *    EXISTING account is never retroactively seeded on a later sign-in.
 *  - `getDoc` and the final `updateDoc` below are not wrapped in a Firestore
 *    transaction, so two genuinely simultaneous sign-ins for the same
 *    brand-new account (e.g. two devices completing signup at the same
 *    instant) could both read `sampleSeededAt` as unset and both seed,
 *    double-creating the sample board/session. Sequential re-entry ("signing
 *    in twice") is fully handled by the marker check; true concurrency is
 *    not.
 */

const SAMPLE_TEMPLATE_ID = "cornell-notes";

/** Sticky-note position, below the Cornell Notes template's summary strip
 *  (which ends at y=696) so it never overlaps the template's own elements. */
const ROSTER_NOTE_POSITION = { x: 0, y: 712 };

// Deliberately fictional — never a real account, never written to `classes`
// or `users`. See the module header's "MOCK ROSTER" note above.
export const SAMPLE_ROSTER_NOTE_CONTENT =
  "Sample study group — example names, not real accounts:\n" +
  "Alex Chen · Jordan Rivera · Sam Patel · Morgan Lee\n\n" +
  "Invite your real teammates from this board's Share menu.";

// Canned — never the output of an AI callable. Framed as illustrative so it's
// never mistaken for a real analysis of this placeholder board's content.
export const SAMPLE_SESSION_SUMMARY: SessionSummary = {
  tldr:
    "Sample recap — this is what an AI-generated session summary looks like. " +
    "Start your own session and end it to generate a real one from what your group actually covers.",
  actionItems: ["Look over the Cornell Notes board above", "Start your own session when you're ready"],
  decisions: [],
  openQuestions: [],
};

const SAMPLE_SESSION_TITLE = "Sample study session";
const SAMPLE_SESSION_DESCRIPTION =
  "An example finished session with a sample recap, so you can see what one looks like.";
const SAMPLE_SESSION_DURATION_MINUTES = 30;

/** Best-effort delete, never throws — used only inside this module's own
 *  rollback path, where the create attempt has already failed and a second
 *  failure here must not surface a different (and more confusing) error. */
async function safeDeleteBoard(boardId: string): Promise<void> {
  try {
    await boardService.deleteBoard(boardId);
  } catch {
    // swallow — best-effort cleanup only; see the module header's CF-14 note.
  }
}

async function safeDeleteSession(sessionId: string): Promise<void> {
  try {
    await sessionService.deleteSession(sessionId);
  } catch {
    // swallow — best-effort cleanup only; see the module header's CF-14 note.
  }
}

/**
 * Seeds `workspaceId` with a sample board (from the Cornell Notes template),
 * a finished session carrying a canned summary, and a mock roster note —
 * once. Idempotent via `workspaces/{workspaceId}.sampleSeededAt`: a second
 * call (this account's next sign-in, or a caller retrying) is a cheap no-op
 * once that marker is set.
 *
 * Never throws — every create step is wrapped so a failure rolls back
 * whatever THIS attempt created and returns quietly, leaving the marker
 * unset so a future call can retry cleanly (see the module header's CF-14
 * note). Callers therefore don't need their own try/catch, though
 * `authService.ensureUserProvisioned` keeps one anyway as defense in depth.
 */
export async function seedSampleWorkspace(
  workspaceId: string,
  uid: string,
  displayName: string = ""
): Promise<void> {
  // This read and the `sampleSeededAt` write far below are NOT wrapped in a
  // Firestore transaction — see the module header's "known gaps" note. Two
  // genuinely simultaneous calls for the same brand-new workspace could both
  // pass this check before either write lands, and both seed. Sequential
  // re-entry (this account's next sign-in reading what a prior, already-
  // finished call wrote) is what this guards, and does so correctly.
  const wsRef = doc(db, "workspaces", workspaceId);
  const wsSnap = await getDoc(wsRef);
  if (!wsSnap.exists()) return;

  const wsData = wsSnap.data() as Record<string, unknown> | undefined;
  if (wsData?.sampleSeededAt) return; // already seeded — idempotent no-op

  const template = templateService.getTemplate(SAMPLE_TEMPLATE_ID);
  if (!template) return; // defensive; every shipped template id resolves

  let boardId: string | undefined;
  let sessionId: string | undefined;

  try {
    // Board phase: create (capped, same path as any user-initiated create),
    // then apply the template's elements, then the mock-roster sticky note.
    // The literal `"free", 0` below (and the `{ plan: "free", currentCount: 0 }`
    // on the session create further down) are correct ONLY because this
    // workspace was just created and genuinely has zero prior boards/sessions
    // — they are not a safe default to reuse anywhere else `boardService`/
    // `sessionService` are called from. `assertQuota` (quotaService.ts) is a
    // client-side ADVISORY pre-flight only; the real callable re-derives the
    // authoritative plan/count itself, so a stale value passed here would
    // fail safe (at worst a pointless round trip), not open a hole — but a
    // future caller copying this literal into a context where it might be
    // wrong would not get that same protection for free.
    boardId = await boardService.createBoard(template.title, uid, workspaceId, "free", 0);
    await templateService.applyTemplateToBoard(boardId, uid, template);
    await pathService.saveTextNote(boardId, {
      boardId,
      userId: uid,
      content: SAMPLE_ROSTER_NOTE_CONTENT,
      position: ROSTER_NOTE_POSITION,
    });

    // Session phase: create, then transition straight to "ended" with a canned
    // summary — never a real generateSummary call.
    //
    // `{ welcomeSessionGrant: true }` is the ONE call site in the repo that
    // asks for it (module header, note 1): the callable creates this session
    // without charging the monthly counter and marks the workspace in the same
    // transaction, so a free signup keeps all three of its own sessions and the
    // grant can never be taken twice.
    //
    // Passing it also makes `sessionService.createSession` skip the advisory
    // client-side pre-flight entirely (see that function's doc comment), so
    // the `{ plan: "free", currentCount: 0 }` hint below is NOT read on this
    // path today — it is passed anyway so the call still states the truth
    // about this workspace and keeps its meaning if the grant argument is ever
    // dropped. The same fresh-workspace-only caveat as the board create above
    // applies to those literals, and is the reason they are not a safe default
    // to copy elsewhere.
    sessionId = await sessionService.createSession(
      {
        workspaceId,
        boardId,
        boardTitle: template.title,
        title: SAMPLE_SESSION_TITLE,
        description: SAMPLE_SESSION_DESCRIPTION,
        scheduledAt: new Date(),
        durationMinutes: SAMPLE_SESSION_DURATION_MINUTES,
        createdById: uid,
        createdByName: displayName,
        participantIds: [],
        status: "scheduled",
      },
      { plan: "free", currentCount: 0 },
      { welcomeSessionGrant: true }
    );
    await sessionService.endSession(sessionId);
    await sessionService.updateSessionSummary(sessionId, SAMPLE_SESSION_SUMMARY);

    // The marker write is INSIDE this same guarded block, deliberately: if it
    // fails, the catch below rolls back the board and session we just built
    // too. Otherwise a marker failure after a fully-successful seed would
    // leave `sampleSeededAt` unset with the board+session already created —
    // and the next retry would seed a SECOND copy on top of them, since
    // nothing on disk would say the first attempt had finished. Rolling back
    // keeps the invariant simple: either fully seeded AND marked, or fully
    // rolled back and unmarked, never a successful seed masquerading as one
    // still pending.
    await updateDoc(wsRef, { sampleSeededAt: serverTimestamp() });
  } catch {
    // CF-14 — roll back whatever this attempt actually created, in reverse
    // order, so a half-drawn board or a session with no summary never
    // becomes this new user's first impression. Leaving `sampleSeededAt`
    // unset lets a future call retry from a clean slate.
    if (sessionId) await safeDeleteSession(sessionId);
    if (boardId) await safeDeleteBoard(boardId);
  }
}
