import React from "react";
import { render, fireEvent, screen } from "@testing-library/react-native";
import ReactionBadge from "../ReactionBadge";
import { REACTION_EMOJIS, ReactionEmoji } from "../../../types";
import type { ReactionCount } from "../../../hooks/useBoardReactions";

/**
 * ReactionBadge.test.tsx — Month 6 reactions. Follows the AudioAffordance
 * pattern: render the real component, drive it with fireEvent, assert on
 * what actually shows up (not on a mock's own return value).
 */

function zeroCounts(): ReactionCount[] {
  return REACTION_EMOJIS.map((emoji) => ({ emoji, count: 0, reactedByMe: false }));
}

function countsWith(overrides: Partial<Record<ReactionEmoji, { count: number; reactedByMe?: boolean }>>): ReactionCount[] {
  return REACTION_EMOJIS.map((emoji) => ({
    emoji,
    count: overrides[emoji]?.count ?? 0,
    reactedByMe: overrides[emoji]?.reactedByMe ?? false,
  }));
}

describe("empty state (no reactions yet)", () => {
  it("renders nothing when there are no reactions and the viewer cannot react", () => {
    const { toJSON } = render(
      <ReactionBadge counts={zeroCounts()} canReact={false} onToggle={jest.fn()} />
    );
    expect(toJSON()).toBeNull();
  });

  it("renders a compact 'start reacting' affordance when the viewer can react", () => {
    render(<ReactionBadge counts={zeroCounts()} canReact={true} onToggle={jest.fn()} />);
    expect(screen.getByTestId("reaction-badge-start")).toBeTruthy();
    // None of the 5 emoji pills are shown yet — only the compact affordance.
    for (const emoji of REACTION_EMOJIS) {
      expect(screen.queryByTestId(`reaction-pill-${emoji}`)).toBeNull();
    }
  });

  it("expands into the full 5-emoji row when the start affordance is tapped", () => {
    render(<ReactionBadge counts={zeroCounts()} canReact={true} onToggle={jest.fn()} />);
    fireEvent.press(screen.getByTestId("reaction-badge-start"));
    for (const emoji of REACTION_EMOJIS) {
      expect(screen.getByTestId(`reaction-pill-${emoji}`)).toBeTruthy();
    }
  });

  it("tapping an emoji after expanding calls onToggle with that emoji", () => {
    const onToggle = jest.fn();
    render(<ReactionBadge counts={zeroCounts()} canReact={true} onToggle={onToggle} />);
    fireEvent.press(screen.getByTestId("reaction-badge-start"));
    fireEvent.press(screen.getByTestId("reaction-pill-⭐"));
    expect(onToggle).toHaveBeenCalledWith("⭐");
  });
});

describe("existing reactions", () => {
  it("shows only the non-zero pills, with their counts", () => {
    render(
      <ReactionBadge
        counts={countsWith({ "👍": { count: 3 }, "❤️": { count: 1 } })}
        canReact={true}
        onToggle={jest.fn()}
      />
    );
    expect(screen.getByTestId("reaction-pill-👍")).toBeTruthy();
    expect(screen.getByTestId("reaction-pill-❤️")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    // The other three emoji aren't shown until expanded.
    expect(screen.queryByTestId("reaction-pill-❓")).toBeNull();
    expect(screen.queryByTestId("reaction-pill-⭐")).toBeNull();
    expect(screen.queryByTestId("reaction-pill-💡")).toBeNull();
  });

  it("tapping an existing pill calls onToggle with that emoji (un-react)", () => {
    const onToggle = jest.fn();
    render(
      <ReactionBadge
        counts={countsWith({ "👍": { count: 1, reactedByMe: true } })}
        canReact={true}
        onToggle={onToggle}
      />
    );
    fireEvent.press(screen.getByTestId("reaction-pill-👍"));
    expect(onToggle).toHaveBeenCalledWith("👍");
  });

  it("labels a pill the viewer has already reacted to", () => {
    render(
      <ReactionBadge
        counts={countsWith({ "👍": { count: 1, reactedByMe: true } })}
        canReact={true}
        onToggle={jest.fn()}
      />
    );
    expect(screen.getByLabelText(/👍 reaction, 1, you reacted/)).toBeTruthy();
  });

  it("a viewer who cannot react still sees the counts, but tapping does nothing", () => {
    const onToggle = jest.fn();
    render(
      <ReactionBadge
        counts={countsWith({ "👍": { count: 2 } })}
        canReact={false}
        onToggle={onToggle}
      />
    );
    expect(screen.getByTestId("reaction-pill-👍")).toBeTruthy();
    fireEvent.press(screen.getByTestId("reaction-pill-👍"));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("a viewer who cannot react gets no expand affordance (nothing new to start)", () => {
    render(
      <ReactionBadge counts={countsWith({ "👍": { count: 2 } })} canReact={false} onToggle={jest.fn()} />
    );
    expect(screen.queryByTestId("reaction-badge-toggle-expand")).toBeNull();
  });

  it("the expand toggle reveals the rest of the 5 emoji, and collapses back on a second tap", () => {
    render(
      <ReactionBadge counts={countsWith({ "👍": { count: 1 } })} canReact={true} onToggle={jest.fn()} />
    );
    expect(screen.queryByTestId("reaction-pill-⭐")).toBeNull();

    fireEvent.press(screen.getByTestId("reaction-badge-toggle-expand"));
    for (const emoji of REACTION_EMOJIS) {
      expect(screen.getByTestId(`reaction-pill-${emoji}`)).toBeTruthy();
    }

    fireEvent.press(screen.getByTestId("reaction-badge-toggle-expand"));
    expect(screen.queryByTestId("reaction-pill-⭐")).toBeNull();
    expect(screen.getByTestId("reaction-pill-👍")).toBeTruthy();
  });
});

describe("counter-scale", () => {
  it("does not throw with a non-default scale (dimensions scale, not a wrapper transform)", () => {
    expect(() =>
      render(
        <ReactionBadge
          counts={countsWith({ "👍": { count: 1 } })}
          canReact={true}
          onToggle={jest.fn()}
          scale={0.5}
        />
      )
    ).not.toThrow();
  });
});
