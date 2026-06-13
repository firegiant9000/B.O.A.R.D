import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "firebase/storage";
import { db, storage } from "../config/firebase";
import { ImageElement } from "../types";
import { imageBbox, PreparedImage } from "../lib/images";
import { randomCode } from "../lib/secureRandom";

// Mirrors the `shapes` subcollection pattern (shapeService): one doc per image,
// board-space coordinates, a write-time `bbox` for Phase 4 culling and
// tap-select, and an ordered real-time subscription. bbox is recomputed on read
// for any legacy/partial doc. The image bytes themselves live in Firebase
// Storage; the doc stores the storage paths plus the resolved download URLs so
// the SVG renderer has an `href` without an async lookup per element.

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function mapImageDoc(id: string, data: any): ImageElement | null {
  if (
    !data ||
    !data.url ||
    data.x === undefined ||
    data.y === undefined
  ) {
    return null;
  }
  const image: ImageElement = {
    id,
    boardId: data.boardId ?? "",
    userId: data.userId ?? "",
    storagePath: data.storagePath ?? "",
    thumbnailPath: data.thumbnailPath ?? "",
    url: data.url,
    thumbnailUrl: data.thumbnailUrl ?? data.url,
    x: data.x,
    y: data.y,
    width: data.width ?? 0,
    height: data.height ?? 0,
    rotation: data.rotation ?? 0,
    naturalWidth: data.naturalWidth ?? data.width ?? 0,
    naturalHeight: data.naturalHeight ?? data.height ?? 0,
    alt: data.alt ?? "",
    bbox: undefined,
    z: data.z,
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
  image.bbox = data.bbox ?? imageBbox(image);
  return image;
}

export interface ImagePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  alt?: string;
}

/**
 * Upload a prepared image (full + thumbnail) to Storage and create its Firestore
 * doc. A client-generated id keys both the storage folder and the doc, so the doc
 * is written once (after the uploads resolve) and never appears half-formed in
 * the subscription. Returns the new image id.
 */
export async function uploadImage(
  boardId: string,
  userId: string,
  prepared: PreparedImage,
  placement: ImagePlacement
): Promise<string> {
  const imageId = randomCode(20, ID_ALPHABET);
  const base = `boards/${boardId}/images/${imageId}`;
  const storagePath = `${base}/full.jpg`;
  const thumbnailPath = `${base}/thumb.jpg`;

  await Promise.all([
    uploadBytes(storageRef(storage, storagePath), prepared.full.blob, {
      contentType: "image/jpeg",
    }),
    uploadBytes(storageRef(storage, thumbnailPath), prepared.thumbnail.blob, {
      contentType: "image/jpeg",
    }),
  ]);

  const [url, thumbnailUrl] = await Promise.all([
    getDownloadURL(storageRef(storage, storagePath)),
    getDownloadURL(storageRef(storage, thumbnailPath)),
  ]);

  const element = {
    boardId,
    userId,
    storagePath,
    thumbnailPath,
    url,
    thumbnailUrl,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    rotation: 0,
    naturalWidth: prepared.naturalWidth,
    naturalHeight: prepared.naturalHeight,
    alt: placement.alt ?? prepared.alt ?? "",
  };

  await setDoc(doc(db, "boards", boardId, "images", imageId), {
    ...element,
    bbox: imageBbox(element),
    createdAt: serverTimestamp(),
  });
  return imageId;
}

/**
 * Write an image doc for an *already-uploaded* asset (duplicate / paste of an
 * existing element). Reuses the source's storage objects + download URLs — no
 * re-upload — so a duplicate is a single Firestore write. Returns the new id.
 */
export async function saveImage(
  boardId: string,
  image: Omit<ImageElement, "id" | "createdAt" | "bbox">
): Promise<string> {
  const imageId = randomCode(20, ID_ALPHABET);
  await setDoc(doc(db, "boards", boardId, "images", imageId), {
    ...image,
    bbox: imageBbox(image),
    createdAt: serverTimestamp(),
  });
  return imageId;
}

export async function updateImage(
  boardId: string,
  imageId: string,
  updates: Partial<Omit<ImageElement, "id" | "boardId" | "userId" | "createdAt">>
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId, "images", imageId), updates);
}

export async function deleteImage(boardId: string, imageId: string): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId, "images", imageId));
  // Best-effort cleanup of the underlying objects; a missing object isn't fatal
  // (the doc is the source of truth and is already gone).
  await Promise.allSettled([
    deleteObject(storageRef(storage, `boards/${boardId}/images/${imageId}/full.jpg`)),
    deleteObject(storageRef(storage, `boards/${boardId}/images/${imageId}/thumb.jpg`)),
  ]);
}

// --- Group operations (Phase 8) ---
// Many-at-once move / transform / z-order, committed as 500-op writeBatches. The
// caller computes the field deltas (geometry + recomputed bbox); the service just
// writes them, mirroring shapeService.batchUpdateShapes.

type ImageUpdate = Partial<Omit<ImageElement, "id" | "boardId" | "userId" | "createdAt">>;

export async function batchUpdateImages(
  boardId: string,
  updates: { id: string; data: ImageUpdate }[]
): Promise<void> {
  for (let i = 0; i < updates.length; i += 500) {
    const batch = writeBatch(db);
    for (const u of updates.slice(i, i + 500)) {
      batch.update(doc(db, "boards", boardId, "images", u.id), u.data);
    }
    await batch.commit();
  }
}

export async function batchDeleteImages(boardId: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    const batch = writeBatch(db);
    for (const imageId of ids.slice(i, i + 500)) {
      batch.delete(doc(db, "boards", boardId, "images", imageId));
    }
    await batch.commit();
  }
}

export async function clearBoardImages(boardId: string): Promise<void> {
  const ref = collection(db, "boards", boardId, "images");
  const snapshot = await getDocs(ref);
  for (let i = 0; i < snapshot.docs.length; i += 500) {
    const batch = writeBatch(db);
    snapshot.docs.slice(i, i + 500).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

export function subscribeToBoardImages(
  boardId: string,
  onChange: (images: ImageElement[]) => void
): () => void {
  const q = query(collection(db, "boards", boardId, "images"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snapshot) => {
    const images = snapshot.docs
      .map((d) => mapImageDoc(d.id, d.data()))
      .filter((img): img is ImageElement => img !== null);
    onChange(images);
  });
}
