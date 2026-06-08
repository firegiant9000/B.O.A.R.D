import { Bounds } from "../lib/viewport";

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  createdAt: Date;
  pushToken?: string;
}

export interface Board {
  id: string;
  title: string;
  ownerId: string;
  adminId: string;
  collaboratorIds: string[];
  inviteCode: string;
  members: string[];
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
  createdAt: Date;
}
