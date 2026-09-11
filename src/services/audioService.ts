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
  writeBatch,
} from "firebase/firestore";
import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "firebase/storage";
import { db, storage } from "../config/firebase";
import { AudioElement, Plan } from "../types";
import { randomCode } from "../lib/secureRandom";

// Month 5 (ROADMAP.md:583-587, roadmap item 9 — voice notes). Mirrors
// imageService's Storage pattern: one doc per note under a board's `audio`
// subcollection, the audio bytes themselves in Firebase Storage at a
// well-known path derived from the same client-generated id that keys the
// doc, so delete never needs to read the doc first to know what to remove
// from Storage (see deleteVoiceNote).
//
// Format: AAC in an .m4a container (ROADMAP.md's "~80KB per 10s" sizing),
// recorded client-side via expo-audio's `RecordingPresets.HIGH_QUALITY`
// (src/components/board/AudioAffordance.tsx) — `expo-av` does not exist on
// SDK 55.

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** ROADMAP.md:583 — "Record up to 60s of audio". Checked here (defense in
 *  depth alongside AudioAffordance's own recorder auto-stop) so a caller that
 *  bypasses the UI — a duplicate/paste path added later, a direct call into
 *  this module — still cannot persist an over-cap note through THIS
 *  function. Like `canRecordVoiceNotes` below, this is a client-side check
 *  only: storage.rules' matching `isValidAudioUpload` caps upload *size*
 *  (2 MB), which is a rough proxy for ~60s at this format's bitrate, not an
 *  actual duration check — Storage rules have no notion of audio duration.
 *  A raw SDK call that skips `saveVoiceNote` entirely can still write a
 *  longer note under that byte ceiling (e.g. a lower-bitrate recording).
 *  Closing that fully needs a Cloud Function on this write path, same as the
 *  plan gate — not added here; see the module-level comment below. */
export const MAX_DURATION_MS = 60_000;

function storagePathFor(boardId: string, audioId: string): string {
  return `boards/${boardId}/audio/${audioId}/note.m4a`;
}

function mapAudioDoc(id: string, data: any): AudioElement | null {
  if (
    !data ||
    !data.anchorElementId ||
    !data.storagePath ||
    !data.downloadUrl ||
    data.x === undefined ||
    data.y === undefined
  ) {
    return null;
  }
  return {
    id,
    schemaVersion: 1,
    boardId: data.boardId ?? "",
    userId: data.userId ?? "",
    anchorElementId: data.anchorElementId,
    storagePath: data.storagePath,
    downloadUrl: data.downloadUrl,
    durationMs: data.durationMs ?? 0,
    x: data.x,
    y: data.y,
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

export interface SaveVoiceNoteInput {
  boardId: string;
  anchorElementId: string;
  /** Local recording URI (expo-audio's `AudioRecorder.uri` once stopped),
   *  fetched and uploaded as a Blob — the standard Expo pattern for putting a
   *  local file into Firebase Storage. */
  uri: string;
  durationMs: number;
  userId?: string;
  x?: number;
  y?: number;
}

/**
 * Upload a recorded voice note to Storage and create its Firestore doc.
 * Rejects up front — before any network call — when `durationMs` exceeds the
 * 60s cap, so an over-cap recording never reaches Storage or Firestore.
 * Returns the new audio doc's id.
 */
export async function saveVoiceNote(input: SaveVoiceNoteInput): Promise<string> {
  const { boardId, anchorElementId, uri, durationMs, userId, x, y } = input;
  if (durationMs > MAX_DURATION_MS) {
    throw new Error(
      `Voice notes are capped at 60s (${MAX_DURATION_MS}ms); got ${durationMs}ms.`
    );
  }

  const audioId = randomCode(20, ID_ALPHABET);
  const storagePath = storagePathFor(boardId, audioId);

  const response = await fetch(uri);
  const blob = await response.blob();
  await uploadBytes(storageRef(storage, storagePath), blob, {
    contentType: "audio/m4a",
  });
  const downloadUrl = await getDownloadURL(storageRef(storage, storagePath));

  await setDoc(doc(db, "boards", boardId, "audio", audioId), {
    schemaVersion: 1,
    boardId,
    userId: userId ?? "",
    anchorElementId,
    storagePath,
    downloadUrl,
    durationMs,
    x: x ?? 0,
    y: y ?? 0,
    createdAt: serverTimestamp(),
  });
  return audioId;
}

/**
 * Deletes the Firestore doc, then best-effort deletes the Storage object at
 * its well-known path (a missing object isn't fatal — the doc is already
 * gone and is the source of truth). Mirrors imageService.deleteImage, which
 * is the single-delete half of the M2 carry-forward "Storage objects
 * orphaned on group-delete/clear-board" defect this task also fixes for
 * `batchDeleteVoiceNotes`/`clearBoardVoiceNotes` below (and for images' own
 * `batchDeleteImages`/`clearBoardImages`, see imageService.ts) — this single
 * path was never the buggy one, but is kept in the same shape as those for
 * consistency.
 */
export async function deleteVoiceNote(boardId: string, audioId: string): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId, "audio", audioId));
  await Promise.allSettled([
    deleteObject(storageRef(storage, storagePathFor(boardId, audioId))),
  ]);
}

// --- Group operations (orphan fix — see deleteVoiceNote's comment) ---
// batchDeleteVoiceNotes/clearBoardVoiceNotes both delete every id's Storage
// object alongside its doc, in the same writeBatch chunk, so a bulk delete
// can never leave audio bytes behind the way imageService's pre-fix
// batchDeleteImages/clearBoardImages did.

export async function batchDeleteVoiceNotes(boardId: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const batch = writeBatch(db);
    for (const audioId of chunk) {
      batch.delete(doc(db, "boards", boardId, "audio", audioId));
    }
    await batch.commit();
    await Promise.allSettled(
      chunk.map((audioId) =>
        deleteObject(storageRef(storage, storagePathFor(boardId, audioId)))
      )
    );
  }
}

export async function clearBoardVoiceNotes(boardId: string): Promise<void> {
  const ref = collection(db, "boards", boardId, "audio");
  const snapshot = await getDocs(ref);
  for (let i = 0; i < snapshot.docs.length; i += 500) {
    const chunk = snapshot.docs.slice(i, i + 500);
    const batch = writeBatch(db);
    chunk.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    await Promise.allSettled(
      chunk.map((d) => deleteObject(storageRef(storage, storagePathFor(boardId, d.id))))
    );
  }
}

/**
 * Deletes every voice note anchored to any of `elementIds` — the other half
 * of the orphan fix. Before this task, no element referenced a Storage
 * object owned by a different collection; now that a note can be anchored to
 * a stroke/sticky/text/image, deleting THAT element (single-delete,
 * group-delete, the eraser, undo, or auto-perfect's stroke→shape swap — every
 * real delete call site in useBoardElements.ts) must not leave its note (a
 * Firestore doc *and* a Storage object) behind, unreachable and un-owned.
 *
 * Reads the board's whole `audio` subcollection and filters client-side by
 * `anchorElementId`, rather than a `where("anchorElementId", "in", ...)`
 * query — deliberately: it reuses the exact read `clearBoardVoiceNotes`
 * already does (no new query shape to reason about), sidesteps the `in`
 * operator's per-query id ceiling entirely (a large group-delete could
 * exceed it), and needs no composite index (a single unfiltered
 * `getDocs(collection(...))`, like every other read in this file, never
 * does). Voice notes per board are expected to be few, so the extra reads
 * this trades for are cheap. Matching ids are then routed through
 * `batchDeleteVoiceNotes` above — no new delete logic.
 *
 * Callers must treat this as best-effort and never let its rejection fail
 * the element delete it's cascading from (mirrors every other Storage
 * cleanup in this file/imageService.ts) — see the fire-and-forget
 * `.catch(...)` call sites in useBoardElements.ts.
 */
export async function deleteVoiceNotesForElements(
  boardId: string,
  elementIds: string[]
): Promise<void> {
  if (elementIds.length === 0) return;
  const idSet = new Set(elementIds);
  const ref = collection(db, "boards", boardId, "audio");
  const snapshot = await getDocs(ref);
  const matching = snapshot.docs.filter((d) => idSet.has((d.data() as any)?.anchorElementId));
  if (matching.length === 0) return;
  await batchDeleteVoiceNotes(
    boardId,
    matching.map((d) => d.id)
  );
}

export function subscribeToBoardAudio(
  boardId: string,
  onChange: (notes: AudioElement[]) => void
): () => void {
  const q = query(collection(db, "boards", boardId, "audio"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snapshot) => {
    const notes = snapshot.docs
      .map((d) => mapAudioDoc(d.id, d.data()))
      .filter((n): n is AudioElement => n !== null);
    onChange(notes);
  });
}

// ── advisory Pro entitlement check ──────────────────────────────────────────
// ⚠️ ADVISORY ONLY — NOT AN ENFORCEMENT POINT. See quotaService.ts's module
// header for the full rationale behind that framing; this is the same thing
// for a boolean feature-gate instead of a countable quota.
//
// Voice notes are billed as a Pro-tier feature (ROADMAP.md:583-587, item 9).
// Nothing server-side enforces that today: firestore.rules' `boards/{id}/audio`
// match and storage.rules' `boards/{id}/audio/...` match both gate on board
// membership only (mirroring the images rule they're copied from) — neither
// reads `plan`, and no Cloud Function sits on this write path. A determined
// client — a patched bundle, or a raw SDK call that skips this module
// entirely — can record and upload a voice note on the free tier right now.
// This function exists solely so AudioAffordance can offer an upgrade instead
// of a broken/silent recorder; it denies nothing a server would enforce.
//
// Closing this gap needs the same kind of change quotaService.ts's header
// describes for boards/sessions: a rules or callable predicate on `plan`.
// That is tracked separately (owned by a later task that already touches
// firestore.rules) — do not add a plan predicate to firestore.rules or
// storage.rules here, and do not treat this function as enforcement anywhere
// it's called.
export function canRecordVoiceNotes(plan: Plan): boolean {
  return plan !== "free";
}
