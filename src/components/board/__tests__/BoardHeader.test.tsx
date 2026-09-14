jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../../MemberList", () => ({ __esModule: true, default: () => null }));
jest.mock("../../BoardUserBar", () => ({ __esModule: true, default: () => null }));
// Mock the whole service module (not firebase/firestore directly) — same
// convention AudioAffordance.test.tsx uses for its own single-predicate
// dependency on a firebase-backed service.
jest.mock("../../../services/workspaceService", () => ({
  canUsePresenter: jest.fn((plan: string) => plan !== "free"),
}));

import * as fs from "fs";
import * as path from "path";
import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import BoardHeader from "../BoardHeader";

/**
 * BoardHeader — the Month 6 board Q&A entry point.
 *
 * This is the only affordance that opens the chat panel, so it is the only
 * thing standing between a working feature and one that ships unreachable.
 * `app/board/[id].tsx` cannot be imported under this Jest config, so the last
 * link in the chain (screen → these props) is pinned by a source scan at the
 * bottom of this file rather than by rendering.
 */

function renderHeader(over: Partial<React.ComponentProps<typeof BoardHeader>> = {}) {
  const onOpenBoardQa = jest.fn();
  const onShare = jest.fn();
  const utils = render(
    <BoardHeader
      boardId="board-1"
      boardTitle="Board"
      onBack={jest.fn()}
      memberUids={[]}
      currentUserId="u1"
      presence={[]}
      currentUser={{ uid: "u1", displayName: "U", email: "u@example.test" }}
      blockedIds={[]}
      onBlock={jest.fn()}
      onAdminChanged={jest.fn()}
      followingId={null}
      onFollow={jest.fn()}
      onOpenBackgroundPicker={jest.fn()}
      onOpenHistory={jest.fn()}
      diagramEnabled={false}
      onShare={onShare}
      isAdmin={false}
      hasActiveSession={false}
      endingSession={false}
      onEndSession={jest.fn()}
      onStartSession={jest.fn()}
      isPresenting={false}
      isPresenterPaused={false}
      onStartPresenting={jest.fn()}
      onStopPresenting={jest.fn()}
      onPausePresenting={jest.fn()}
      onResumePresenting={jest.fn()}
      boardQaEnabled
      onOpenBoardQa={onOpenBoardQa}
      {...over}
    />
  );
  return { ...utils, onOpenBoardQa, onShare };
}

describe("BoardHeader — board Q&A entry point (Month 6)", () => {
  it("offers the button when the feature is configured", () => {
    const { getByTestId } = renderHeader();
    expect(getByTestId("board-header-qa")).toBeTruthy();
  });

  it("opens the panel when pressed", () => {
    const { getByTestId, onOpenBoardQa } = renderHeader();
    fireEvent.press(getByTestId("board-header-qa"));
    expect(onOpenBoardQa).toHaveBeenCalledTimes(1);
  });

  it("hides the button when the feature is off", () => {
    const { queryByTestId } = renderHeader({ boardQaEnabled: false });
    expect(queryByTestId("board-header-qa")).toBeNull();
  });

  it("hides it when no handler was supplied, rather than rendering a dead button", () => {
    const { queryByTestId } = renderHeader({ onOpenBoardQa: undefined });
    expect(queryByTestId("board-header-qa")).toBeNull();
  });

  it("renders the rest of the header either way", () => {
    // The positive control for the two negative cases above: a header that
    // failed to render at all would satisfy them just as well.
    const { getByText } = renderHeader({ boardQaEnabled: false, boardTitle: "My board" });
    expect(getByText("My board")).toBeTruthy();
  });

  it("is NOT hidden by the presenter lock — asking a question creates no content", () => {
    // The diagram button is suppressed while someone is presenting because it
    // writes elements. A question only reads, so there is nothing for the lock
    // to protect, and this header has no presenter branch for it at all.
    const { getByTestId } = renderHeader({ isPresenting: true, isPresenterPaused: false });
    expect(getByTestId("board-header-qa")).toBeTruthy();
  });
});

describe("BoardHeader — presenter Pro gate (Fix Wave F2)", () => {
  it("a free-plan admin sees the Pro badge, and pressing it routes to the upgrade flow instead of presenting", () => {
    const onStartPresenting = jest.fn();
    const onUpgradeRequested = jest.fn();
    const { getByTestId } = renderHeader({
      isAdmin: true,
      plan: "free",
      onStartPresenting,
      onUpgradeRequested,
    });
    expect(getByTestId("board-header-presenter-pro-badge")).toBeTruthy();
    fireEvent.press(getByTestId("board-header-presenter-pro-badge"));
    expect(onUpgradeRequested).toHaveBeenCalledTimes(1);
    expect(onStartPresenting).not.toHaveBeenCalled();
  });

  it("a free-plan admin pressing the Present button itself ALSO routes to upgrade, not to presenting", () => {
    // The badge is a second affordance beside the real button, not a
    // replacement for it — a free user must not be able to dodge the gate
    // by pressing "Present" instead of the badge.
    const onStartPresenting = jest.fn();
    const onUpgradeRequested = jest.fn();
    const { getByText } = renderHeader({
      isAdmin: true,
      plan: "free",
      onStartPresenting,
      onUpgradeRequested,
    });
    fireEvent.press(getByText("Present"));
    expect(onUpgradeRequested).toHaveBeenCalledTimes(1);
    expect(onStartPresenting).not.toHaveBeenCalled();
  });

  it("a pro-plan admin sees no Pro badge and starts presenting normally", () => {
    const onStartPresenting = jest.fn();
    const { getByText, queryByTestId } = renderHeader({
      isAdmin: true,
      plan: "pro",
      onStartPresenting,
    });
    expect(queryByTestId("board-header-presenter-pro-badge")).toBeNull();
    fireEvent.press(getByText("Present"));
    expect(onStartPresenting).toHaveBeenCalledTimes(1);
  });

  it("does NOT default an omitted plan to \"free\" — unknown fails open (C1)", () => {
    // This is the exact inversion of what this test asserted before the
    // final correction: an omitted plan used to default to "free" (gating),
    // which is precisely what withdrew presenter from every paying admin on
    // every board load (`app/board/[id].tsx`'s `?? "free"` fallback). See
    // the "reached via the real boardWorkspace derivation" describe below
    // for why `undefined` actually arises in production and why it must
    // NOT gate.
    const onStartPresenting = jest.fn();
    const { getByText, queryByTestId } = renderHeader({
      isAdmin: true,
      plan: undefined,
      onStartPresenting,
    });
    expect(queryByTestId("board-header-presenter-pro-badge")).toBeNull();
    fireEvent.press(getByText("Present"));
    expect(onStartPresenting).toHaveBeenCalledTimes(1);
  });
});

describe("BoardHeader — presenter gate reached via the real boardWorkspace derivation (C1)", () => {
  // `app/board/[id].tsx` cannot be rendered in this Jest config (see the
  // screen-source-scan describe below), so these tests cannot mount the
  // screen itself. Instead each `workspace` fixture below stands in for
  // `useBoardDocument.ts`'s `boardWorkspace`, and `plan` is computed the
  // exact way `app/board/[id].tsx:686` computes it post-fix —
  // `workspace?.plan`, with NO `?? "free"` fallback. That is what
  // distinguishes these three from the plain-literal tests above: they prove
  // the gate behaves correctly for the actual *shapes* `boardWorkspace`
  // takes on in production (`null`, however it got there, or a resolved
  // `Workspace`), not just for a hand-picked `plan` string.

  // (1) Previously two tests, "(1) an unresolved workspace (getWorkspace
  // still in flight)" and "(2) a legacy board with no workspace at all",
  // whose fixtures were byte-identical — two names claiming two coverages
  // that one fixture provided. Merged rather than made distinct, because
  // there is nothing to distinguish: `useBoardDocument.ts` initialises
  // `boardWorkspace` to `null` (:115), sets it to `null` in the
  // `getWorkspace` rejection path (:167) AND in the no-`workspaceId` branch
  // (:171). All three production shapes reach this component as exactly one
  // value, so one fixture is the honest coverage — driving (1) through a
  // pending fetch would only prove that `null` is still `null` while the
  // promise is open.
  it("(1) a null workspace — unresolved, failed, or legacy alike — can present, with no Pro badge", () => {
    // Cast (not a plain `const x: T | null = null`) so TS types this as the
    // union, not narrows it to the `null` literal — the point is to mirror
    // `boardWorkspace?.plan`'s real, not-yet-narrowed shape.
    const workspace = null as { plan: "free" | "pro" | "edu" } | null;
    const onStartPresenting = jest.fn();
    const { getByText, queryByTestId } = renderHeader({
      isAdmin: true,
      plan: workspace?.plan,
      onStartPresenting,
    });
    expect(queryByTestId("board-header-presenter-pro-badge")).toBeNull();
    fireEvent.press(getByText("Present"));
    expect(onStartPresenting).toHaveBeenCalledTimes(1);
  });

  it('(2) a workspace KNOWN to be "free" still gates — the gap F2 closed stays closed', () => {
    const workspace = { plan: "free" as const };
    const onStartPresenting = jest.fn();
    const onUpgradeRequested = jest.fn();
    const { getByText, getByTestId } = renderHeader({
      isAdmin: true,
      plan: workspace?.plan,
      onStartPresenting,
      onUpgradeRequested,
    });
    expect(getByTestId("board-header-presenter-pro-badge")).toBeTruthy();
    fireEvent.press(getByText("Present"));
    expect(onUpgradeRequested).toHaveBeenCalledTimes(1);
    expect(onStartPresenting).not.toHaveBeenCalled();
  });

  it("(3) a Pro workspace is still ungated", () => {
    const workspace = { plan: "pro" as const };
    const onStartPresenting = jest.fn();
    const { getByText, queryByTestId } = renderHeader({
      isAdmin: true,
      plan: workspace?.plan,
      onStartPresenting,
    });
    expect(queryByTestId("board-header-presenter-pro-badge")).toBeNull();
    fireEvent.press(getByText("Present"));
    expect(onStartPresenting).toHaveBeenCalledTimes(1);
  });
});

describe("board Q&A is reachable from the board screen", () => {
  // `app/board/[id].tsx` cannot be imported here (`expo-font` is unresolvable
  // through `@expo/vector-icons`, and `@firebase/util` ships ESM this transform
  // does not handle), so the screen's own wiring is checked as source text.
  // Without this, both halves above could stay green while nothing on the
  // screen ever passed the props — a component nobody can reach.
  const screen = fs.readFileSync(
    path.join(__dirname, "../../../../app/board/[id].tsx"),
    "utf8"
  );

  it("reads as a non-empty screen (guard: the scan below isn't vacuous)", () => {
    expect(screen).toContain("<BoardHeader");
    expect(screen).toContain("<BoardModals");
  });

  it("passes the header's Q&A props from the screen", () => {
    expect(screen).toMatch(/boardQaEnabled=\{isBoardQaConfigured\(\)\}/);
    expect(screen).toMatch(/onOpenBoardQa=\{\(\) => setBoardQaVisible\(true\)\}/);
  });

  // The three assertions below tracked `setUpsellResource("…")` until the
  // soft/hard cadence (ROADMAP.md:608 item 14) replaced that `useState` setter
  // with `useUpsellCadence`'s `show`, which additionally resolves how hard the
  // modal pushes. Only the spelling of the call moved; what is pinned — that
  // each of these denials routes to the shared upsell rather than a bespoke
  // error — is unchanged, and the new assertion below this group makes the set
  // STRICTLY tighter than it was: it now also pins that NO gate on the screen
  // bypasses the cadence, which nothing checked before.
  it("routes a presenter plan denial to the same upsell as every other quota denial (Fix Wave F2)", () => {
    expect(screen).toMatch(/onUpgradeRequested=\{\(\) => upsell\.show\("presenter"\)\}/);
  });

  it("passes the presenter plan without the \"?? free\" fallback (C1 — fail open on unknown)", () => {
    expect(screen).toMatch(
      /plan=\{doc\.boardWorkspace\?\.plan\}\s*\n\s*onUpgradeRequested=\{\(\) => upsell\.show\("presenter"\)\}/
    );
  });

  it("routes EVERY gate on this screen through the cadence hook, leaving no path that shows the full sell on a first attempt", () => {
    // The regression this closes, and the reason it is worth a source scan:
    // the cadence is opt-in per call site. A seventh gate added later that
    // reached for the old `setUpsellResource` shape — or a merge that restored
    // one of the six — would push hard on a user's first encounter with it,
    // and no rendering test would notice, because the modal would be doing
    // exactly what it was told. Counted, not merely matched, so dropping a
    // call site fails here too.
    expect(screen).not.toMatch(/setUpsellResource/);
    expect(screen.match(/upsell\.show\(/g)).toHaveLength(6);
    expect(screen).toMatch(/upsellResource=\{upsell\.resource\}/);
    expect(screen).toMatch(/upsellVariant=\{upsell\.variant\}/);
    expect(screen).toMatch(/onDismissUpsell=\{upsell\.dismiss\}/);
  });

  it("passes the voice-note plan without the \"?? free\" fallback (fails open on unknown)", () => {
    // The second call site of the SAME defect C1 was convened to remove. The
    // screen's `plan` prop on BoardCanvas is threaded to BoardOverlayLayer
    // and on to AudioAffordance, where `audioService.canRecordVoiceNotes` is
    // the ONLY gate on the mic — so coercing an unresolved workspace to
    // "free" here showed a paying customer a locked mic for the entire board
    // session (`useBoardDocument.ts`'s `loadBoard` nulls `boardWorkspace` on
    // a `getWorkspace` rejection and runs once per boardId with no retry),
    // and showed it transiently on every board load.
    expect(screen).toMatch(
      /plan=\{doc\.boardWorkspace\?\.plan\}\s*\n\s*canEdit=\{doc\.canEdit\}/
    );
  });

  it("leaves the custom-palette plan read on \"?? free\" unchanged (C1 confinement)", () => {
    // ONE read still coerces, and this pins that it is deliberate rather
    // than missed. It is ColorPickerModal's `plan` prop, and it is genuinely
    // unlike the two above: the affordance it feeds is
    // `canAddSwatch = canUseSwatches && canManageWorkspace && !atSwatchCap`
    // (ColorPickerModal.tsx), and `canManageWorkspace` is computed on this
    // same screen from `doc.boardWorkspace ? getWorkspaceRole(...) :
    // undefined` → `canManageMembers(undefined)` → `false`. So while the
    // workspace is unresolved the add-swatch button is already disabled by
    // the ROLE gate, whatever the plan says — the coercion cannot withdraw a
    // working feature the way the presenter and voice-note ones did.
    //
    // What it DOES change is the disabled button's accessibility label:
    // `!canUseSwatches` wins the ternary, so a Pro admin mid-fetch is told
    // "Custom swatches are a Pro feature" rather than "Only a workspace
    // owner or admin can add swatches". A wrong REASON on an
    // already-disabled control, not a lost capability — which is why it is
    // out of scope here rather than fine. Do not raise the count back to 2
    // to "match" the others; the other two are fixed.
    expect(screen.match(/plan=\{doc\.boardWorkspace\?\.plan \?\? "free"\}/g)).toHaveLength(1);
  });

  it("passes the panel's visibility and citation wiring from the screen", () => {
    expect(screen).toMatch(/boardQaVisible=\{boardQaVisible\}/);
    expect(screen).toMatch(/isCitationLive=\{isCitationLive\}/);
    expect(screen).toMatch(/onSelectCitation=\{handleSelectCitation\}/);
  });

  it("routes a board Q&A plan denial to the same upsell as every other quota denial", () => {
    expect(screen).toMatch(/upsell\.show\("boardQa"\)/);
  });

  it("resolves citation liveness against the board's live elements, not a constant", () => {
    // A `() => true` here would make every citation claim to be live, including
    // ones whose element had just been deleted — the exact failure the panel's
    // deleted-chip state exists to surface.
    expect(screen).toMatch(/elements\.boxOfElement\(elementId, canvasKind\) !== null/);
  });

  it("routes canvas kinds by the shared allow-list, not by a not-a-comment negation", () => {
    // An allow-list makes an unrecognized future kind fall through to "can't
    // resolve"; a negation would hand it to `boxOfElement`, which finds nothing
    // and reports it deleted. Both call sites use the same list, so the two
    // cannot disagree about what lives on the canvas.
    expect(screen).toMatch(/CANVAS_CITATION_KINDS/);
    expect(screen.match(/CANVAS_CITATION_KINDS\.includes\(canvasKind\)/g)).toHaveLength(2);
  });

  it("resolves a comment citation against the comment threads, not the canvas", () => {
    // A comment thread has no box. Routing it through `boxOfElement` would
    // report every comment citation as deleted — the answer would cite a
    // discussion and then refuse to show it.
    //
    // Anchored to the LIVENESS branch specifically, not just to the string
    // appearing somewhere in the file — `handleSelectCitation` contains the
    // same comment lookup, so an unanchored match stayed green once already
    // with `isCitationLive` re-pointed at the canvas.
    expect(screen).toMatch(
      /if \(canvasKind === "comment"\) \{\s*return comments\.comments\.some\(\(c\) => c\.id === elementId\);/
    );
    expect(screen).toMatch(/comments\.openThread\(elementId\)/);
  });
});
