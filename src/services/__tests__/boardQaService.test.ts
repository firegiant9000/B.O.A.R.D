// The two feature flags are build-time constants, so they are mocked as lazy
// getters over a mutable object: the getter bodies only run when
// `isBoardQaConfigured()` is actually called, which is inside a test, by which
// point the object exists.
let mockFlags = { BOARD_QA_ENABLED: false, AI_GATEWAY_ENABLED: false };
jest.mock("../../lib/featureFlags", () => ({
  get BOARD_QA_ENABLED() {
    return mockFlags.BOARD_QA_ENABLED;
  },
  get AI_GATEWAY_ENABLED() {
    return mockFlags.AI_GATEWAY_ENABLED;
  },
}));

jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));

const mockCallable = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: () => mockCallable,
}));

import {
  askBoard,
  citationKind,
  isBoardQaConfigured,
  CITATION_KINDS,
  CANVAS_CITATION_KINDS,
} from "../boardQaService";
import { resourceExhaustedReason } from "../quotaService";

const ANSWER = {
  answer: "Chloroplasts.",
  citations: [{ elementId: "n1", elementType: "note", excerpt: "Photosynthesis…" }],
  model: "gpt-4o-mini",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFlags = { BOARD_QA_ENABLED: true, AI_GATEWAY_ENABLED: true };
});

describe("isBoardQaConfigured", () => {
  it("is on only when the feature flag AND the AI gateway are both on", () => {
    mockFlags = { BOARD_QA_ENABLED: true, AI_GATEWAY_ENABLED: true };
    expect(isBoardQaConfigured()).toBe(true);

    // The callable rides the gateway; with the gateway off there is nothing to
    // call, so offering the affordance would only produce a failure.
    mockFlags = { BOARD_QA_ENABLED: true, AI_GATEWAY_ENABLED: false };
    expect(isBoardQaConfigured()).toBe(false);

    mockFlags = { BOARD_QA_ENABLED: false, AI_GATEWAY_ENABLED: true };
    expect(isBoardQaConfigured()).toBe(false);
  });
});

describe("askBoard", () => {
  it("returns the answer and the elements it cited", async () => {
    mockCallable.mockResolvedValueOnce({ data: ANSWER });

    await expect(askBoard("board-1", "Where?")).resolves.toEqual(ANSWER);
  });

  it("sends the board, the question and the prior turns", async () => {
    mockCallable.mockResolvedValueOnce({ data: ANSWER });
    const history = [
      { role: "user" as const, text: "What is this?" },
      { role: "assistant" as const, text: "A cell diagram." },
    ];

    await askBoard("board-1", "And why?", history);

    expect(mockCallable).toHaveBeenCalledWith({
      boardId: "board-1",
      question: "And why?",
      history,
    });
  });

  it("sends an empty thread when none is supplied, rather than omitting the field", async () => {
    mockCallable.mockResolvedValueOnce({ data: ANSWER });

    await askBoard("board-1", "Where?");

    expect(mockCallable).toHaveBeenCalledWith({
      boardId: "board-1",
      question: "Where?",
      history: [],
    });
  });

  it("tolerates a response with no citations — that is a real outcome, not a fault", async () => {
    // "Nothing on this board answers that" comes back as an answer with an
    // empty citation list; a reader that treated it as malformed would turn a
    // correct response into an error.
    mockCallable.mockResolvedValueOnce({
      data: { answer: "I couldn't find anything.", citations: [], model: "text-embedding-3-small" },
    });

    const res = await askBoard("board-1", "Where?");
    expect(res.citations).toEqual([]);
    expect(res.answer).toMatch(/couldn't find/i);
  });

  it("tolerates a malformed or missing citations field without throwing", async () => {
    mockCallable.mockResolvedValueOnce({ data: { answer: "hi", model: "m" } });
    await expect(askBoard("board-1", "Where?")).resolves.toMatchObject({ citations: [] });

    mockCallable.mockResolvedValueOnce({ data: { answer: "hi", citations: "nope", model: "m" } });
    await expect(askBoard("board-1", "Where?")).resolves.toMatchObject({ citations: [] });
  });

  it("preserves details.reason so a caller routes on the server's reason, not a guess", async () => {
    // This is the whole reason this wrapper re-attaches `.details`. Drop it and
    // `resourceExhaustedReason` returns null, the caller falls through to the
    // "reason unknown" branch, and a free-tier user who asked twice quickly is
    // shown an upgrade prompt for a momentary throttle.
    mockCallable.mockRejectedValueOnce(
      Object.assign(new Error("Too many questions right now."), {
        code: "functions/resource-exhausted",
        details: { reason: "rate-limit" },
      })
    );

    const err = await askBoard("board-1", "Where?").catch((e) => e);

    expect(resourceExhaustedReason(err)).toBe("rate-limit");
  });

  it("preserves a plan-quota reason too", async () => {
    mockCallable.mockRejectedValueOnce(
      Object.assign(new Error("Over your limit."), {
        code: "functions/resource-exhausted",
        details: { reason: "plan-quota" },
      })
    );

    const err = await askBoard("board-1", "Where?").catch((e) => e);

    expect(resourceExhaustedReason(err)).toBe("plan-quota");
    expect(err.code).toBe("functions/resource-exhausted");
  });

  it("surfaces the server's message on an ordinary failure", async () => {
    mockCallable.mockRejectedValueOnce(
      Object.assign(new Error("You are not a member of this board."), {
        code: "functions/permission-denied",
      })
    );

    await expect(askBoard("board-1", "Where?")).rejects.toThrow(/not a member/i);
  });

  it("falls back to a readable message when the rejection carries none", async () => {
    mockCallable.mockRejectedValueOnce({});
    await expect(askBoard("board-1", "Where?")).rejects.toThrow(/couldn't answer/i);
  });
});

describe("citationKind", () => {
  it("translates the indexer's vocabulary into the canvas's", () => {
    // These two vocabularies are close enough to look interchangeable and are
    // not: the indexer stamps `textElement`, the canvas calls it `text`. Get
    // this wrong and every text citation resolves to nothing — which on screen
    // is indistinguishable from the element having been deleted.
    expect(citationKind("textElement")).toBe("text");
    expect(citationKind("note")).toBe("note");
    expect(citationKind("path")).toBe("path");
    expect(citationKind("shape")).toBe("shape");
    expect(citationKind("image")).toBe("image");
  });

  it("places a comment thread, which is indexed but is not a canvas element", () => {
    // ROADMAP.md scopes board Q&A over comments as well as board content. A
    // comment citation opens its thread instead of selecting a shape, but it is
    // still placeable and still tappable — returning null here would make every
    // comment citation render as "can't open this".
    expect(citationKind("comment")).toBe("comment");
  });

  it("returns null for a kind this build can't place", () => {
    // Null means "don't offer this as clickable". Guessing would mean matching
    // the wrong element whenever two kinds happened to share an id.
    expect(citationKind("audio")).toBeNull();
    expect(citationKind("")).toBeNull();
  });

  it("maps every CANVAS type to one of the kinds boxOfElement knows", () => {
    // `useBoardElements.boxOfElement` only branches on these five strings; a
    // sixth value here would resolve to null for every element and quietly
    // mark every citation of that kind deleted. `comment` is excluded on
    // purpose — it is resolved against the comment threads, not the canvas.
    const mapped = Object.values(CITATION_KINDS).filter((k) => k !== "comment");
    expect(mapped.length).toBeGreaterThan(0); // guard: a non-empty map
    for (const kind of mapped) {
      expect(CANVAS_CITATION_KINDS).toContain(kind);
    }
  });

  it("keeps comment off the canvas-kind list — it has no box to resolve", () => {
    // If it drifted onto that list, the board screen's canvas branch would try
    // `boxOfElement` on a comment id, find nothing, and report every comment
    // citation as deleted.
    expect(CANVAS_CITATION_KINDS).not.toContain("comment");
    expect(CANVAS_CITATION_KINDS).toEqual(
      expect.arrayContaining(["path", "shape", "text", "image", "note"])
    );
  });
});
