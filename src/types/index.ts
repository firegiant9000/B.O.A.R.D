import { Bounds } from "../lib/viewport";

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  createdAt: Date;
  pushToken?: string;
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
  title: string;
  ownerId: string;
  adminId: string;
  collaboratorIds: string[];
  inviteCode: string;
  members: string[];
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
