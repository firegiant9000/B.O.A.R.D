jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

import React from "react";
import { render, screen } from "@testing-library/react-native";
import PresentingBanner from "../PresentingBanner";

describe("PresentingBanner", () => {
  it("renders nothing when there is no active presenter", () => {
    render(<PresentingBanner presenterName={null} paused={false} />);
    expect(screen.queryByText(/is presenting/)).toBeNull();
    expect(screen.queryByText(/paused presenting/)).toBeNull();
  });

  it("shows the presenter's name while actively presenting", () => {
    render(<PresentingBanner presenterName="Alex" paused={false} />);
    expect(screen.getByText("Alex is presenting")).toBeTruthy();
  });

  it("stays visible and shows a paused state when the presenter pauses (case 2)", () => {
    render(<PresentingBanner presenterName="Alex" paused={true} />);
    expect(screen.getByText("Alex paused presenting")).toBeTruthy();
  });
});
