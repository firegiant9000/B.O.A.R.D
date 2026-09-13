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
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../config/firebase";
import { MATH_ENABLED } from "../lib/featureFlags";
import type { Bounds } from "../lib/viewport";
import type { MathElement } from "../types";

// Month 6 — math elements. One document per equation under a board's
// `mathElements` subcollection, mirroring shapeService/imageService: board-
// space coordinates, a write-time `bbox` for viewport culling and tap-select,
// and an ordered realtime subscription.
//
// `latex` is the editable source of truth; `svgPath`/`width`/`height` are
// CACHED OUTPUT of the `renderMath` Cloud Function. The function is called in
// exactly two places — `createMathElement` and `updateMathLatex` — and never
// on read, render, move, resize, delete or z-order. That is what "re-render
// only when `latex` changes" means in practice, and it is the reason an
// equation costs nothing to display once it exists.
//
// UI components call this module, never Firestore or the callable directly.

const MAX_BATCH = 500;

/** Re-exported so a caller already holding this module doesn't need a second
 *  import; the constant itself lives in `lib/mathInk` (a pure module the
 *  composer can read without pulling the Firestore SDK in through here), and
 *  carries the full note on why a client-side cap is advisory. */
export { MAX_LATEX_LENGTH } from "../lib/mathInk";

/** Whether the equation affordance should be offered at all. Hides the entry
 *  point only; nothing here is a security gate (see MATH_ENABLED's header). */
export function isMathConfigured(): boolean {
  return MATH_ENABLED;
}

/** Board-space box COMPUTED from geometry, always — never the stored `bbox`.
 *  Callers that have just changed x/y/width/height must use this; reaching for
 *  `mathElementBbox` there would hand back the pre-change box, because that
 *  one deliberately prefers what is stored. */
export function mathBoxOf(el: {
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
 *  closed to `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A stored positive number — sizes and scales must be > 0 or the element is
 *  invisible/inverted rather than merely misplaced. */
function positive(value: unknown, fallback: number): number {
  const n = finite(value, NaN);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Tolerant reader. A document with no `latex` or no `svgPath` is not a math
 * element at all (there is nothing to edit and nothing to draw) and is
 * dropped; everything else falls back to a safe value rather than propagating
 * a corrupt number into the canvas. `scale` defaults to 1 and `width`/
 * `height` to a small non-zero box so a partially-written document is
 * selectable — and therefore deletable — instead of being a zero-area element
 * nobody can tap.
 */
export function mapMathDoc(id: string, data: any): MathElement | null {
  if (!data || typeof data.latex !== "string" || typeof data.svgPath !== "string") return null;
  if (!data.latex || !data.svgPath) return null;
  const el: MathElement = {
    id,
    schemaVersion: 1,
    type: "math",
    boardId: data.boardId ?? "",
    userId: data.userId ?? "",
    latex: data.latex,
    svgPath: data.svgPath,
    x: finite(data.x, 0),
    y: finite(data.y, 0),
    width: positive(data.width, 1),
    height: positive(data.height, 1),
    scale: positive(data.scale, 1),
    bbox: undefined,
    z: typeof data.z === "number" && Number.isFinite(data.z) ? data.z : undefined,
    createdAt: data.createdAt?.toDate?.() ?? new Date(),
  };
  // Recompute rather than trust a stored bbox that may disagree with the
  // (already validated) geometry — same reasoning as shapeService's.
  el.bbox = mathBoxOf(el);
  return el;
}

// ── rendering (the one call into the Cloud Function) ────────────────────────

interface RenderMathCallableRequest {
  boardId: string;
  latex: string;
  displayMode?: boolean;
}

interface RenderMathCallableResponse {
  svgPath: string;
  width: number;
  height: number;
  cached: boolean;
  error?: string;
}

export interface RenderedMath {
  svgPath: string;
  /** Natural size in board units at `scale: 1`. */
  width: number;
  height: number;
  cached: boolean;
}

/**
 * Typeset LaTeX into flat SVG path data.
 *
 * A malformed expression is NOT an exception — it comes back from the
 * callable as a 200 carrying `error`, and this rethrows it as a plain Error
 * whose message is TeX's own ("Missing close brace"), which is what the
 * composer shows inline. That distinction matters: `.code` is left undefined
 * for those, and set only for the callable's real failures (unauthenticated,
 * permission-denied, resource-exhausted), so a caller can tell "you typed
 * something wrong" from "the service said no".
 *
 * `.details` is preserved alongside `.code` for the same reason
 * flashcardService preserves it: the one `resource-exhausted` throw site in
 * `renderMath` carries `details: { reason: "rate-limit" }`, and a caller must
 * route on that rather than inferring a plan cap — this callable has no plan
 * quota to hit, so "upgrade" is never the right message here.
 */
export async function renderMath(
  boardId: string,
  latex: string,
  displayMode = true
): Promise<RenderedMath> {
  const callable = httpsCallable<RenderMathCallableRequest, RenderMathCallableResponse>(
    functions,
    "renderMath"
  );
  let data: RenderMathCallableResponse;
  try {
    ({ data } = await callable({ boardId, latex, displayMode }));
  } catch (e: any) {
    throw Object.assign(new Error(e?.message ?? "Couldn't render that equation."), {
      code: e?.code,
      details: e?.details,
    });
  }
  if (data?.error) {
    // A readable TeX message, deliberately without a `code`.
    throw new Error(data.error);
  }
  if (!data?.svgPath || !Number.isFinite(data.width) || !Number.isFinite(data.height)) {
    throw new Error("Couldn't render that equation.");
  }
  return {
    svgPath: data.svgPath,
    width: data.width,
    height: data.height,
    cached: !!data.cached,
  };
}

// ── writes ──────────────────────────────────────────────────────────────────

export interface CreateMathInput {
  boardId: string;
  latex: string;
  /** Board-space top-left. */
  x: number;
  y: number;
  userId?: string;
  scale?: number;
  displayMode?: boolean;
}

/**
 * Render `latex` and persist the result as a new math element. Returns the new
 * document's id.
 *
 * The render happens FIRST: an element with no `svgPath` has nothing to draw
 * and is dropped by `mapMathDoc`, so writing the document before the render
 * succeeded would leave an invisible, unselectable row behind whenever the
 * expression turns out to be malformed. A failed render therefore writes
 * nothing at all.
 */
export async function createMathElement(input: CreateMathInput): Promise<string> {
  const { boardId, latex, x, y, userId, scale: rawScale, displayMode } = input;
  const scale = positive(rawScale, 1);
  const rendered = await renderMath(boardId, latex, displayMode);
  const width = rendered.width * scale;
  const height = rendered.height * scale;
  const ref = collection(db, "boards", boardId, "mathElements");
  const docRef = await addDoc(ref, {
    schemaVersion: 1,
    type: "math",
    boardId,
    userId: userId ?? "",
    latex,
    svgPath: rendered.svgPath,
    x,
    y,
    width,
    height,
    scale,
    bbox: mathBoxOf({ x, y, width, height }),
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

/**
 * Re-typeset an existing element's source. THE ONLY write path that calls the
 * function — every other update below is geometry and must not.
 *
 * The element keeps its position and its `scale`; its box is re-derived from
 * the new natural size, because an edited expression is generally a different
 * shape and keeping the old width/height would leave the selection box and
 * the drawn glyphs disagreeing.
 */
export async function updateMathLatex(
  boardId: string,
  elementId: string,
  latex: string,
  current: { x: number; y: number; scale: number },
  displayMode = true
): Promise<void> {
  const rendered = await renderMath(boardId, latex, displayMode);
  const scale = positive(current.scale, 1);
  const width = rendered.width * scale;
  const height = rendered.height * scale;
  await updateDoc(doc(db, "boards", boardId, "mathElements", elementId), {
    latex,
    svgPath: rendered.svgPath,
    width,
    height,
    scale,
    bbox: mathBoxOf({ x: finite(current.x, 0), y: finite(current.y, 0), width, height }),
  });
}

/**
 * Persist a math element whose `svgPath` is ALREADY rendered — the duplicate /
 * paste path. Deliberately does not call the function: duplicating an equation
 * copies path data that has already been typeset, so it costs one Firestore
 * write and nothing else. Use `createMathElement` when the LaTeX is new.
 */
export async function saveMathElement(
  boardId: string,
  el: Omit<MathElement, "id" | "createdAt" | "bbox">
): Promise<string> {
  const ref = collection(db, "boards", boardId, "mathElements");
  const docRef = await addDoc(ref, {
    ...el,
    schemaVersion: 1,
    type: "math",
    boardId,
    bbox: mathBoxOf(el),
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

type MathUpdate = Partial<
  Omit<MathElement, "id" | "schemaVersion" | "type" | "boardId" | "userId" | "createdAt">
>;

export async function updateMathElement(
  boardId: string,
  elementId: string,
  updates: MathUpdate
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId, "mathElements", elementId), updates);
}

export async function deleteMathElement(boardId: string, elementId: string): Promise<void> {
  await deleteDoc(doc(db, "boards", boardId, "mathElements", elementId));
}

export async function batchUpdateMathElements(
  boardId: string,
  updates: { id: string; data: MathUpdate }[]
): Promise<void> {
  for (let i = 0; i < updates.length; i += MAX_BATCH) {
    const batch = writeBatch(db);
    for (const u of updates.slice(i, i + MAX_BATCH)) {
      batch.update(doc(db, "boards", boardId, "mathElements", u.id), u.data);
    }
    await batch.commit();
  }
}

export async function batchDeleteMathElements(boardId: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    const batch = writeBatch(db);
    for (const elementId of ids.slice(i, i + MAX_BATCH)) {
      batch.delete(doc(db, "boards", boardId, "mathElements", elementId));
    }
    await batch.commit();
  }
}

export async function clearBoardMathElements(boardId: string): Promise<void> {
  const ref = collection(db, "boards", boardId, "mathElements");
  const snapshot = await getDocs(ref);
  for (let i = 0; i < snapshot.docs.length; i += MAX_BATCH) {
    const batch = writeBatch(db);
    snapshot.docs.slice(i, i + MAX_BATCH).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

export function subscribeToBoardMathElements(
  boardId: string,
  onChange: (elements: MathElement[]) => void
): () => void {
  const q = query(
    collection(db, "boards", boardId, "mathElements"),
    orderBy("createdAt", "asc")
  );
  return onSnapshot(q, (snapshot) => {
    const elements = snapshot.docs
      .map((d) => mapMathDoc(d.id, d.data()))
      .filter((el): el is MathElement => el !== null);
    onChange(elements);
  });
}

/** Board-space box of a math element — exported so the canvas and the element
 *  hook derive it from ONE place rather than each re-deriving x+width. */
export function mathElementBbox(el: MathElement): Bounds {
  return el.bbox ?? mathBoxOf(el);
}
