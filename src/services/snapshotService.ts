import {
  collection,
  addDoc,
  getDocs,
  doc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { DrawPath, BoardSnapshot, SnapshotPath } from "../types";
import { getBoardPaths } from "./pathService";

// Phase 7 checkpoint cadence: compact once this many strokes have accumulated
// since the last snapshot. Per ROADMAP Appendix A.5 ("every 500 writes").
export const SNAPSHOT_INTERVAL = 500;

/**
 * True once `totalPaths` has grown a full interval past the count captured by the
 * last snapshot. Pure so the board screen's trigger is unit-testable.
 */
export function shouldSnapshot(totalPaths: number, lastSnapshotCount: number): boolean {
  return totalPaths - lastSnapshotCount >= SNAPSHOT_INTERVAL;
}

function serializePath(p: DrawPath): SnapshotPath {
  return {
    id: p.id,
    userId: p.userId,
    points: p.points,
    color: p.color,
    strokeWidth: p.strokeWidth,
    tool: p.tool,
    // bbox is persisted on every modern write and recomputed on read for legacy
    // docs, so an in-memory path always has one — but stay defensive.
    ...(p.bbox ? { bbox: p.bbox } : {}),
    createdAtMs: p.createdAt.getTime(),
  };
}

/**
 * Freeze the given paths into a new `snapshots/{auto}` doc. Caller passes the full
 * in-memory path set (already block-filtered or not — snapshots are unfiltered raw
 * state). Returns the new snapshot id.
 *
 * Note: a snapshot is a single Firestore doc (1 MiB hard limit). At the default
 * 500-stroke interval RDP-simplified strokes sit well under that; chunked/Storage
 * snapshots for very dense boards are an M5 concern.
 */
export async function createSnapshot(
  boardId: string,
  paths: DrawPath[]
): Promise<string> {
  const serialized = paths.map(serializePath);
  const watermarkMs = serialized.reduce((m, p) => Math.max(m, p.createdAtMs), 0);
  const ref = collection(db, "boards", boardId, "snapshots");
  const docRef = await addDoc(ref, {
    paths: serialized,
    pathCount: serialized.length,
    watermarkMs,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

/** Most recent snapshot for a board, or null if none exists yet. */
export async function getLatestSnapshot(
  boardId: string
): Promise<BoardSnapshot | null> {
  const ref = collection(db, "boards", boardId, "snapshots");
  const q = query(ref, orderBy("createdAt", "desc"), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  const data = d.data();
  return {
    id: d.id,
    boardId,
    paths: (data.paths ?? []) as SnapshotPath[],
    pathCount: data.pathCount ?? (data.paths?.length ?? 0),
    watermarkMs: data.watermarkMs ?? 0,
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

function snapshotPathToDrawPath(boardId: string, p: SnapshotPath): DrawPath {
  return {
    id: p.id,
    boardId,
    userId: p.userId,
    points: p.points,
    color: p.color,
    strokeWidth: p.strokeWidth,
    tool: p.tool,
    bbox: p.bbox,
    createdAt: new Date(p.createdAtMs),
  };
}

/**
 * Cold-load a board's paths via the snapshot fast path: the latest snapshot plus
 * only the strokes created after its watermark, deduped by id (snapshot first,
 * delta wins). Falls back to a full `getBoardPaths` replay when no snapshot exists.
 *
 * This is a read accelerator for first paint — the realtime listener on the full
 * `paths` collection stays the authoritative live source (so deletions of older,
 * snapshotted strokes still propagate). Watermark-scoped live listening + pruning
 * needs deletion tombstones and is deferred to M5.
 */
export async function loadBoardState(boardId: string): Promise<DrawPath[]> {
  const snapshot = await getLatestSnapshot(boardId);
  if (!snapshot) return getBoardPaths(boardId);

  const byId = new Map<string, DrawPath>();
  for (const p of snapshot.paths) {
    byId.set(p.id, snapshotPathToDrawPath(boardId, p));
  }

  // Delta: strokes drawn after the snapshot's high-water mark.
  const pathsRef = collection(db, "boards", boardId, "paths");
  const q = query(
    pathsRef,
    where("createdAt", ">", new Date(snapshot.watermarkMs)),
    orderBy("createdAt", "asc")
  );
  const deltaSnap = await getDocs(q);
  deltaSnap.docs.forEach((d) => {
    const data = d.data();
    if (!data.points || !data.color || !data.tool) return;
    byId.set(d.id, {
      id: d.id,
      boardId: data.boardId ?? boardId,
      userId: data.userId ?? "",
      points: data.points,
      color: data.color,
      strokeWidth: data.strokeWidth ?? 5,
      tool: data.tool,
      bbox: data.bbox ?? undefined,
      createdAt: data.createdAt?.toDate() ?? new Date(),
    });
  });

  return [...byId.values()].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );
}

/**
 * Delete the given path docs (those folded into a snapshot) in 500-doc batches.
 *
 * NOT wired into the live load path in M1: with the realtime listener scoped to the
 * full `paths` collection, pruned strokes would simply vanish for connected peers,
 * and a watermark-scoped listener can't observe deletions of already-pruned strokes.
 * True compaction lands with the M5 tombstone/version-history work; this is provided
 * and tested so that wiring is a one-liner then.
 */
export async function pruneSnapshottedPaths(
  boardId: string,
  pathIds: string[]
): Promise<void> {
  for (let i = 0; i < pathIds.length; i += 500) {
    const batch = writeBatch(db);
    pathIds
      .slice(i, i + 500)
      .forEach((pid) => batch.delete(doc(db, "boards", boardId, "paths", pid)));
    await batch.commit();
  }
}
