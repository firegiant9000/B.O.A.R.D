import { Bounds } from "../lib/viewport";
import { LaserPing } from "../lib/laser";

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  createdAt: Date;
  pushToken?: string;
  // Phase 10 (roadmap item 9). Per-user notification preferences, stored on the
  // user doc. Optional / migration-tolerant: absent ⇒ DEFAULT_NOTIFICATION_PREF
  // (push on mention, daily email digest opted-in). See notificationService.
  notificationPref?: NotificationPref;
  // Month 4 Phase 9 (roadmap item 8). How auto-perfect treats a freehand stroke
  // the geometry classifier recognizes as a clean primitive. Optional /
  // migration-tolerant: absent ⇒ DEFAULT_SHAPE_RECOGNITION_MODE ("ask"). See
  // shapeRecognitionService.
  shapeRecognitionPref?: ShapeRecognitionMode;
}

// Month 4 Phase 9. Per-user auto-perfect behavior: "always" silently swaps the
// stroke for the clean primitive, "ask" offers a discreet "perfect it?" prompt,
// "never" disables recognition (no geometry runs on stroke end).
export type ShapeRecognitionMode = "always" | "ask" | "never";

// Phase 10 (roadmap item 9). Notification preferences. `pushOnMention` gates the
// Expo push fired when someone @-mentions the user in a comment; `emailDigest` is
// the opt-in for a daily mention digest. The digest has no delivery backend this
// month — the flag + a documented no-op seam exist now (mirroring quotaService),
// so a later milestone can turn it on without re-plumbing the preference UI.
export interface NotificationPref {
  pushOnMention: boolean;
  emailDigest: boolean;
}

// Phase 1 (roadmap item 1). Multi-tenancy primitive. A workspace is the isolation
// boundary that boards/sessions hang under from Phase 2 onward. `plan` is carried
// now so the Phase 5 quota choke point has a field to read (no enforcement yet).
export type Plan = "free" | "pro" | "edu";

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

// Phase 6 (roadmap item 6). Per-board collaboration role, layered on top of the
// workspace-role floor. `editor` writes canvas content; `commenter` may comment
// (Phase 7) but not edit; `viewer` is read-only. A board's `roles` map holds only
// explicit overrides — an absent uid inherits its role from workspace membership
// (see boardService.effectiveBoardRole). Migration-tolerant: legacy boards with no
// `roles` map (or no `workspaceId`) treat every member as an editor.
export type BoardRole = "editor" | "commenter" | "viewer";

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  // Authoritative role map, keyed by uid. Firestore can't `array-contains` over a
  // map's keys, so the service also denormalizes a parallel `memberIds: string[]`
  // on the doc for membership queries — it is not surfaced on this type.
  members: Record<string, WorkspaceRole>;
  plan: Plan;
  // Month 5 (ROADMAP items 12 + 14 — colour + stroke polish / Pro-affordance
  // badges). Custom hex colours ("#rrggbb") the workspace has saved from the
  // picker's swatch row, shared by every member. Optional / migration-
  // tolerant: absent ⇒ [] (no board predates this, but every other workspace
  // field here treats absence as the pre-feature default, so this follows
  // suit) — see `workspaceService.ts#addWorkspaceSwatch`.
  //
  // TWO separate gates apply, and they are not the same rule:
  //  - PLAN is advisory only (`workspaceService.ts#canUseCustomPalette`) —
  //    nothing server-side reads `plan` before allowing this array to change.
  //  - ROLE *is* enforced: firestore.rules' `workspaces/{id}` update rule
  //    restricts every field but `name` (this one included) to workspace
  //    owner/admin members, regardless of plan — a real, server-side gate,
  //    which is exactly why `ColorPickerModal`'s `canManageWorkspace` prop
  //    exists alongside the plan check, not in place of it.
  swatches?: string[];
  createdAt: Date;
}

// Phase 12 (roadmap item 11). Per-board background template, rendered as a
// non-interactive SVG layer behind every element (Appendix A.4 step 6). Optional
// / migration-tolerant: absent ⇒ "blank" (the pre-Phase-12 behavior).
export type BackgroundTemplate =
  | "blank"
  | "grid"
  | "dots"
  | "lined"
  | "isometric"
  | "coordinate";

export interface Board {
  id: string;
  // Phase 2 (multi-tenancy). The workspace this board belongs to — the root of
  // board access (rules resolve membership through it). Migration-tolerant:
  // legacy boards created before Phase 2 lack the field on disk and map to "";
  // readers and rules treat "" / missing as "unscoped" during the migration
  // window (Phase 9 backfills it, then the legacy fallback is removed).
  workspaceId: string;
  title: string;
  ownerId: string;
  adminId: string;
  collaboratorIds: string[];
  inviteCode: string;
  members: string[];
  // Phase 6 (multi-tenancy). Explicit per-board role overrides, keyed by uid. Only
  // members whose effective role differs from their workspace-role default appear
  // here; an absent member inherits from workspace membership. Optional /
  // migration-tolerant: absent ⇒ no overrides (every member is an editor).
  roles?: Record<string, BoardRole>;
  backgroundTemplate?: BackgroundTemplate;
  // Month 6 — education pilot (ROADMAP.md Appendix E.2 "Cohort views"). Links
  // this board to a `classes/{classId}` doc as a student's assignment
  // submission. Optional/migration-tolerant: absent ⇒ not part of any class
  // (every pre-existing board). PINNED once set — firestore.rules'
  // `classIdTransitionValid` refuses any later change or removal, the same
  // way `workspaceIdUnchanged` pins `workspaceId` above, so a student can't
  // detach their own board from instructor oversight after submitting it.
  // Set only via classroomService.attachBoardToClass, which rules gate on
  // the caller being an ENROLLED STUDENT of that class at write time.
  classId?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Month 6 — education pilot (invite-based class enrollment). A class is its
// own top-level `classes/{classId}` collection, deliberately NOT an
// overloaded workspace — see firestore.rules' `classes` match block for the
// full argument (a class carries none of a workspace's plan/billing/seat-cap
// semantics, and the edu tier is sold manually with no self-serve).
//
// University-level only; K-12 is explicitly out of scope (COPPA's
// verifiable-parental-consent requirement for under-13 users, which nothing
// here attempts to satisfy). `studentIds` holds only uids of students who
// redeemed `joinCode` with their OWN account — no name, email, date of
// birth, or minor-status field is ever collected, and there is no bulk/CSV
// roster-import path. Do NOT add one; see ROADMAP.md's Education-pilot
// section ("A5") for why that path was deliberately reshaped away from.
export interface ClassRoom {
  id: string;
  name: string;
  instructorId: string;
  // Server-generated only (functions/src/callable/createClass.ts, reusing
  // createBoard.ts's generateInviteCode) — a client can never choose or
  // change this value; a guessable code lets a stranger self-enroll and
  // hand their board to a class's instructor uninvited.
  joinCode: string;
  studentIds: string[];
  schemaVersion: 1;
  createdAt: Date;
}

export interface DrawPath {
  id: string;
  boardId: string;
  userId: string;
  points: { x: number; y: number }[];
  // Plain opaque `#RRGGBB` — never an 8-digit hex embedding alpha. See
  // `opacity` below for why alpha is a separate field rather than encoded
  // into this string (src/lib/color.ts's own header explains the split).
  color: string;
  strokeWidth: number;
  tool: "pen" | "eraser";
  // Board-space axis-aligned bounding box (stroke-width inflated), persisted at
  // write time for viewport culling (Phase 4). Optional so legacy docs and the
  // read-path fallback (compute-from-points) stay valid.
  bbox?: Bounds;
  // Z-order within the paths layer (Phase 8). Optional/migration-tolerant: docs
  // predating it read as 0 and tiebreak on createdAt, preserving draw order.
  z?: number;
  // Month 5 (ROADMAP item 12 — colour + stroke polish). Which pen variant
  // drew this stroke; a rendering hint layered on top of `tool: "pen"` and
  // never set for `tool: "eraser"`. Optional / migration-tolerant: absent ⇒
  // "pen" (the pre-existing look) — see `src/lib/penStyles.ts`.
  penStyle?: "pen" | "highlighter" | "marker" | "calligraphy";
  // Stroke alpha (0-1), independent of `color`. Optional / migration-
  // tolerant: absent ⇒ the active pen style's own default (1 for pen/marker/
  // calligraphy, translucent for the highlighter — see
  // `src/lib/penStyles.ts#DEFAULT_ALPHA_FOR_STYLE`), never a hard 1, so an
  // old highlighter stroke saved before this field existed still renders
  // translucent instead of silently turning opaque.
  opacity?: number;
  createdAt: Date;
}

// A single stroke as frozen into a snapshot. Mirrors DrawPath minus the implicit
// boardId, with createdAt stored as an epoch-ms number so the snapshot doc holds no
// Firestore Timestamps inside its `paths` array (arrays of Timestamps don't round-trip
// cleanly and the watermark math wants a plain number).
export interface SnapshotPath {
  id: string;
  userId: string;
  points: { x: number; y: number }[];
  color: string;
  strokeWidth: number;
  tool: "pen" | "eraser";
  bbox?: Bounds;
  // Mirrors DrawPath.penStyle/opacity (Month 5, ROADMAP item 12) — carried
  // through a checkpoint so a highlighter/marker/calligraphy stroke doesn't
  // revert to plain pen rendering once its board compacts into a snapshot.
  penStyle?: "pen" | "highlighter" | "marker" | "calligraphy";
  opacity?: number;
  createdAtMs: number;
}

// A compacted checkpoint of a board's paths (Phase 7). The newest `pathCount` strokes
// are collapsed into one doc so a cold load reads the snapshot + only the strokes drawn
// since `watermarkMs`, instead of replaying every path doc. Also the substrate for the
// M5 version-history feature.
export interface BoardSnapshot {
  id: string;
  boardId: string;
  paths: SnapshotPath[];
  pathCount: number;
  // Max createdAt (epoch ms) across the included strokes — the high-water mark a cold
  // load queries past to fetch only newer strokes.
  watermarkMs: number;
  createdAt: Date;
}

export interface FriendRequest {
  id: string;
  fromId: string;
  fromDisplayName: string;
  fromEmail: string;
  toId: string;
  toDisplayName: string;
  toEmail: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: Date;
}

export interface BoardPresence {
  userId: string;
  displayName: string;
  email: string;
  lastSeen: Date;
}

// Live cursor (Month 4, Phase 6). An ephemeral pointer broadcast on the
// boards/{id}/cursors/{uid} side channel — never persisted alongside canvas
// content, so cursor churn stays off the element-tree listeners (Appendix A.4).
export interface CursorPresence {
  userId: string;
  displayName: string;
  // Board-space pointer position.
  x: number;
  y: number;
  // Active tool, for the per-cursor icon.
  tool: string;
  // Client epoch ms of the last update — drives staleness filtering on read
  // (Firestore has no RTDB-style onDisconnect to clear an abandoned cursor).
  updatedAt: number;
  // Phase 7 (follow mode). The author's current viewport, broadcast on the same
  // side channel so a follower's camera can mirror their pan/zoom. Absent until
  // the author moves a pan/zoom-capable client.
  viewport?: { x: number; y: number; scale: number };
  // The userId this author is currently following, or null. Broadcast so peers
  // can break a follow cycle (A follows B while B follows A).
  following?: string | null;
  // Month 5/6 (presenter mode). True while this author is presenting
  // to the whole board — an active presenter overrides every other viewer's
  // individual follow choice (src/lib/presenter.ts#resolveViewportSource).
  // Optional / migration-tolerant: a client that predates presenter mode never
  // writes this field, and the subscriber maps its absence to `false`.
  presenting?: boolean;
  // True while the presenter above has paused. A pause releases the
  // audience's viewport back to their own control (or their individual follow
  // choice) but deliberately does NOT clear `presenting` — the audience
  // banner stays up through a pause. Meaningless when `presenting` is
  // false/absent. Same migration-tolerance as `presenting`.
  presenterPaused?: boolean;
  // Month 5 (laser pointer). This author's most recently sampled point while
  // using the laser tool. The cursor doc holds at most one — `setDoc`
  // replaces it whole on every write (see `cursorService.ts#writerFor`) — so
  // `src/components/CursorLayer.tsx` accumulates a fading multi-point trail
  // reader-side from a stream of these (`src/lib/laser.ts#appendPing`) rather
  // than expecting an array here. Absent whenever the author isn't
  // laser-pointing, or the doc predates the laser (migration-tolerant like
  // every field above).
  ping?: LaserPing;
}

export interface Session {
  id: string;
  // Phase 4 (multi-tenancy). The workspace this session belongs to, inherited from
  // its board at create time. Migration-tolerant, mirroring Board.workspaceId:
  // legacy sessions created before Phase 4 lack the field on disk and map to "";
  // readers and rules treat "" / missing as "unscoped" during the migration window
  // (Phase 9 backfills it from the parent board, then the legacy fallback is removed).
  workspaceId: string;
  boardId: string;
  boardTitle: string;
  title: string;
  description: string;
  scheduledAt: Date;
  durationMinutes: number;
  createdById: string;
  createdByName: string;
  participantIds: string[];
  status: "scheduled" | "active" | "ended";
  joinCode?: string;
  // Phase 3 (Month 4): the AI summary is a structured artifact. Sessions
  // summarized before Phase 3 carry a plain string on disk, so readers must
  // tolerate both forms (schema-version tolerance — no destructive migration).
  summary?: string | SessionSummary;
  canvasSnapshot?: string;
  // Phase 4 (Month 4) session lifecycle. All optional / migration-tolerant — a
  // session created before this phase simply lacks them on disk:
  //  - `agenda`: free-text plan editable in the lobby (pre-session).
  //  - `startedAt`: stamped when the session transitions scheduled → active
  //    (also at create time for sessions started directly). Anchors the
  //    in-session elapsed timer; readers fall back to `scheduledAt` when absent.
  //  - `endedAt`: stamped at active → ended. With `startedAt` it yields the
  //    real elapsed duration on the recap; absent ⇒ fall back to durationMinutes.
  //  - `participants`: a frozen name/email snapshot of who was in the session,
  //    captured at end so the recap renders without a live user lookup and is
  //    stable even if profiles later change. Includes the creator.
  agenda?: string;
  startedAt?: Date;
  endedAt?: Date;
  participants?: ParticipantSnapshot[];
  createdAt: Date;
}

/** Phase 4: a frozen, denormalized record of one session participant, captured at
 *  end time so the recap doesn't depend on a live profile read (and stays correct
 *  if the user later renames). */
export interface ParticipantSnapshot {
  uid: string;
  displayName: string;
  email: string;
}

/** Structured AI session summary (Appendix B.2). Mirrors the Cloud Function
 *  shape in `functions/src/ai/summaryPrompt.ts`. */
export interface SessionSummary {
  tldr: string;
  actionItems: string[];
  decisions: string[];
  openQuestions: string[];
}

export interface TextNote {
  id: string;
  boardId: string;
  userId: string;
  content: string;
  position: { x: number; y: number };
  createdAt: Date;
}

export interface TextElement {
  id: string;
  boardId: string;
  userId: string;
  text: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  fontSize: number;
  color: string;
  // Z-order within the textElements layer (Phase 8); see DrawPath.z.
  z?: number;
  // Rotation in degrees about the box center (Phase 8 group rotate). Optional /
  // migration-tolerant: absent ⇒ 0 (axis-aligned, the pre-Phase-8 behavior).
  rotation?: number;
  createdAt: Date;
}

// Phase 7 (roadmap item 7, Appendix A.2). Vector shape primitives. rect/ellipse/
// triangle store an axis-aligned box at (x,y) with positive width/height; line/arrow
// store the vector from the start point (x,y) to the end point (x+width, y+height),
// so width/height may be negative. `bbox` is persisted at write time for culling/
// hit-testing parity with paths; `rotation` (degrees) is reserved for the Phase 8
// transform work and defaults to 0.
export type ShapeKind = "rect" | "ellipse" | "line" | "arrow" | "triangle";
export type ArrowheadStyle = "none" | "classic" | "dot" | "circle" | "open";

export interface ShapeElement {
  id: string;
  boardId: string;
  userId: string;
  shape: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fill: string; // CSS color or "none"
  stroke: string;
  strokeWidth: number;
  dashed: boolean;
  arrowheadStart: ArrowheadStyle;
  arrowheadEnd: ArrowheadStyle;
  bbox?: Bounds;
  // Z-order within the shapes layer (Phase 8); see DrawPath.z.
  z?: number;
  createdAt: Date;
}

// Phase 7 (Month 3, roadmap item 7). Comments + threads anchored to a canvas
// element. A comment lives in `boards/{id}/comments/{commentId}` and pins to any
// element kind (stroke/shape/text/sticky/image — all carry an `id`). The pin
// follows its element: `offsetX`/`offsetY` are the board-space offset of the pin
// from the anchored element's bbox top-left at create time, so a moved/resized
// element drags its pin along. `anchorKind` records which collection the anchor
// lives in (a render hint; resolution falls back to scanning every kind). When
// the anchored element is deleted the comment is "detached" — still readable in
// the thread list, just no longer drawn on the canvas.
export type CommentAnchorKind = "path" | "shape" | "text" | "note" | "image";

// A reply inside a comment thread. Stored as an element of the parent comment's
// `replies` array, so — like SnapshotPath — its timestamp is an epoch-ms number,
// not a Firestore Timestamp (Timestamps don't round-trip cleanly inside arrays,
// and serverTimestamp() is rejected inside array elements).
export interface CommentReply {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  // Phase 10. uids of workspace members @-mentioned in this reply, parsed from the
  // body's structured `@[Name](uid)` tokens at write time (see src/lib/mentions).
  // Denormalized so notification fan-out reads it without re-parsing. Optional /
  // migration-tolerant: absent ⇒ no mentions (pre-Phase-10 replies).
  mentions?: string[];
  createdAtMs: number;
}

export interface Comment {
  id: string;
  boardId: string;
  anchorElementId: string;
  anchorKind: CommentAnchorKind;
  offsetX: number;
  offsetY: number;
  authorId: string;
  authorName: string;
  body: string;
  // Phase 10. uids @-mentioned in the root comment body (see CommentReply.mentions).
  mentions?: string[];
  replies: CommentReply[];
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Month 6 — reactions. Reuses Comment's anchoring exactly (`anchorElementId` +
// `anchorKind` above) rather than inventing a second anchoring scheme: a
// reaction pins to any canvas element the same way a comment does.
//
// Unlike Comment, `anchorKind` here is OPTIONAL, and readers/writers must NOT
// coerce a missing/invalid value to some default kind the way this file's
// comment-reading code does (`readAnchorKind` in commentService.ts defaults to
// "shape"). `boxOfElement` (useBoardElements.ts) only scans the ONE collection
// a hint names — passing a hint that happens to be wrong hides the element's
// box forever, which is worse than passing no hint at all (which scans every
// kind). A reaction started from a tap always knows its kind, same as a
// comment; one started from the current canvas *selection* does not (the
// selection model tracks ids only), so it is written with no kind rather than
// a guessed one.
//
// Storage: `boards/{id}/reactions/{elementId}_{emoji}_{userId}` — the document
// id is the uniqueness constraint (one user cannot double-react with the same
// emoji on the same element: a second toggle addresses the same doc rather
// than adding a row). Role authorization is the `userId` FIELD below, not the
// id — but firestore.rules' `reactions` match still binds the id to the
// fields by exact-match concatenation (id == anchorElementId + '_' + emoji +
// '_' + userId, never by splitting the id apart), so a real commenter can't
// launder unbounded extra reactions through ids the field check alone
// wouldn't catch. See reactionService.ts's header and that match for the
// full reasoning.
export const REACTION_EMOJIS = ["👍", "❤️", "❓", "⭐", "💡"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export interface Reaction {
  id: string;
  schemaVersion: 1;
  boardId: string;
  anchorElementId: string;
  anchorKind?: CommentAnchorKind;
  emoji: ReactionEmoji;
  userId: string;
  createdAt: Date;
}

// Month 6 — polls. Unlike Reaction (which only ever anchors to something that
// already exists on the canvas), a poll is genuinely NEW canvas content: it
// carries its own board-space (x, y) the way a shape or sticky note does.
// Lives at `boards/{id}/polls/{pollId}`, member-readable, editor-writable —
// the same read/write boundary as paths/shapes/textElements (see
// firestore.rules), not comments/reactions' commenter-write boundary.
//
// Votes live in a SEPARATE subcollection, `boards/{id}/polls/{pollId}/votes/
// {uid}` — **the document id is the voter's uid**, in EVERY mode, including
// "dots". This is what enforces one vote DOC per user: a member who changes
// their vote (or adds/removes a dot) overwrites their own doc — a Firestore
// `update`, not a second row — which is why firestore.rules' `votes` match
// allows `update` for the voter's own doc, unlike reactions (react/un-react
// is create/delete only; there is no "change your reaction" concept).
// Voting itself needs only commenter+ (mirrors reactions/comments), a lower
// bar than the editor-only bar for creating the poll's canvas position.
//
// `anonymous: true` hides voter identity from other MEMBERS — never from the
// system. The uid is still every vote doc's id (it must be, to dedupe); it
// is simply kept out of every client-readable path. firestore.rules denies
// `read` on an anonymous poll's `votes` subcollection outright, to EVERY
// member (including the board admin and the voter reading their own doc
// back) — even a listing reveals who voted, without revealing any one
// choice, so there is no safe partial exception. One consequence: Firestore's
// `count()` aggregation also requires read permission on the collection it
// counts, so an anonymous poll cannot compute or display its own results
// client-side AT ALL. See `PollTally` below for how anonymous polls show a
// result anyway, and `functions/src/triggers/pollTally.ts` for the header on
// why that path is eventually consistent.
//
// `mode`: "single" is the classic one-vote-counts poll (`optionIndices`
// always length 1); "dots" is dot-voting, where a member may spread their
// vote across MULTIPLE options at once, up to `pollService.MAX_DOT_VOTES`
// (still ONE vote doc — `optionIndices` just holds more than one index).
//
// `quizId`/`quizIndex`/`active` sequence a set of polls sharing one `quizId`
// into an ordered quiz: `active` is true on at most one poll per quizId at a
// time, and `pollService.advanceQuiz` moves it forward by `quizIndex` order.
// A standalone (non-quiz) poll carries none of the three.
export type PollMode = "single" | "dots";

// Kept here (not in pollService.ts) so a pure-presentation component like
// PollComposer can import just these two numbers without pulling in
// pollService's own `firebase/firestore` import chain — mirrors
// REACTION_EMOJIS living here rather than in reactionService.ts, for the
// same reason. pollService.ts re-exports both for its own callers.
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 6;

export interface PollElement {
  id: string;
  schemaVersion: 1;
  boardId: string;
  question: string;
  /** Option labels, 2–6 — enforced by pollService.createPoll and
   *  firestore.rules on create. A vote references one of these by INDEX
   *  (PollVote.optionIndices), never by re-typing the label. */
  options: string[];
  anonymous: boolean;
  mode: PollMode;
  x: number;
  y: number;
  createdById: string;
  /** Present only while this poll is one question of a quiz sequence;
   *  absent for a standalone poll. */
  quizId?: string;
  quizIndex?: number;
  /** True while this is the currently-shown question of its quiz. Absent/
   *  false for a standalone poll and for a quiz question not yet reached. */
  active?: boolean;
  createdAt: Date;
}

/** One member's vote. `id` (the doc id) IS `userId` — see PollElement's type
 *  comment for why, in every mode. `optionIndices` is length 1 in "single"
 *  mode; 1..MAX_DOT_VOTES in "dots" mode. Firestore rules bound the SIZE of
 *  this list per the poll's mode but — the rules language has no per-element
 *  loop/bounds construct for a dynamic-length options array — do not verify
 *  every index actually falls within the poll's own `options` range; a
 *  reader must tolerate (never throw on) an out-of-range index, exactly like
 *  every other tolerant-reader path in this file. That is a correctness gap
 *  at worst (an uncounted stray vote), never a privacy or vote-stuffing one:
 *  the doc id / `userId` field pinning is what actually enforces "one vote
 *  per user," and neither depends on `optionIndices` being valid. */
export interface PollVote {
  id: string;
  userId: string;
  optionIndices: number[];
  createdAt: Date;
}

/** Server-maintained tally for an ANONYMOUS poll, written by a Firestore
 *  trigger (functions/src/triggers/pollTally.ts) off the `votes`
 *  subcollection — never by a client; firestore.rules denies every client
 *  write to `polls/{pollId}/tally/{docId}`, mirroring the metering/billing
 *  collections' `allow write: if false`. `counts` keys are option INDICES
 *  as strings (Firestore map keys are always strings), so `counts["0"]` is
 *  option 0's vote count; an option with zero votes may be entirely absent
 *  from the map — a reader defaults a missing key to 0, never throws.
 *  `totalVotes` counts VOTERS (vote docs), not vote-doc-array entries, so it
 *  undercounts total dot placements on a "dots" poll by design (it answers
 *  "how many people voted", not "how many dots were placed").
 *
 *  EVENTUALLY CONSISTENT: the trigger runs in a separate invocation AFTER
 *  the triggering vote write commits — there is no way to make a voter's own
 *  vote land in this document atomically with their own write. A voter may
 *  briefly see their vote accepted before this tally reflects it. Never
 *  imply otherwise in UI copy (e.g. no "results update instantly" claim for
 *  an anonymous poll). Non-anonymous polls never read this at all: their
 *  `votes` subcollection is member-readable directly, and the client counts
 *  it live (pollService.subscribeToVotes) instead.
 *
 *  Deliberately carries NO timestamp field (fix round 1, item 10 — an
 *  earlier version had `updatedAt`, written via `serverTimestamp()`).
 *  Nothing ever read it, and on an anonymity feature a timing signal a
 *  member could correlate against presence ("the count moved while only
 *  Alice was here") is a needless side channel, not a useful one. */
export interface PollTally {
  counts: Record<string, number>;
  totalVotes: number;
}

// Phase 8 (Month 3, roadmap item 8). Append-only activity log. An event records a
// single mutation ("actor did verb to target") and lives in a workspace-scoped
// collection `workspaces/{wsId}/activity/{eventId}`. `boardId` is denormalized so
// the per-board history sidebar is a `where('boardId','==',…)` filter on the same
// collection (the workspace feed reads it unfiltered) — see activityService for the
// documented read pattern. `actorName` is denormalized like Comment.authorName so a
// feed renders without a user lookup per row. The log is the substrate for the M5
// board-version-history feature, so it is never edited or deleted after write.
export type ActivityVerb =
  | "board.created"
  | "comment.created"
  | "session.ended";

export type ActivityTargetType = "board" | "comment" | "session";

export interface ActivityEvent {
  id: string;
  actorId: string;
  actorName: string;
  verb: ActivityVerb;
  targetType: ActivityTargetType;
  targetId: string;
  workspaceId: string;
  // Present for board-scoped events (every verb today carries one); absent for any
  // future workspace-level event with no board. Denormalized for the per-board query.
  boardId?: string;
  // Verb-specific extras for rendering, e.g. { title } for board.created or
  // { participantCount } for session.ended. Kept loose so new verbs don't churn the type.
  meta: Record<string, any>;
  createdAt: Date;
}

// Phase 9 (roadmap item 12, Appendix A.2). A first-class image element. The
// original (downscaled to ≤ 2048px long edge) and a thumbnail live in Firebase
// Storage at `storagePath` / `thumbnailPath`; `url` / `thumbnailUrl` are the
// resolved download URLs persisted alongside them so the SVG renderer has a
// usable `href` without an async lookup per element (download URLs are bearer
// tokens, no broader than the Firestore read the member already has). Geometry
// mirrors a box shape: (x,y) top-left, positive width/height, `rotation` degrees
// about the box center, participating in the Phase 8 selection/transform system.
// `naturalWidth`/`naturalHeight` preserve the source aspect for re-fit math.
export interface ImageElement {
  id: string;
  boardId: string;
  userId: string;
  storagePath: string;
  thumbnailPath: string;
  url: string;
  thumbnailUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  naturalWidth: number;
  naturalHeight: number;
  alt: string;
  bbox?: Bounds;
  // Z-order within the images layer (Phase 8); see DrawPath.z.
  z?: number;
  createdAt: Date;
}

// Month 5 (ROADMAP.md:583-587, roadmap item 9). A voice note anchored to
// another canvas element — a stroke, sticky, text, or image. The audio bytes
// (AAC/.m4a, capped at 60s — see audioService.MAX_DURATION_MS) live in
// Firebase Storage at `storagePath`; `downloadUrl` is the resolved download
// URL persisted alongside it so playback has a usable source without an
// async lookup per element, mirroring ImageElement's url/thumbnailUrl split.
// `anchorElementId` names the element (of any kind, any collection) the note
// is attached to.
//
// `x`/`y` are the board-space position the speaker-icon affordance was
// placed at when the note was FIRST recorded — a write-time snapshot, not a
// live position. Fix round 1 found that rendering the badge from these
// directly leaves it behind when the anchor is moved/resized/rotated (no
// write path updates them, and none should — that would mean touching every
// element kind's commitMove/resize/rotate for a value only this badge
// needs). The canvas instead derives each note's on-screen position from the
// anchor's CURRENT bounds at render time (BoardCanvas + `boxOfElement`, kind-
// agnostic the same way `anchorElementId` is), so the badge tracks its
// element. These fields still round-trip through Firestore (harmless, and
// readable as "where this was recorded") but are not what positions the
// badge on a live board — do not reintroduce a render path that trusts them.
// `schemaVersion: 1` from inception — see the Global Constraint on new
// element types; readers tolerate a missing/partial doc (`data?.field ??
// default`), same as every other element kind here.
export interface AudioElement {
  id: string;
  schemaVersion: 1;
  boardId: string;
  userId: string;
  anchorElementId: string;
  storagePath: string;
  downloadUrl: string;
  durationMs: number;
  x: number;
  y: number;
  createdAt: Date;
}

// Phase 10 (roadmap item 9). In-app notification, stored per-recipient under
// `users/{recipientId}/notifications/{id}`. Created by the actor at mention time
// (the rules pin `actorId` to the writer and `recipientId` to the path owner,
// mirroring the friendRequests trust model). `boardId`/`commentId` let a tapped
// notification deep-link straight to the anchored thread; `snippet` is a short
// denormalized preview so the list renders without reading the comment.
export type NotificationType = "mention";

export interface AppNotification {
  id: string;
  recipientId: string;
  type: NotificationType;
  actorId: string;
  actorName: string;
  boardId: string;
  boardTitle: string;
  commentId: string;
  snippet: string;
  read: boolean;
  createdAt: Date;
}

// Embeddable boards (Month 4, Phase 8 — read-only; Month 5 — editable). The scope
// an embed token grants. 'view' is the anonymous read-only embed any board member
// can mint. 'edit' is the host-integration write scope: it requires a v2 token
// carrying a host-asserted subject, only a board admin can mint one, and the
// issuing host must be on the Functions-side allowlist. `createEmbedLink` below
// mints 'view' only — nothing in this client asks for 'edit' today.
export type EmbedScope = "view" | "edit";

// Month 5/6 — billing. The narrowed set of Stripe subscription statuses this
// client type surfaces. The document this mirrors (see `Subscription` below)
// is written by the Stripe webhook from the RAW Stripe status string, which
// carries more values than this ("trialing", "unpaid", "paused",
// "incomplete_expired", ...) — src/services/billingService.ts's
// `mapSubscriptionDoc` passes the stored value through as-is rather than
// validating it against this union, matching the tolerant-reader convention
// below. Treat any status this app doesn't explicitly branch on as "not
// entitled to Pro" (see `isEntitledToPro`), never the reverse.
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "incomplete";

/** Mirror of workspaces/{id}/billing/subscription, written only by the Stripe
 *  webhook (functions/src/http/stripeWebhook.ts); this client never writes
 *  it — firestore.rules denies every client write to `billing/{docId}` and
 *  permits read only to the workspace owner/admin. Readers tolerate missing
 *  fields (Global Constraints): the document is written by a Cloud Function
 *  across several Stripe event types and can legitimately be partial.
 *
 *  `currentPeriodEndMs: 0` is the "unknown renewal date" sentinel, not an
 *  error. The stored doc's underlying field is `number | null`, and it can
 *  legitimately be `null` for a full billing period — an applied event that
 *  doesn't itself carry a renewal date, with no earlier value to carry
 *  forward (see the `currentPeriodEndMs` carry-forward line in
 *  `applyStripeEvent`, functions/src/http/stripeWebhook.ts — a different
 *  mechanism from that file's out-of-order guard, which only decides
 *  whether an event applies at all). `0` is never a real Stripe renewal
 *  timestamp in this app's lifetime, so it is safe to use as the "unknown"
 *  marker rather than surfacing it as a failure. Consumers should check
 *  `hasKnownRenewalDate` (src/services/billingService.ts) before formatting
 *  this field — `new Date(0)` formats without error, so a naive "Renews on"
 *  row would render 1 January 1970 with no visible sign of the problem. */
export interface Subscription {
  schemaVersion: 1;
  status: SubscriptionStatus;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  currentPeriodEndMs: number;
}

// Month 6 — flashcard generation + review (task 30). Scheduling is PER-USER
// (`users/{uid}/decks/{deckId}/cards/{cardId}`), never board-scoped: two
// students studying the same board have different SM-2 schedules. See
// src/lib/sm2.ts for the scheduling algorithm and src/services/
// flashcardService.ts for the read/write surface over these two shapes.
export interface FlashcardDeck {
  id: string;
  schemaVersion: 1;
  name: string;
  /** The board this deck's cards were generated from, if any — informational
   *  only (e.g. "generated from Biology 101"); a deck is never re-scoped to a
   *  board the way a Board/Session is scoped to a workspace. */
  boardId?: string;
  createdAt: Date;
}

/** One card's content + its SM-2 schedule, flattened into a single document
 *  (rather than {content} + a nested `sm2.Card`) so a review write is one
 *  `updateDoc` of the four schedule fields, not a nested-object merge.
 *
 *  The four schedule fields mirror `sm2.Card` exactly — see that interface's
 *  own comment: `review()` does not validate them, so a caller that loads one
 *  of these from Firestore MUST validate all four are finite numbers before
 *  ever passing it to `review()`. `flashcardService.reviewCard` does this and
 *  fails closed (throws rather than scheduling from corrupt data) on a
 *  violation; see that function's own comment. */
export interface FlashcardCard {
  id: string;
  schemaVersion: 1;
  front: string;
  back: string;
  /** The board this card was generated from, if any. */
  boardId?: string;
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  dueAtMs: number;
}
