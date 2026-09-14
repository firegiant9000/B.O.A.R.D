import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { CODE_ENABLED } from "../lib/featureFlags";
import {
  CODE_DEFAULT_FONT_SIZE,
  CODE_DEFAULT_LANGUAGE,
  isCodeLanguage,
  layoutCodeBox,
} from "../lib/codeRender";
import type { Bounds } from "../lib/viewport";
import type { CodeElement, CodeLanguage } from "../types";

// Month 6 — code elements. One document per snippet under a board's
// `codeElements` subcollection, mirroring mathService/shapeService: board-
// space coordinates, a write-time `bbox` for viewport culling and tap-select,
// and an ordered realtime subscription.
//
// UNLIKE mathService, there is no Cloud Function and no cached render output:
// `code`/`language` ARE the element (see `CodeElement`'s type comment) —
// `lib/codeRender.ts` tokenizes them synchronously on-device, so every write
// path below is geometry + those two fields, never a network round-trip.
//
// UI components call this module, never Firestore directly.

const MAX_BATCH = 500;

/** Whether the code-element affordance should be offered at all. Hides the
 *  entry point only; nothing here is a security gate (see CODE_ENABLED's
 *  header in `lib/featureFlags.ts`). */
export function isCodeConfigured(): boolean {
  return CODE_ENABLED;
}

/** Board-space box COMPUTED from geometry, always — never the stored `bbox`.
 *  Callers that have just changed x/y/width/height must use this; reaching
 *  for `codeElementBbox` there would hand back the pre-change box, because
 *  that one deliberately prefers what is stored. Mirrors
 *  `mathService.mathBoxOf`. */
export function codeBoxOf(el: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Bounds {
  return {
    minX: el.x,
    minY: el.y,
    maxX: el.x + el.width,
    maxY: el.y + el.height,
  };
}

/** A stored number, only if it is actually usable. `typeof NaN === "number"`,
 *  so a bare typeof check would let NaN through into geometry that then
 *  poisons every bounds union, culling test and hit-test it touches. Fails
 *  closed to `fallback`. Mirrors `mathService.finite`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A stored positive number — sizes and font sizes must be > 0 or the
 *  element is invisible/inverted rather than merely misplaced. Mirrors
 *  `mathService.positive`. */
function positive(value: unknown, fallback: number): number {
  const n = finite(value, NaN);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Tolerant reader. UNLIKE `mathService.mapMathDoc`, an empty `code` is a
 * valid element (there is still a box to select/delete/retype into — see
 * `CodeElement`'s type comment on why that differs from math, where an
 * empty `svgPath` means nothing was ever rendered at all) — only a
 * document with no `code` string whatsoever is not a code element and is
 * dropped. `language`/`fontSize`/geometry all fall back to a safe default
 * rather than propagating a corrupt value into the canvas, same reasoning
 * as `mathService.mapMathDoc`.
 */
export function mapCodeDoc(id: string, data: any): CodeElement | null {
  if (!data || typeof data.code !== "string") return null;
  const language: CodeLanguage = isCodeLanguage(data.language)
    ? data.language
    : CODE_DEFAULT_LANGUAGE;
  const el: CodeElement = {
    id,
    schemaVersion: 1,
    type: "code",
    boardId: data.boardId ?? "",
    userId: data.userId ?? "",
    code: data.code,
    language,
    x: finite(data.x, 0),
    y: finite(data.y, 0),
    width: positive(data.width, 1),
    height: positive(data.height, 1),
    fontSize: positive(data.fontSize, CODE_DEFAULT_FONT_SIZE),
    rotation: finite(data.rotation, 0),
    z: typeof data.z === "number" && Number.isFinite(data.z) ? data.z : undefined,
    bbox: undefined,
    createdAt: data.createdAt?.toDate?.() ?? new Date(),
  };
  // Recompute rather than trust a stored bbox that may disagree with the
  // (already validated) geometry — same reasoning as mathService's.
  el.bbox = codeBoxOf(el);
  return el;
}

// ── writes ──────────────────────────────────────────────────────────────────

export interface CreateCodeInput {
  boardId: string;
  code: string;
  language: CodeLanguage;
  /** Board-space top-left. */
  x: number;
  y: number;
  userId?: string;
  fontSize?: number;
}

/**
 * Lay out `code` (pure, synchronous — `lib/codeRender.ts`) and persist it as
 * a new code element. Returns the new document's id.
 *
 * UNLIKE `mathService.createMathElement`, there is no render call to await
 * and no way for this to fail on the content itself (there is no "invalid
 * code", only text) — the only rejection path is the Firestore write.
 */
export async function createCodeElement(input: CreateCodeInput): Promise<string> {
  const { boardId, code, x, y, userId, fontSize: rawFontSize } = input;
  const language: CodeLanguage = isCodeLanguage(input.language)
    ? input.language
    : CODE_DEFAULT_LANGUAGE;
  const fontSize = positive(rawFontSize, CODE_DEFAULT_FONT_SIZE);
  const { width, height } = layoutCodeBox(code, fontSize);
  const ref = collection(db, "boards", boardId, "codeElements");
  const docRef = await addDoc(ref, {
    schemaVersion: 1,
    type: "code",
    boardId,
    userId: userId ?? "",
    code,
    language,
    x,
    y,
    width,
    height,
    fontSize,
    rotation: 0,
    bbox: codeBoxOf({ x, y, width, height }),
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

/**
 * Re-lay-out an existing element's source/language. The element keeps its
 * position and its `fontSize`; its box is re-derived from the new content,
 * because edited code is generally a different shape and keeping the old
 * width/height would leave the selection box and the drawn text disagreeing
 * — mirrors `mathService.updateMathLatex`'s same reasoning for `scale`.
 */
export async function updateCodeSource(
  boardId: string,
  elementId: string,
  code: string,
  language: CodeLanguage,
  current: { x: number; y: number; fontSize: number }
): Promise<void> {
  const fontSize = positive(current.fontSize, CODE_DEFAULT_FONT_SIZE);
  const { width, height } = layoutCodeBox(code, fontSize);
  const x = finite(current.x, 0);
  const y = finite(current.y, 0);
  await updateDoc(doc(db, "boards", boardId, "codeElements", elementId), {
    code,
    language: isCodeLanguage(language) ? language : CODE_DEFAULT_LANGUAGE,
    width,
    height,
    bbox: codeBoxOf({ x, y, width, height }),
  });
}

/**
 * Persist a code element whose geometry is ALREADY known — the duplicate /
 * paste path. Mirrors `mathService.saveMathElement`: no layout call, one
 * Firestore write.
 */
export async function saveCodeElement(
  boardId: string,
  el: Omit<CodeElement, "id" | "createdAt" | "bbox">
): Promise<string> {
  const ref = collection(db, "boards", boardId, "codeElements");
  const docRef = await addDoc(ref, {
    ...el,
    schemaVersion: 1,
    type: "code",
    boardId,
    bbox: codeBoxOf(el),
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

type CodeUpdate = Partial<
  Omit<CodeElement, "id" | "schemaVersion" | "type" | "boardId" | "userId" | "createdAt">
>;

export async function updateCodeElement(
  boardId: string,
  elementId: string,
  updates: CodeUpdate
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId, "codeElements", elementId), updates);
}

export async function deleteCodeElement(boardId: string, elementId: string): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId, "codeElements", elementId));
}

export async function batchUpdateCodeElements(
  boardId: string,
  updates: { id: string; data: CodeUpdate }[]
): Promise<void> {
  for (let i = 0; i < updates.length; i += MAX_BATCH) {
    const batch = writeBatch(db);
    for (const u of updates.slice(i, i + MAX_BATCH)) {
      batch.update(doc(db, "boards", boardId, "codeElements", u.id), u.data);
    }
    await batch.commit();
  }
}

export async function batchDeleteCodeElements(boardId: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    const batch = writeBatch(db);
    for (const elementId of ids.slice(i, i + MAX_BATCH)) {
      batch.delete(doc(db, "boards", boardId, "codeElements", elementId));
    }
    await batch.commit();
  }
}

export async function clearBoardCodeElements(boardId: string): Promise<void> {
  const ref = collection(db, "boards", boardId, "codeElements");
  const snapshot = await getDocs(ref);
  for (let i = 0; i < snapshot.docs.length; i += MAX_BATCH) {
    const batch = writeBatch(db);
    snapshot.docs.slice(i, i + MAX_BATCH).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

export function subscribeToBoardCodeElements(
  boardId: string,
  onChange: (elements: CodeElement[]) => void
): () => void {
  const q = query(
    collection(db, "boards", boardId, "codeElements"),
    orderBy("createdAt", "asc")
  );
  return onSnapshot(q, (snapshot) => {
    const elements = snapshot.docs
      .map((d) => mapCodeDoc(d.id, d.data()))
      .filter((el): el is CodeElement => el !== null);
    onChange(elements);
  });
}

/** Board-space box of a code element — exported so the canvas and the
 *  element hook derive it from ONE place rather than each re-deriving
 *  x+width. Mirrors `mathService.mathElementBbox`. */
export function codeElementBbox(el: CodeElement): Bounds {
  return el.bbox ?? codeBoxOf(el);
}
