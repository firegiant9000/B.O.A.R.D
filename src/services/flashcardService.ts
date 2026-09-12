import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../config/firebase";
import { review, INITIAL_CARD, type Card } from "../lib/sm2";
import { FLASHCARDS_ENABLED, AI_GATEWAY_ENABLED } from "../lib/featureFlags";
import type { FlashcardCard, FlashcardDeck } from "../types";

// Month 6 — flashcard generation + review (task 30). The second app surface
// ROADMAP.md calls out as "the easy half's" real cost: a review screen,
// per-user scheduling, and a due-cards query. Scheduling is PER-USER
// (`users/{uid}/decks/{deckId}/cards/{cardId}`), never board-scoped — two
// students studying the same board have different SM-2 schedules. UI
// components call only this module, mirroring every other service in this
// directory (never Firestore/the callable directly).

// ── generation (the "easy half") ───────────────────────────────────────────

export interface GeneratedFlashcard {
  front: string;
  back: string;
}

/** Whether the "Make flashcards" selection affordance should be offered.
 *  Flashcards ride the gateway like OCR/explain/diagram, so it is only
 *  meaningful once `AI_GATEWAY_ENABLED` is also on. */
export function isFlashcardsConfigured(): boolean {
  return FLASHCARDS_ENABLED && AI_GATEWAY_ENABLED;
}

interface GenerateFlashcardsCallableRequest {
  boardId: string;
  selectionText?: string;
  imageDataUrl?: string;
  pathIds?: string[];
}

interface GenerateFlashcardsCallableResponse {
  cards: GeneratedFlashcard[];
  model: string;
  cached: boolean;
}

/**
 * Generates front/back flashcard pairs from a board selection (Month 6). Mirrors
 * aiService's OCR/explain/diagram wrappers: the function does the AI call and
 * memoizes by selection hash; this wrapper does NOT save the returned cards
 * anywhere — call `addCardsToDeck` separately once the caller decides which
 * deck they belong in.
 *
 * EG-16: unlike aiService's OCR/explain/diagram wrappers (which preserve only
 * `.code`), this ALSO preserves `.details` — `generateFlashcards` attaches
 * `details: { reason: "rate-limit" | "plan-quota" }` at every resource-exhausted
 * throw site (functions/src/callable/generateFlashcards.ts), and a caller must
 * route on `quotaService.resourceExhaustedReason(err)`, never re-infer the
 * reason from the workspace's plan the way the four M4 callables' callers have
 * to (quotaService.isPlanCapped) — this callable's client doesn't need to guess.
 */
export async function generateFlashcards(
  boardId: string,
  opts: { selectionText?: string; imageDataUrl?: string; pathIds?: string[] }
): Promise<GenerateFlashcardsCallableResponse> {
  const callable = httpsCallable<
    GenerateFlashcardsCallableRequest,
    GenerateFlashcardsCallableResponse
  >(functions, "generateFlashcards");

  try {
    const { data } = await callable({
      boardId,
      selectionText: opts.selectionText,
      imageDataUrl: opts.imageDataUrl,
      pathIds: opts.pathIds,
    });
    if (!data?.cards?.length) {
      throw new Error("Couldn't generate any flashcards from that selection.");
    }
    return data;
  } catch (e: any) {
    // Preserve `.code` (existing convention — see aiService.ts's identical
    // comment on each of its own AI wrappers) AND `.details` (EG-16, new here).
    throw Object.assign(new Error(e?.message ?? "Failed to generate flashcards."), {
      code: e?.code,
      details: e?.details,
    });
  }
}

// ── decks ───────────────────────────────────────────────────────────────────

function decksRef(uid: string) {
  return collection(db, "users", uid, "decks");
}

function deckDocRef(uid: string, deckId: string) {
  return doc(db, "users", uid, "decks", deckId);
}

function cardsRef(uid: string, deckId: string) {
  return collection(db, "users", uid, "decks", deckId, "cards");
}

function cardDocRef(uid: string, deckId: string, cardId: string) {
  return doc(db, "users", uid, "decks", deckId, "cards", cardId);
}

function mapDeckDoc(id: string, data: any): FlashcardDeck {
  return {
    id,
    schemaVersion: 1,
    name: typeof data?.name === "string" && data.name ? data.name : "Untitled deck",
    boardId: typeof data?.boardId === "string" ? data.boardId : undefined,
    createdAt: data?.createdAt?.toDate?.() ?? new Date(),
  };
}

function mapCardDoc(id: string, data: any): FlashcardCard {
  return {
    id,
    schemaVersion: 1,
    front: typeof data?.front === "string" ? data.front : "",
    back: typeof data?.back === "string" ? data.back : "",
    boardId: typeof data?.boardId === "string" ? data.boardId : undefined,
    repetitions: typeof data?.repetitions === "number" ? data.repetitions : 0,
    intervalDays: typeof data?.intervalDays === "number" ? data.intervalDays : 0,
    easeFactor: typeof data?.easeFactor === "number" ? data.easeFactor : INITIAL_CARD.easeFactor,
    dueAtMs: typeof data?.dueAtMs === "number" ? data.dueAtMs : 0,
  };
}

/** Every deck the user owns, newest first is NOT guaranteed (no orderBy — decks
 *  are few enough per user that client-side sort, if wanted, is cheap; kept
 *  simple here since nothing today depends on an order). */
export async function listDecks(uid: string): Promise<FlashcardDeck[]> {
  const snap = await getDocs(decksRef(uid));
  return snap.docs.map((d) => mapDeckDoc(d.id, d.data()));
}

export async function createDeck(
  uid: string,
  name: string,
  boardId?: string
): Promise<string> {
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    name,
    createdAt: serverTimestamp(),
  };
  if (boardId) payload.boardId = boardId;
  const ref = await addDoc(decksRef(uid), payload);
  return ref.id;
}

/**
 * Finds the caller's existing deck for `boardId` (the board-selection
 * generation flow's default target — "Make flashcards" doesn't ask the user
 * to pick a deck every time), creating one named after the board on first use.
 * Client-side lookup only (no unique-index enforcement): a user generating
 * from the same board from two devices at once could in principle create two
 * decks — an unlikely race whose worst case is a harmless duplicate deck, not
 * a security or data-loss issue, so no transaction is used here.
 */
export async function getOrCreateBoardDeck(
  uid: string,
  boardId: string,
  boardTitle: string
): Promise<string> {
  const existing = await listDecks(uid);
  const found = existing.find((d) => d.boardId === boardId);
  if (found) return found.id;
  return createDeck(uid, boardTitle || "Flashcards", boardId);
}

/** Saves newly generated cards into a deck as brand-new, never-reviewed cards.
 *  Spreads `INITIAL_CARD` (Month 6 — that object is `Object.freeze`d; spreading
 *  makes a new plain object per card rather than mutating the frozen one, per
 *  sm2.ts's own contract) so every card starts at the same SM-2 zero state the
 *  library defines, never a hand-rolled copy that could drift from it. */
export async function addCardsToDeck(
  uid: string,
  deckId: string,
  boardId: string | undefined,
  cards: GeneratedFlashcard[]
): Promise<void> {
  await Promise.all(
    cards.map((c) => {
      const payload: Record<string, unknown> = {
        schemaVersion: 1,
        front: c.front,
        back: c.back,
        ...INITIAL_CARD,
        createdAt: serverTimestamp(),
      };
      if (boardId) payload.boardId = boardId;
      return addDoc(cardsRef(uid, deckId), payload);
    })
  );
}

export async function deleteDeck(uid: string, deckId: string): Promise<void> {
  await deleteDoc(deckDocRef(uid, deckId));
}

// ── the due-cards query ──────────────────────────────────────────────────────

/**
 * Every card in `deckId` whose `dueAtMs` has arrived, oldest-due first. This
 * is the review screen's ONLY data source — see this task's brief: "the real
 * cost is a second app surface: a review screen, per-user scheduling, and a
 * due-cards query." A single-field range filter (`<=`) with a matching
 * `orderBy` on the SAME field needs no composite index.
 */
export async function getDueCards(
  uid: string,
  deckId: string,
  now: number = Date.now()
): Promise<FlashcardCard[]> {
  const q = query(
    cardsRef(uid, deckId),
    where("dueAtMs", "<=", now),
    orderBy("dueAtMs", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => mapCardDoc(d.id, d.data()));
}

/** Every card in a deck, unfiltered — the CSV export's data source (export
 *  means "back up/take this deck to Anki", not "back up only what's due
 *  today"). Kept distinct from `getDueCards`: that one is a real server-side
 *  filtered query and is the review screen's own data source; this is a plain
 *  unfiltered read. */
export async function listCards(uid: string, deckId: string): Promise<FlashcardCard[]> {
  const snap = await getDocs(cardsRef(uid, deckId));
  return snap.docs.map((d) => mapCardDoc(d.id, d.data()));
}

// ── review (CF-15 — validate before scheduling) ─────────────────────────────

/** Thrown by `reviewCard` when a loaded card's schedule fields aren't all
 *  finite numbers. Fails CLOSED: `review()` (src/lib/sm2.ts) does not validate
 *  its `card` argument by design (a pure-arithmetic module has no storage
 *  awareness), so THIS is the boundary that must — this is the caller that
 *  loads cards from storage. A corrupted `easeFactor: NaN` is NOT obviously
 *  broken: sm2.ts's own header notes the first two reviews hardcode their
 *  interval (1, then 6) regardless of ease, so NaN only reaches
 *  `intervalDays`/`dueAtMs` from the THIRD review on — exactly when a new card
 *  is most likely to have accumulated a corruption unnoticed. Never schedule
 *  from a value that merely LOOKS like a number (`typeof NaN === "number"`);
 *  every field is checked with `Number.isFinite` too. */
export class CorruptCardError extends Error {
  constructor(public readonly field: keyof Card) {
    super(`Flashcard has a non-finite "${field}" — refusing to schedule from it.`);
    this.name = "CorruptCardError";
  }
}

const SCHEDULE_FIELDS: (keyof Card)[] = [
  "repetitions",
  "intervalDays",
  "easeFactor",
  "dueAtMs",
];

/** Validates that every SM-2 schedule field on `raw` is a finite number,
 *  throwing `CorruptCardError` on the first violation. Exported so the review
 *  screen can validate a batch up front (skip corrupt cards, keep studying)
 *  rather than only discovering a corruption mid-review. */
export function assertValidSchedule(raw: FlashcardCard): Card {
  for (const field of SCHEDULE_FIELDS) {
    const value = raw[field];
    if (!(typeof value === "number" && Number.isFinite(value))) {
      throw new CorruptCardError(field);
    }
  }
  return {
    repetitions: raw.repetitions,
    intervalDays: raw.intervalDays,
    easeFactor: raw.easeFactor,
    dueAtMs: raw.dueAtMs,
  };
}

/**
 * Reviews one card: loads it, validates its schedule (see `assertValidSchedule`
 * — CF-15), runs `review()` (src/lib/sm2.ts), and persists the result. Throws
 * `CorruptCardError` rather than silently scheduling from bad data — the
 * review screen catches this to skip the card with a visible warning instead
 * of crashing or (worse) writing a NaN-poisoned schedule right back.
 */
export async function reviewCard(
  uid: string,
  deckId: string,
  cardId: string,
  quality: number,
  now: number = Date.now()
): Promise<Card> {
  const snap = await getDoc(cardDocRef(uid, deckId, cardId));
  if (!snap.exists()) {
    throw new Error("Card not found.");
  }
  const current = mapCardDoc(cardId, snap.data());
  const validated = assertValidSchedule(current);
  const next = review(validated, quality, now);
  await updateDoc(cardDocRef(uid, deckId, cardId), {
    repetitions: next.repetitions,
    intervalDays: next.intervalDays,
    easeFactor: next.easeFactor,
    dueAtMs: next.dueAtMs,
  });
  return next;
}

// ── CSV export (Anki-native import; .apkg is cut) ───────────────────────────

/** A field beginning `=`, `+`, `-` or `@` is interpreted as a formula by Excel,
 *  Sheets and LibreOffice — a card whose front/back text starts with one of
 *  these (e.g. a pasted `=HYPERLINK(...)`) would otherwise become a LIVE
 *  formula in whoever opens the export. Prefixing a single quote is the
 *  standard neutralization (OWASP "CSV Injection"): it forces the cell to be
 *  read as literal text in every major spreadsheet app, and Anki's own CSV
 *  importer treats the leading `'` as ordinary text too (it does not evaluate
 *  formulas), so this changes nothing about what a student sees on the card. */
function neutralizeFormulaInjection(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** RFC 4180 field quoting: wrap in quotes (doubling any embedded quote) when
 *  the field contains a comma, a quote, or a newline — otherwise leave it bare. */
function quoteCsvField(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return /[",\n\r]/.test(value) ? `"${escaped}"` : escaped;
}

/** One field, fully escaped: formula-injection neutralization FIRST, then RFC
 *  4180 quoting — quoting must run last since the neutralized (prefixed) value
 *  is what actually gets written, and the quoting check must see any comma/
 *  quote/newline in the ORIGINAL text either way. Exported for direct testing
 *  of both concerns in isolation. */
export function toCsvField(value: string): string {
  return quoteCsvField(neutralizeFormulaInjection(value));
}

/**
 * Renders a deck's cards as a two-column (front, back) CSV — the shape Anki's
 * "Import File" dialog reads natively, so no `.apkg` (SQLite-in-a-zip) is ever
 * built. CRLF row separator per RFC 4180; Anki accepts either line ending.
 */
export function exportDeckToCsv(cards: GeneratedFlashcard[]): string {
  return cards.map((c) => `${toCsvField(c.front)},${toCsvField(c.back)}`).join("\r\n");
}
