import type { Session, SessionSummary } from "../types";
import { track } from "./analyticsService";

// Month 6 — the session half of ROADMAP.md:685's funnel: `session_completed`
// (three end-a-session surfaces) and `ai_summary_generated` (two generate-a-
// summary surfaces).
//
// WHY THIS FILE EXISTS AT ALL, given five one-line `track()` calls would also
// work. Not to save four lines — to make one decision once. Every property
// below is derived from a `Session`, and a `Session` carries `title`,
// `boardTitle`, `description`, `agenda`, `createdByName` and a `participants`
// snapshot of real names and email addresses. Five hand-written property bags
// are five independent chances for someone to reach for the obvious-looking
// `title: session.title` while adding context to one screen's event — and
// analyticsService's scrub would not stop them: it strips email-SHAPED values,
// so it catches `participants[].email` but passes a board title verbatim, and
// a board title is free text a user typed. Routing every session event through
// one function makes "what a session is allowed to report" a single reviewable
// list instead of a convention five files have to remember.
//
// WHAT THIS FILE IS NOT. It is not, and must never become, a hook inside
// `sessionService`. `onboardingService.seedSampleWorkspace` calls
// `sessionService.createSession`/`endSession`/`updateSessionSummary` directly
// to build every new account's demo session, so an emit reached from those
// primitives would report a completed session and an AI summary for every
// signup — for a session the user never ran and a summary no model ever
// generated (the seed's summary is canned: `SAMPLE_SESSION_SUMMARY`). These
// functions take a session the CALLER has already finished acting on, and are
// called only from the user-facing handlers. `sessionService.ts` importing
// this module is a test failure, not a code-review note — see
// src/services/__tests__/analyticsBoundary.test.ts.

/**
 * Which surface the user acted from. Three screens can end a session and two
 * can generate a summary; the same event from a different surface is worth
 * telling apart when deciding which of them to invest in, and these are
 * developer-authored constants rather than route strings so a future route
 * rename can never turn this into a leak of anything user-authored.
 */
export type SessionSurface = "board" | "schedule" | "session-detail";

/** `summary` as it can appear on disk. Sessions summarized before Month 4's
 *  Phase 3 carry a plain string (see the `Session.summary` comment in
 *  src/types) — counted as "no structure available" rather than crashing a
 *  property getter on `.actionItems`. */
function summaryCounts(summary: SessionSummary | string | undefined) {
  if (!summary || typeof summary === "string") {
    return { actionItemCount: 0, decisionCount: 0, openQuestionCount: 0 };
  }
  return {
    actionItemCount: summary.actionItems.length,
    decisionCount: summary.decisions.length,
    openQuestionCount: summary.openQuestions.length,
  };
}

/**
 * Reports that a user ended a session from `surface`.
 *
 * `snapshotCaptured` is whether a canvas image was captured as part of THIS
 * end action — true only on the board screen, which is the one surface holding
 * the canvas ref. It is passed in rather than read off the session because at
 * the moment this is called the caller's local `Session` object predates the
 * write that stores the snapshot.
 *
 * Never throws (see `track()`): callers are on the user's critical path, in
 * the middle of a lifecycle write they care about far more than this.
 */
export function trackSessionCompleted(
  session: Session,
  surface: SessionSurface,
  snapshotCaptured: boolean
): void {
  track("session_completed", {
    surface,
    snapshotCaptured,
    // `participantIds` excludes the creator (the schedule/recap screens add 1
    // when they pass a count to the AI), so this is invitees, not attendees.
    // Named for what it counts rather than the friendlier "attendees", which
    // would be a claim this number does not support.
    participantCount: session.participantIds.length,
    // The PLANNED length, not the elapsed one. Elapsed would need
    // `endedAt - startedAt`, and `startedAt` is absent on every session
    // created before Month 4's Phase 4 — so it would silently mean two
    // different things depending on the session's age.
    plannedDurationMinutes: session.durationMinutes,
    hadAgenda: !!session.agenda,
  });
}

/**
 * Reports that an AI session summary was generated and stored from `surface`.
 *
 * Called after the write, not after the model call: a summary the user never
 * got is not one that was generated as far as this funnel is concerned.
 *
 * The counts below are the only thing this says about the summary's content.
 * Its text — `tldr`, and every action item, decision and open question — is
 * model output derived from a board a user drew and typed on, so it is user
 * content by another route and never leaves the device through this seam.
 */
export function trackAiSummaryGenerated(
  session: Session,
  summary: SessionSummary,
  surface: SessionSurface
): void {
  track("ai_summary_generated", {
    surface,
    // Whether the model was given the canvas image or only the text context —
    // the single biggest input difference between one generated summary and
    // another, and the one that explains an empty result.
    hadSnapshot: !!session.canvasSnapshot,
    participantCount: session.participantIds.length,
    plannedDurationMinutes: session.durationMinutes,
    ...summaryCounts(summary),
  });
}
