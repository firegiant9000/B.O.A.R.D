jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
const mockCallable = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: () => mockCallable,
}));

import * as fs from "firebase/firestore";
import { makeDocSnap, makeQuerySnap } from "../../test-utils/firestoreMock";
import * as flashcardService from "../flashcardService";
import { CorruptCardError } from "../flashcardService";
import { INITIAL_CARD } from "../../lib/sm2";
import type { FlashcardCard } from "../../types";

const addDoc = fs.addDoc as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const query = fs.query as jest.Mock;
const where = fs.where as jest.Mock;
const orderBy = fs.orderBy as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

function makeCardData(overrides: Partial<FlashcardCard> = {}) {
  return {
    front: "Q",
    back: "A",
    repetitions: 0,
    intervalDays: 0,
    easeFactor: 2.5,
    dueAtMs: 0,
    ...overrides,
  };
}

// ── generation wrapper ──────────────────────────────────────────────────────

describe("generateFlashcards", () => {
  it("returns the callable's cards on the happy path", async () => {
    mockCallable.mockResolvedValueOnce({
      data: { cards: [{ front: "Q1", back: "A1" }], model: "gpt-4o-mini", cached: false },
    });
    const res = await flashcardService.generateFlashcards("board-1", { selectionText: "notes" });
    expect(res.cards).toEqual([{ front: "Q1", back: "A1" }]);
  });

  it("throws when the callable returns no cards", async () => {
    mockCallable.mockResolvedValueOnce({ data: { cards: [], model: "gpt-4o-mini", cached: false } });
    await expect(
      flashcardService.generateFlashcards("board-1", { selectionText: "notes" })
    ).rejects.toThrow(/couldn't generate/i);
  });

  // EG-16 — this is the field aiService's own OCR/explain/diagram wrappers do
  // NOT preserve (they keep only `.code`); this wrapper must, since
  // generateFlashcards is the one callable that attaches it from the start.
  it("preserves both .code and .details on a resource-exhausted rejection", async () => {
    mockCallable.mockRejectedValueOnce(
      Object.assign(new Error("Your workspace has reached its AI usage limit."), {
        code: "functions/resource-exhausted",
        details: { reason: "plan-quota" },
      })
    );
    const err: any = await flashcardService
      .generateFlashcards("board-1", { selectionText: "notes" })
      .catch((e) => e);
    expect(err.code).toBe("functions/resource-exhausted");
    expect(err.details).toEqual({ reason: "plan-quota" });
  });

  it("preserves a rate-limit reason distinctly from a plan-quota reason", async () => {
    mockCallable.mockRejectedValueOnce(
      Object.assign(new Error("Too many AI requests right now."), {
        code: "functions/resource-exhausted",
        details: { reason: "rate-limit" },
      })
    );
    const err: any = await flashcardService
      .generateFlashcards("board-1", { selectionText: "notes" })
      .catch((e) => e);
    expect(err.details).toEqual({ reason: "rate-limit" });
  });
});

// ── decks ────────────────────────────────────────────────────────────────────

describe("decks", () => {
  it("lists a user's decks", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["deck1", { name: "Biology", boardId: "b1" }]])
    );
    const decks = await flashcardService.listDecks("u1");
    expect(decks).toEqual([
      expect.objectContaining({ id: "deck1", name: "Biology", boardId: "b1" }),
    ]);
  });

  it("creates a deck with schemaVersion 1", async () => {
    addDoc.mockResolvedValueOnce({ id: "newDeck" });
    const id = await flashcardService.createDeck("u1", "Chemistry");
    expect(id).toBe("newDeck");
    expect(addDoc.mock.calls[0][1]).toMatchObject({ schemaVersion: 1, name: "Chemistry" });
  });

  it("reuses an existing board deck rather than creating a second one", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["deck1", { name: "Biology 101", boardId: "board-1" }]])
    );
    const id = await flashcardService.getOrCreateBoardDeck("u1", "board-1", "Biology 101");
    expect(id).toBe("deck1");
    expect(addDoc).not.toHaveBeenCalled();
  });

  it("creates a new board deck when none exists yet for that board", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    addDoc.mockResolvedValueOnce({ id: "freshDeck" });
    const id = await flashcardService.getOrCreateBoardDeck("u1", "board-2", "Physics");
    expect(id).toBe("freshDeck");
    expect(addDoc.mock.calls[0][1]).toMatchObject({ name: "Physics", boardId: "board-2" });
  });

  it("saves generated cards spreading INITIAL_CARD's zero schedule state", async () => {
    addDoc.mockResolvedValue({ id: "card1" });
    await flashcardService.addCardsToDeck("u1", "deck1", "board-1", [
      { front: "Q1", back: "A1" },
      { front: "Q2", back: "A2" },
    ]);
    expect(addDoc).toHaveBeenCalledTimes(2);
    expect(addDoc.mock.calls[0][1]).toMatchObject({
      front: "Q1",
      back: "A1",
      boardId: "board-1",
      ...INITIAL_CARD,
    });
  });

  it("deletes a deck", async () => {
    await flashcardService.deleteDeck("u1", "deck1");
    expect(deleteDoc).toHaveBeenCalledTimes(1);
  });
});

// ── the due-cards query ──────────────────────────────────────────────────────

describe("getDueCards", () => {
  it("queries dueAtMs <= now, ordered ascending, and maps the results", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["card1", makeCardData({ dueAtMs: 100 })],
        ["card2", makeCardData({ dueAtMs: 200 })],
      ])
    );

    const cards = await flashcardService.getDueCards("u1", "deck1", 1000);

    expect(where).toHaveBeenCalledWith("dueAtMs", "<=", 1000);
    expect(orderBy).toHaveBeenCalledWith("dueAtMs", "asc");
    expect(cards.map((c) => c.id)).toEqual(["card1", "card2"]);
  });

  it("returns an empty list when nothing is due", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    const cards = await flashcardService.getDueCards("u1", "deck1", 1000);
    expect(cards).toEqual([]);
  });

  // If the query stopped filtering by dueAtMs (e.g. someone "simplified" this
  // to a bare collection read), this assertion on the actual `where` call
  // would fail — it does not merely inspect the mocked return value.
  it("does not filter on anything but dueAtMs", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    await flashcardService.getDueCards("u1", "deck1", 1000);
    expect(where).toHaveBeenCalledTimes(1);
  });
});

describe("listCards", () => {
  it("returns every card in the deck, unfiltered", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["card1", makeCardData({ dueAtMs: 0 })],
        ["card2", makeCardData({ dueAtMs: 9_999_999_999 })],
      ])
    );
    const cards = await flashcardService.listCards("u1", "deck1");
    expect(cards.map((c) => c.id)).toEqual(["card1", "card2"]);
    // Unlike getDueCards, this reads the bare collection — no where() filter.
    expect(where).not.toHaveBeenCalled();
  });
});

// ── review (CF-15) ───────────────────────────────────────────────────────────

describe("reviewCard", () => {
  it("loads the card, schedules it via review(), and persists the result", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("card1", makeCardData({ repetitions: 0, intervalDays: 0, easeFactor: 2.5, dueAtMs: 0 }))
    );
    const next = await flashcardService.reviewCard("u1", "deck1", "card1", 5, 1_000_000);
    expect(next.repetitions).toBe(1);
    expect(next.intervalDays).toBe(1);
    expect(updateDoc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repetitions: 1,
        intervalDays: 1,
        dueAtMs: 1_000_000 + 86_400_000,
      })
    );
  });

  it("throws Card not found for a missing card, without writing anything", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("card1", null));
    await expect(flashcardService.reviewCard("u1", "deck1", "card1", 5, 0)).rejects.toThrow(
      /not found/i
    );
    expect(updateDoc).not.toHaveBeenCalled();
  });

  // CF-15 — the exact scenario sm2.ts's own header warns about: a NaN
  // easeFactor produces a NORMAL-LOOKING interval (1) on a first review, so
  // "we'd notice because it'd be NaN" is false. This must be caught BEFORE
  // review() ever runs, not discovered from a corrupted write afterward.
  it("fails closed on a corrupted easeFactor rather than silently scheduling from it", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("card1", makeCardData({ easeFactor: NaN }))
    );
    await expect(flashcardService.reviewCard("u1", "deck1", "card1", 5, 0)).rejects.toBeInstanceOf(
      CorruptCardError
    );
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("fails closed on a non-finite dueAtMs (Infinity)", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("card1", makeCardData({ dueAtMs: Infinity }))
    );
    await expect(flashcardService.reviewCard("u1", "deck1", "card1", 5, 0)).rejects.toBeInstanceOf(
      CorruptCardError
    );
  });

  it("accepts a legitimately-zero schedule (a brand-new card) without treating 0 as missing", async () => {
    // typeof 0 === "number" && Number.isFinite(0) — must NOT be confused with
    // "falsy therefore invalid". This is the mirror image of the NaN case.
    getDoc.mockResolvedValueOnce(
      makeDocSnap("card1", makeCardData({ repetitions: 0, intervalDays: 0, easeFactor: 2.5, dueAtMs: 0 }))
    );
    await expect(
      flashcardService.reviewCard("u1", "deck1", "card1", 5, 0)
    ).resolves.toMatchObject({ repetitions: 1 });
  });
});

// ── CSV export ────────────────────────────────────────────────────────────────

describe("exportDeckToCsv", () => {
  it("renders a plain two-column CSV for ordinary cards", () => {
    const csv = flashcardService.exportDeckToCsv([
      { front: "Capital of France", back: "Paris" },
      { front: "2+2", back: "4" },
    ]);
    expect(csv).toBe("Capital of France,Paris\r\n2+2,4");
  });

  it("quotes a field containing an embedded comma", () => {
    expect(flashcardService.toCsvField("a,b")).toBe('"a,b"');
  });

  it("quotes and doubles an embedded quote", () => {
    expect(flashcardService.toCsvField('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes a field containing an embedded newline", () => {
    expect(flashcardService.toCsvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("leaves an ordinary field completely unquoted", () => {
    expect(flashcardService.toCsvField("Mitochondria")).toBe("Mitochondria");
  });

  // Security surface, not formatting: a leading =/+/-/@ must never survive
  // into the export unescaped, or it becomes a live formula for whoever opens
  // it in Excel/Sheets/LibreOffice.
  it.each(["=", "+", "-", "@"])(
    "neutralizes formula injection for a field starting with %s",
    (trigger) => {
      const field = flashcardService.toCsvField(`${trigger}HYPERLINK("evil.com","click")`);
      // Wrapped in quotes (it contains commas/quotes too) with a leading
      // apostrophe INSIDE the quotes, immediately before the original trigger
      // character — never a bare leading =/+/-/@ at the top level.
      expect(field.startsWith(`"'${trigger}`)).toBe(true);
      expect(field.startsWith(trigger)).toBe(false);
    }
  );

  it("neutralizes a formula-injection front field end-to-end through exportDeckToCsv", () => {
    const csv = flashcardService.exportDeckToCsv([
      { front: '=HYPERLINK("http://evil.test","click me")', back: "safe back" },
    ]);
    const firstField = csv.split(",")[0];
    expect(firstField.startsWith('"\'=')).toBe(true);
  });

  it("does not alter a field that merely CONTAINS = elsewhere (not a leading trigger)", () => {
    expect(flashcardService.toCsvField("E = mc^2")).toBe("E = mc^2");
  });
});
