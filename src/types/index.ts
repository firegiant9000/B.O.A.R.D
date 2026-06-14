import { Bounds } from "../lib/viewport";

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
}

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
  createdAt: Date;
  updatedAt: Date;
}

export interface DrawPath {
  id: string;
  boardId: string;
  userId: string;
  points: { x: number; y: number }[];
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
  summary?: string;
  canvasSnapshot?: string;
  createdAt: Date;
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
