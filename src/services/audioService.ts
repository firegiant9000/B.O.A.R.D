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
 *  function. Unlike `canRecordVoiceNotes` below (which Month 6 also gave a
 *  server-side backstop in firestore.rules), THIS cap is still a client-side
 *  check only — rules cannot measure audio duration, only Storage object
 *  *size* (a rough proxy, not the real thing) via storage.rules' matching
 *  `isValidAudioUpload`, once that file is deployed — as of this writing
 *  `firebase.json` has no `storage` entry, so storage.rules (this block and
 *  the Month 2 image rules alike) has never been deployed and enforces
 *  nothing yet. Even once it is, a raw SDK call that skips `saveVoiceNote`
 *  entirely could still write a longer note under that byte ceiling (e.g. a
 *  lower-bitrate recording). Closing that fully needs a Cloud Function on
 *  this write path — not added here. */
export const MAX_DURATION_MS = 60_000;

function storagePathFor(boardId: string, audioId: string): string {
  return `boards/${boardId}/audio/${audioId}/note.m4a`;
}

// `x`/`y` are NOT required here (unlike `anchorElementId`/`storagePath`/
// `downloadUrl`, which a note is meaningless without) — see AudioElement's
// type comment: they're a write-time snapshot no render path should trust
// for the badge's live position, so a doc missing them is still a
// perfectly usable note, not a malformed one.
function mapAudioDoc(id: string, data: any): AudioElement | null {
  if (!data || !data.anchorElementId || !data.storagePath || !data.downloadUrl) {
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
    x: data.x ?? 0,
    y: data.y ?? 0,
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
 *
 * Bytes land in Storage before the doc is written (the doc's `downloadUrl`
 * needs the object to already exist), which briefly creates the exact class
 * of stranded object this task was chartered to eliminate: storage.rules
 * isn't referenced by `firebase.json` and so enforces nothing today (see
 * `canRecordVoiceNotes`'s header below), leaving firestore.rules' `audio`
 * match (editor, ON A PAID PLAN as of Month 6) as the only real gate, so a
 * caller whose upload succeeds and whose doc write is denied — a
 * viewer/commenter (see AudioAffordance's `canEdit` gate) or a free-plan
 * editor (see its `canRecord` gate, both of which exist precisely to make
 * this rare) — would otherwise leave the object behind with nothing ever
 * referencing it. Any failure from here on — `getDownloadURL` or `setDoc` —
 * deletes the just-uploaded object (best-effort) before rethrowing, so a
 * denied/failed write never strands bytes the way a *lost* one would.
 *
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
    contentType: "audio/mp4",
  });

  try {
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
  } catch (e) {
    await deleteObject(storageRef(storage, storagePath)).catch(() => undefined);
    throw e;
  }
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
 * Deletes every voice note anchored to any of `elementIds` — a `getDocs`
 * read over the whole `audio` subcollection, filtered client-side (same
 * shape as `clearBoardVoiceNotes`, no `where("anchorElementId", "in", ...)`
 * — that sidesteps the `in` operator's per-query id ceiling and needs no
 * composite index, since a single unfiltered `getDocs` never does), then
 * routed through `batchDeleteVoiceNotes` above.
 *
 * NOT the primary path: `useBoardElements.ts`'s `cascadeDeleteVoiceNotes`
 * already holds every note in memory via its own live `onSnapshot`
 * (`subscribeToBoardAudio`), so its usual path filters that in-memory list
 * and calls `batchDeleteVoiceNotes` directly — zero Firestore reads in the
 * overwhelmingly common case where nothing anchored is being deleted. THIS
 * function exists only as that hook's fallback for the brief window before
 * its subscription's first snapshot has landed, when the in-memory list
 * can't yet be trusted. Call it directly only if you have no live
 * subscription of your own to filter instead.
 *
 * Best-effort either way: callers must never let its rejection fail the
 * element delete it's cascading from (mirrors every other Storage cleanup in
 * this file/imageService.ts) — see the fire-and-forget `.catch(...)` call
 * sites in useBoardElements.ts.
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

// ── Pro entitlement check (affordance gate; also enforced server-side) ──────
// Voice notes are billed as a Pro-tier feature (ROADMAP.md:583-587, item 9).
//
// This function itself is still just the UI's affordance gate — it decides
// whether AudioAffordance shows a recorder or an upgrade prompt, nothing more
// — but as of Month 6 the tier is ALSO enforced server-side: firestore.rules'
// `boards/{id}/audio` match denies `create` on a free-plan board via
// `boardOnPaidPlan` (that predicate reads the workspace's real `plan`, unlike
// this function's plain `plan` parameter, so it can't be steered by whatever
// value a caller passes here). A patched bundle or a raw SDK call that skips
// this module entirely still hits that rule on the actual write.
//
// storage.rules' `boards/{id}/audio/...` match is NOT part of that fix, and
// unlike firestore.rules above, it is not deployed AT ALL today (see
// MAX_DURATION_MS's comment: no `storage` entry exists in `firebase.json`),
// so it enforces nothing — not even membership, let alone plan. A denied
// Firestore doc write can still leave an uploaded Storage object behind
// either way; closing that fully needs actually deploying storage.rules (and
// probably a Cloud Function on top), tracked separately. `saveVoiceNote`
// above already deletes the object on a failed doc write for exactly this
// reason, which now includes "denied by the plan gate," not just
// network/permission failures.
//
// `plan` is `Plan | undefined`, not just `Plan` — the same correction
// `workspaceService.ts#canUsePresenter` already carries, arrived at for the
// same reason and deliberately given the same shape. `undefined` means the
// caller does not yet KNOW the plan (the board's workspace hasn't resolved,
// the board has no workspace at all, or the `getWorkspace` fetch failed —
// see `useBoardDocument.ts`'s `boardWorkspace`), and that is a different
// fact from "known to be on the free plan." This fails OPEN on the unknown
// case: `plan !== "free"` already does, because `undefined !== "free"`, so
// only a plan actually known to be `"free"` is gated.
//
// The widening is the point, not a formality. The runtime expression was
// already correct; what reintroduced the regression at this call site was
// the NARROW signature — declaring `plan: Plan` forced `app/board/[id].tsx`
// to write `?? "free"` to satisfy the type-checker, which is how a paying
// customer whose workspace fetch failed got a locked mic for an entire
// board session (`loadBoard` runs once per boardId with no retry), and how
// every board load showed one transiently before the fetch resolved. Do not
// collapse the unknown case to `"free"` at any call site, and do not narrow
// this parameter back — the narrow type IS the trap.
export function canRecordVoiceNotes(plan: Plan | undefined): boolean {
  return plan !== "free";
}
