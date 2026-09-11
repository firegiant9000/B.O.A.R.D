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
 * 1. QUOTA — this seeds the example board and the finished session through
 *    the SAME capped, Cloud-Function-enforced paths every other create goes
 *    through (`boardService.createBoard`, `sessionService.createSession`),
 *    not a server-side bypass. That means a brand-new free-tier user starts
 *    at 1/5 boards and 1/3 sessions before doing anything themselves. Accepted
 *    deliberately: the alternative is inventing a "this doesn't count toward
 *    the cap" exemption in functions/src/billing/usage.ts, which (a) touches
 *    the anti-drift-tested quota-enforcement surface for a seeding feature,
 *    and (b) creates a bypass shape (documents that are real but uncounted)
 *    that is exactly the kind of asymmetry the "deny unless provably under"
 *    discipline elsewhere in this codebase exists to avoid. A free user still
 *    has 4 boards and 2 sessions left for their own work, and both seeded
 *    items are ordinary, deletable documents — deleting the sample board
 *    frees its slot back up immediately, since the cap counts live documents.
 *
 * 2. WHERE THIS RUNS — client-side, calling the real callables, subject to
 *    the real caps. A server-side seed (an Auth `onCreate` trigger writing
 *    with the Admin SDK) would bypass firestore.rules, but would NOT bypass
 *    the board/session caps either (they're just document counts scoped by
 *    workspaceId — an Admin SDK write still counts), so it buys no quota
 *    relief, only a second, rules-bypassing creation path to keep in sync
 *    with the real one. Not worth it for a seed.
 *
 * 3. NO AI CALL — the "AI summary" on the seeded session is the canned
 *    `SAMPLE_SESSION_SUMMARY` below, written directly via
 *    `sessionService.updateSessionSummary`. Nothing here calls
 *    `generateSummary` or any other AI callable. The copy is written to read
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
    boardId = await boardService.createBoard(template.title, uid, workspaceId, "free", 0);
    await templateService.applyTemplateToBoard(boardId, uid, template);
    await pathService.saveTextNote(boardId, {
      boardId,
      userId: uid,
      content: SAMPLE_ROSTER_NOTE_CONTENT,
      position: ROSTER_NOTE_POSITION,
    });

    // Session phase: create (capped), then transition straight to "ended"
    // with a canned summary — never a real generateSummary call.
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
      { plan: "free", currentCount: 0 }
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
