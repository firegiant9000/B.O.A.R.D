// @expo/vector-icons pulls in expo-asset/expo-font which don't resolve under the
// jest-expo transform here; the icon glyphs are irrelevant to these assertions.
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import SummaryCard from "../SummaryCard";

describe("SummaryCard", () => {
  it("renders a legacy string summary as the TL;DR with no detail toggle", () => {
    render(<SummaryCard summary="Just a plain old summary." />);
    expect(screen.getByText("Just a plain old summary.")).toBeTruthy();
    expect(screen.queryByText("Show details")).toBeNull();
  });

  it("renders the TL;DR and reveals sections on expand", () => {
    render(
      <SummaryCard
        summary={{
          tldr: "We scoped the API.",
          actionItems: ["Write the spec"],
          decisions: ["Use REST"],
          openQuestions: ["Auth model?"],
        }}
      />
    );

    // Collapsed: TL;DR shown, detail hidden behind the toggle.
    expect(screen.getByText("We scoped the API.")).toBeTruthy();
    expect(screen.queryByText("Write the spec")).toBeNull();

    fireEvent.press(screen.getByText("Show details"));

    expect(screen.getByText("Write the spec")).toBeTruthy();
    expect(screen.getByText("Use REST")).toBeTruthy();
    expect(screen.getByText("Auth model?")).toBeTruthy();
    expect(screen.getByText("Show less")).toBeTruthy();
  });

  it("omits the toggle when the structured summary has no detail sections", () => {
    render(
      <SummaryCard
        summary={{ tldr: "Short one.", actionItems: [], decisions: [], openQuestions: [] }}
      />
    );
    expect(screen.getByText("Short one.")).toBeTruthy();
    expect(screen.queryByText("Show details")).toBeNull();
  });
});
