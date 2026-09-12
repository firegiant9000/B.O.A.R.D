jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

// `jest.requireActual` on the service below loads the REAL module, whose own
// `require`s still go through the registry — so the Firebase entry points it
// imports have to be stubbed here too, or `@firebase/util`'s ESM build reaches
// the transform and the suite fails to parse before a single test runs.
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
jest.mock("firebase/functions", () => ({ httpsCallable: () => jest.fn() }));

const mockAskBoard = jest.fn();
jest.mock("../../services/boardQaService", () => ({
  ...jest.requireActual("../../services/boardQaService"),
  askBoard: (...args: unknown[]) => mockAskBoard(...args),
}));

import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import BoardQaPanel, { citationState } from "../BoardQaPanel";
import type { BoardQaCitation } from "../../services/boardQaService";

/**
 * BoardQaPanel — the Month 6 board Q&A chat surface.
 *
 * `boardQaService.askBoard` is mocked (the callable is not this component's
 * concern) but `citationKind` is the REAL implementation, because the
 * citation-liveness decision is the thing most worth getting right here and a
 * mocked mapping would have proved nothing about it.
 */

const NOTE: BoardQaCitation = {
  elementId: "n1",
  elementType: "note",
  excerpt: "Photosynthesis happens in chloroplasts.",
};

function renderPanel(
  over: {
    isCitationLive?: (id: string, kind: string) => boolean;
    onSelectCitation?: jest.Mock;
    onQuotaExceeded?: jest.Mock;
    onClose?: jest.Mock;
  } = {}
) {
  const onQuotaExceeded = over.onQuotaExceeded ?? jest.fn();
  const onSelectCitation = over.onSelectCitation ?? jest.fn();
  const onClose = over.onClose ?? jest.fn();
  const utils = render(
    <BoardQaPanel
      visible
      boardId="board-1"
      onClose={onClose}
      isCitationLive={over.isCitationLive}
      onSelectCitation={onSelectCitation}
      onQuotaExceeded={onQuotaExceeded}
    />
  );
  return { ...utils, onQuotaExceeded, onSelectCitation, onClose };
}

async function ask(utils: ReturnType<typeof renderPanel>, question: string) {
  fireEvent.changeText(utils.getByTestId("board-qa-input"), question);
  fireEvent.press(utils.getByTestId("board-qa-send"));
  await waitFor(() => expect(mockAskBoard).toHaveBeenCalled());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAskBoard.mockResolvedValue({
    answer: "In the chloroplasts.",
    citations: [NOTE],
    model: "gpt-4o-mini",
  });
});

describe("BoardQaPanel — asking", () => {
  it("shows the question and the answer as a thread", async () => {
    const utils = renderPanel();
    await ask(utils, "Where does photosynthesis happen?");

    expect(await utils.findByText("In the chloroplasts.")).toBeTruthy();
    expect(utils.getByText("Where does photosynthesis happen?")).toBeTruthy();
  });

  it("asks about THIS board", async () => {
    const utils = renderPanel();
    await ask(utils, "Where?");
    expect(mockAskBoard).toHaveBeenCalledWith("board-1", "Where?", []);
  });

  it("replays the prior turns on a follow-up, so 'why?' resolves", async () => {
    const utils = renderPanel();
    await ask(utils, "Where?");
    await utils.findByText("In the chloroplasts.");

    mockAskBoard.mockResolvedValueOnce({
      answer: "Because that's where chlorophyll is.",
      citations: [],
      model: "gpt-4o-mini",
    });
    fireEvent.changeText(utils.getByTestId("board-qa-input"), "Why?");
    fireEvent.press(utils.getByTestId("board-qa-send"));

    await waitFor(() => expect(mockAskBoard).toHaveBeenCalledTimes(2));
    // The second call carries the first exchange — and does NOT repeat the new
    // question inside the history, which would double it in the prompt.
    expect(mockAskBoard.mock.calls[1]).toEqual([
      "board-1",
      "Why?",
      [
        { role: "user", text: "Where?" },
        { role: "assistant", text: "In the chloroplasts." },
      ],
    ]);
  });

  it("does not send a blank question", () => {
    const utils = renderPanel();
    fireEvent.changeText(utils.getByTestId("board-qa-input"), "   ");
    fireEvent.press(utils.getByTestId("board-qa-send"));
    expect(mockAskBoard).not.toHaveBeenCalled();
  });
});

describe("BoardQaPanel — a denial is routed on the server's reason, never inferred", () => {
  it("sends a plan-quota denial to the upsell", async () => {
    mockAskBoard.mockRejectedValueOnce(
      Object.assign(new Error("Over your limit."), {
        code: "functions/resource-exhausted",
        details: { reason: "plan-quota" },
      })
    );
    const utils = renderPanel();
    await ask(utils, "Where?");

    await waitFor(() => expect(utils.onQuotaExceeded).toHaveBeenCalledTimes(1));
  });

  it("shows a wait-and-retry note for a throttle — and does NOT open the upsell", async () => {
    // The failure this distinction exists to prevent: a free-tier user who
    // asked twice quickly being told to pay.
    mockAskBoard.mockRejectedValueOnce(
      Object.assign(new Error("Too many questions right now."), {
        code: "functions/resource-exhausted",
        details: { reason: "rate-limit" },
      })
    );
    const utils = renderPanel();
    await ask(utils, "Where?");

    expect(await utils.findByTestId("board-qa-error")).toHaveTextContent(/wait a few seconds/i);
    expect(utils.onQuotaExceeded).not.toHaveBeenCalled();
  });

  it("shows an ordinary failure's own message, and still does not open the upsell", async () => {
    mockAskBoard.mockRejectedValueOnce(new Error("Network unavailable."));
    const utils = renderPanel();
    await ask(utils, "Where?");

    expect(await utils.findByTestId("board-qa-error")).toHaveTextContent(/network unavailable/i);
    expect(utils.onQuotaExceeded).not.toHaveBeenCalled();
  });
});

describe("BoardQaPanel — citations are checkable", () => {
  it("offers a live citation as something to tap", async () => {
    const utils = renderPanel({ isCitationLive: () => true });
    await ask(utils, "Where?");

    const chip = await utils.findByTestId("board-qa-citation-n1");
    fireEvent.press(chip);
    // The CANVAS kind, not the indexer's — this is the translation that makes
    // the id resolvable at the other end.
    expect(utils.onSelectCitation).toHaveBeenCalledWith("n1", "note");
  });

  it("passes the canvas kind for a text element, not the indexed type", async () => {
    mockAskBoard.mockResolvedValueOnce({
      answer: "See the label.",
      citations: [{ elementId: "t1", elementType: "textElement", excerpt: "A label" }],
      model: "gpt-4o-mini",
    });
    const utils = renderPanel({ isCitationLive: () => true });
    await ask(utils, "Where?");

    fireEvent.press(await utils.findByTestId("board-qa-citation-t1"));
    expect(utils.onSelectCitation).toHaveBeenCalledWith("t1", "text");
  });

  it("says so, visibly, when the cited element has been deleted", async () => {
    // The server drops candidates whose element is already gone, but cleanup is
    // eventually consistent and the element can also be deleted between the
    // answer arriving and the tap. A chip that silently did nothing here would
    // be indistinguishable, to the reader, from the model having invented the
    // content — which is exactly what citing ids is supposed to rule out.
    const utils = renderPanel({ isCitationLive: () => false });
    await ask(utils, "Where?");

    const chip = await utils.findByTestId("board-qa-citation-n1");
    expect(chip).toHaveTextContent(/deleted/i);
    fireEvent.press(chip);
    expect(utils.onSelectCitation).not.toHaveBeenCalled();
  });

  it("asks about liveness using the canvas kind the caller can actually look up", async () => {
    const isCitationLive = jest.fn(() => true);
    const utils = renderPanel({ isCitationLive });
    await ask(utils, "Where?");

    await utils.findByTestId("board-qa-citation-n1");
    expect(isCitationLive).toHaveBeenCalledWith("n1", "note");
  });

  it("won't offer a citation whose element kind it cannot place", async () => {
    mockAskBoard.mockResolvedValueOnce({
      answer: "From the recording.",
      citations: [{ elementId: "a1", elementType: "audio", excerpt: "spoken words" }],
      model: "gpt-4o-mini",
    });
    const utils = renderPanel({ isCitationLive: () => true });
    await ask(utils, "Where?");

    const chip = await utils.findByTestId("board-qa-citation-a1");
    expect(chip).toHaveTextContent(/can't open/i);
    fireEvent.press(chip);
    expect(utils.onSelectCitation).not.toHaveBeenCalled();
  });

  it("renders an answer with no citations without a 'From:' block", async () => {
    mockAskBoard.mockResolvedValueOnce({
      answer: "I couldn't find anything on this board that answers that.",
      citations: [],
      model: "text-embedding-3-small",
    });
    const utils = renderPanel();
    await ask(utils, "Where?");

    await utils.findByText(/couldn't find anything/i);
    expect(utils.queryByText("From:")).toBeNull();
  });
});

describe("citationState", () => {
  it("is live for a placeable kind the resolver confirms", () => {
    expect(citationState(NOTE, () => true)).toBe("live");
  });

  it("is deleted for a placeable kind the resolver denies", () => {
    expect(citationState(NOTE, () => false)).toBe("deleted");
  });

  it("is unresolvable for a kind this build cannot place, whatever the resolver says", () => {
    // Checked BEFORE the resolver: an unknown kind has no canvas kind to look
    // up, so a resolver answering `true` for it would be answering about
    // nothing.
    const audio = { elementId: "a1", elementType: "audio", excerpt: "…" };
    expect(citationState(audio, () => true)).toBe("unresolvable");
    expect(citationState(audio, () => false)).toBe("unresolvable");
  });

  it("assumes live when no resolver was supplied at all", () => {
    // Marking every citation deleted outside a board screen would be a louder
    // and more misleading claim than the one it avoids.
    expect(citationState(NOTE)).toBe("live");
  });
});
