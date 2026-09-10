// Standard service-boundary mocks (matches every other test that transitively
// touches billingService/Firebase — see src/services/__tests__/billingService.test.ts
// and src/components/__tests__/UpsellModal.test.tsx).
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("firebase/functions", () => ({ httpsCallable: jest.fn() }));

jest.mock("../../services/billingService", () => ({
  ...jest.requireActual("../../services/billingService"),
  startCheckout: jest.fn(),
}));

// This route (app/pricing.web.tsx) is rendered directly with bare
// `render()`, not through expo-router's ExpoRoot/renderRouter — so its only
// expo-router import (useLocalSearchParams) needs a hook double rather than
// a real router context.
jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({})),
}));

jest.mock("../../hooks/useWorkspace", () => ({
  useWorkspace: jest.fn(() => ({ activeWorkspaceId: "ws-1" })),
}));

import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { PLAN_LIMITS } from "../planLimits";
import { startCheckout } from "../../services/billingService";
import { useWorkspace } from "../../hooks/useWorkspace";
// `require`, not a static `import`, for the same reason UpsellModal.test.tsx
// uses `require("../UpsellModal.tsx")`: this reaches the route file as an
// ordinary module import, resolved by Jest's normal resolver (this repo has
// no `app/` path alias), with no expo-router route machinery involved.
import Pricing from "../../../app/pricing.web";

const mockStartCheckout = startCheckout as jest.Mock;
const mockUseWorkspace = useWorkspace as jest.Mock;
const mockUseLocalSearchParams = useLocalSearchParams as jest.Mock;

describe("Pricing (app/pricing.web.tsx)", () => {
  beforeEach(() => {
    mockUseWorkspace.mockReturnValue({ activeWorkspaceId: "ws-1" });
    mockUseLocalSearchParams.mockReturnValue({});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Brief Step 1, verbatim.
  it("renders every free-tier limit from the shared table", () => {
    const { getByText } = render(<Pricing />);
    expect(getByText(new RegExp(`${PLAN_LIMITS.free.boards} boards`, "i"))).toBeTruthy();
    expect(getByText(new RegExp(`${PLAN_LIMITS.free.sessionsPerPeriod} sessions`, "i"))).toBeTruthy();
  });

  it("lists the free tier before pro", () => {
    const { getAllByTestId } = render(<Pricing />);
    expect(getAllByTestId("plan-card").map((c) => c.props.accessibilityLabel)).toEqual([
      "Free",
      "Pro",
      "Edu",
    ]);
  });

  it("renders Pro's and Edu's unlimited limits as the word Unlimited, never Infinity or a raw number", () => {
    const { getAllByText, queryByText } = render(<Pricing />);
    // Both Pro and Edu are UNLIMITED for boards (see PLAN_LIMITS), so this is
    // deliberately getAllByText, not getByText (which would throw on >1 match).
    expect(getAllByText(/Unlimited boards/i).length).toBe(2);
    expect(queryByText(/Infinity/i)).toBeNull();
  });

  it("phrases the collaborator cap as per board on every card, never per workspace", () => {
    const { getAllByText, queryByText } = render(<Pricing />);
    expect(getAllByText(/collaborators? per board/i).length).toBe(3);
    expect(queryByText(/per workspace/i)).toBeNull();
  });

  it("never mentions the unenforced `workspaces` limit anywhere on the page", () => {
    const { queryByText } = render(<Pricing />);
    expect(queryByText(/workspace/i)).toBeNull();
  });

  it("only the Pro card offers a checkout action — Free and Edu are not self-serve purchasable", () => {
    const { getByTestId, queryByTestId } = render(<Pricing />);
    expect(getByTestId("plan-card-cta-pro")).toBeTruthy();
    expect(queryByTestId("plan-card-cta-free")).toBeNull();
    expect(queryByTestId("plan-card-cta-edu")).toBeNull();
  });

  it("starts checkout with the active workspace id (via billingService.startCheckout) and opens the returned URL", async () => {
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    mockStartCheckout.mockResolvedValueOnce("https://checkout.stripe.test/s/1");

    const { getByTestId } = render(<Pricing />);
    fireEvent.press(getByTestId("plan-card-cta-pro"));

    await waitFor(() => expect(mockStartCheckout).toHaveBeenCalledWith("ws-1"));
    await waitFor(() => expect(openURLSpy).toHaveBeenCalledWith("https://checkout.stripe.test/s/1"));
    openURLSpy.mockRestore();
  });

  it("shows the callable's error message rather than silently swallowing a failed checkout", async () => {
    mockStartCheckout.mockRejectedValueOnce(new Error("Checkout is temporarily unavailable."));
    const { getByTestId, findByText } = render(<Pricing />);
    fireEvent.press(getByTestId("plan-card-cta-pro"));
    expect(await findByText(/temporarily unavailable/i)).toBeTruthy();
  });

  it("does nothing when pressed with no active workspace, rather than calling startCheckout with an empty id", () => {
    mockUseWorkspace.mockReturnValue({ activeWorkspaceId: null });
    const { getByTestId } = render(<Pricing />);
    fireEvent.press(getByTestId("plan-card-cta-pro"));
    expect(mockStartCheckout).not.toHaveBeenCalled();
  });

  it("shows a checkout-complete banner, without claiming the plan already changed, when redirected back from Stripe", () => {
    mockUseLocalSearchParams.mockReturnValue({ checkout: "success" });
    const { getByTestId, queryByText } = render(<Pricing />);
    expect(getByTestId("checkout-success-banner")).toBeTruthy();
    // The webhook (not this redirect) is what actually grants Pro, and it
    // runs asynchronously — this page must not claim the upgrade is done.
    expect(queryByText(/you're now on pro/i)).toBeNull();
    expect(queryByText(/you are now/i)).toBeNull();
  });

  it("shows a checkout-canceled banner when redirected back after canceling", () => {
    mockUseLocalSearchParams.mockReturnValue({ checkout: "cancel" });
    const { getByTestId } = render(<Pricing />);
    expect(getByTestId("checkout-cancel-banner")).toBeTruthy();
  });

  it("shows neither banner on an ordinary visit with no checkout param", () => {
    const { queryByTestId } = render(<Pricing />);
    expect(queryByTestId("checkout-success-banner")).toBeNull();
    expect(queryByTestId("checkout-cancel-banner")).toBeNull();
  });
});
