import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
  serverTimestamp,
  writeBatch,
  updateDoc,
  getDocs,
  onSnapshot,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { ArrowheadStyle, ShapeElement } from "../types";
import { shapeBbox } from "../lib/shapes";

// Mirrors the `textElements` subcollection pattern (pathService): one doc per
// shape, board-space coordinates, a write-time `bbox` for Phase 4 culling and
// tap-select, and an ordered real-time subscription. bbox is recomputed on read
// for any legacy/partial doc so the rest of the canvas can treat it as present.

const ARROWHEADS: ArrowheadStyle[] = ["none", "classic", "dot", "circle", "open"];

function readArrowhead(v: any): ArrowheadStyle {
  return ARROWHEADS.includes(v) ? v : "none";
}

function mapShapeDoc(id: string, data: any): ShapeElement | null {
  if (!data || !data.shape || data.x === undefined || data.y === undefined) return null;
  const shape: ShapeElement = {
    id,
    boardId: data.boardId ?? "",
    userId: data.userId ?? "",
    shape: data.shape,
    x: data.x,
    y: data.y,
    width: data.width ?? 0,
    height: data.height ?? 0,
    rotation: data.rotation ?? 0,
    fill: data.fill ?? "none",
    stroke: data.stroke ?? "#000000",
    strokeWidth: data.strokeWidth ?? 2,
    dashed: !!data.dashed,
    arrowheadStart: readArrowhead(data.arrowheadStart),
    arrowheadEnd: readArrowhead(data.arrowheadEnd),
    bbox: undefined,
    z: data.z,
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
  shape.bbox = data.bbox ?? shapeBbox(shape);
  return shape;
}

export async function saveShape(
  boardId: string,
  shape: Omit<ShapeElement, "id" | "createdAt" | "bbox">
): Promise<string> {
  const ref = collection(db, "boards", boardId, "shapes");
  const docRef = await addDoc(ref, {
    ...shape,
    bbox: shapeBbox(shape),
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function updateShape(
  boardId: string,
  shapeId: string,
  updates: Partial<Omit<ShapeElement, "id" | "boardId" | "userId" | "createdAt">>
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId, "shapes", shapeId), updates);
}

export async function deleteShape(boardId: string, shapeId: string): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId, "shapes", shapeId));
}

// --- Group operations (Phase 8) ---
// Many-at-once move / recolor / stroke-width / z-order, committed as 500-op
// writeBatches. The caller computes the field deltas (e.g. translated x/y + the
// recomputed bbox); the service just writes them, like updateShape.

type ShapeUpdate = Partial<Omit<ShapeElement, "id" | "boardId" | "userId" | "createdAt">>;

export async function batchUpdateShapes(
  boardId: string,
  updates: { id: string; data: ShapeUpdate }[]
): Promise<void> {
  for (let i = 0; i < updates.length; i += 500) {
    const batch = writeBatch(db);
    for (const u of updates.slice(i, i + 500)) {
      batch.update(doc(db, "boards", boardId, "shapes", u.id), u.data);
    }
    await batch.commit();
  }
}

export async function batchDeleteShapes(boardId: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    const batch = writeBatch(db);
    for (const shapeId of ids.slice(i, i + 500)) {
      batch.delete(doc(db, "boards", boardId, "shapes", shapeId));
    }
    await batch.commit();
  }
}

export async function clearBoardShapes(boardId: string): Promise<void> {
  const ref = collection(db, "boards", boardId, "shapes");
  const snapshot = await getDocs(ref);
  for (let i = 0; i < snapshot.docs.length; i += 500) {
    const batch = writeBatch(db);
    snapshot.docs.slice(i, i + 500).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

export function subscribeToBoardShapes(
  boardId: string,
  onChange: (shapes: ShapeElement[]) => void
): () => void {
  const q = query(collection(db, "boards", boardId, "shapes"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snapshot) => {
    const shapes = snapshot.docs
      .map((d) => mapShapeDoc(d.id, d.data()))
      .filter((s): s is ShapeElement => s !== null);
    onChange(shapes);
  });
}
