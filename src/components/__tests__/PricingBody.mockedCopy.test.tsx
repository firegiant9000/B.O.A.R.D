// Standard service-boundary mocks — see PricingBody.test.tsx / UpsellModal.test.tsx.
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("firebase/functions", () => ({ httpsCallable: jest.fn() }));

jest.mock("../../services/billingService", () => ({
  ...jest.requireActual("../../services/billingService"),
  startCheckout: jest.fn(),
}));

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({})),
  useRouter: jest.fn(() => ({ back: jest.fn() })),
}));

jest.mock("../../hooks/useWorkspace", () => ({
  useWorkspace: jest.fn(() => ({ activeWorkspaceId: "ws-1" })),
}));

// The load-bearing mock for THIS FILE — separate from PricingBody.test.tsx
// specifically so that file can exercise the page against the REAL,
// currently-`false` BILLING_LIVE while this one proves two things a
// same-file test could not, given that constraint:
//
//  1. (Renders from data, not literals.) Overriding PLAN_CARDS with
//     sentinel strings means there is no possible hardcoded JSX literal
//     that could coincidentally match these assertions — unlike asserting
//     against the CURRENT PLAN_LIMITS numbers, which a hardcoded "5
//     boards" would also satisfy.
//  2. (Checkout wiring.) `BILLING_LIVE` is a hand-flipped constant that is
//     `false` today by design — this is the ONLY way to exercise the
//     checkout success/error/no-workspace paths at all, proving the wiring
//     is correct for the day that flag flips, not just today's dormant
//     state.
jest.mock("../../lib/pricingCopy", () => ({
  ...jest.requireActual("../../lib/pricingCopy"),
  BILLING_LIVE: true,
  PLAN_CARDS: [
    {
      id: "free",
      label: "Free",
      priceLabel: "SENTINEL_PRICE_FREE",
      tagline: "SENTINEL_TAGLINE_FREE",
      features: ["SENTINEL_FEATURE_FREE_1", "SENTINEL_FEATURE_FREE_2"],
    },
    {
      id: "pro",
      label: "Pro",
      priceLabel: "SENTINEL_PRICE_PRO",
      priceNote: "SENTINEL_PRICE_NOTE_PRO",
      tagline: "SENTINEL_TAGLINE_PRO",
      features: ["SENTINEL_FEATURE_PRO_1"],
      ctaLabel: "SENTINEL_CTA_PRO",
    },
    {
      id: "edu",
      label: "Edu",
      priceLabel: "SENTINEL_PRICE_EDU",
      tagline: "SENTINEL_TAGLINE_EDU",
      features: ["SENTINEL_FEATURE_EDU_1"],
    },
  ],
}));

import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { startCheckout } from "../../services/billingService";
import { useWorkspace } from "../../hooks/useWorkspace";

const WebPricingBody: React.ComponentType = require("../PricingBody.tsx").default;

const mockStartCheckout = startCheckout as jest.Mock;
const mockUseWorkspace = useWorkspace as jest.Mock;

describe("PricingBody.tsx renders plan data from pricingCopy.ts, not literals baked into the JSX", () => {
  it("renders the sentinel cards' price, note, tagline, and features verbatim, in Free/Pro/Edu order — there is no equivalent hardcoded copy for these assertions to coincidentally match", () => {
    const { getByText, getAllByTestId } = render(<WebPricingBody />);
    expect(getByText("SENTINEL_PRICE_FREE")).toBeTruthy();
    expect(getByText("SENTINEL_TAGLINE_FREE")).toBeTruthy();
    expect(getByText(/SENTINEL_FEATURE_FREE_1/)).toBeTruthy();
    expect(getByText(/SENTINEL_FEATURE_FREE_2/)).toBeTruthy();
    expect(getByText("SENTINEL_PRICE_PRO")).toBeTruthy();
    expect(getByText("SENTINEL_PRICE_NOTE_PRO")).toBeTruthy();
    expect(getByText(/SENTINEL_FEATURE_PRO_1/)).toBeTruthy();
    expect(getByText("SENTINEL_PRICE_EDU")).toBeTruthy();
    expect(getByText(/SENTINEL_FEATURE_EDU_1/)).toBeTruthy();
    expect(getAllByTestId("plan-card").map((c) => c.props.accessibilityLabel)).toEqual([
      "Free",
      "Pro",
      "Edu",
    ]);
  });
});

describe("PricingBody.tsx checkout wiring, exercised with BILLING_LIVE mocked true (the only way to reach it while the real flag is false)", () => {
  beforeEach(() => {
    mockUseWorkspace.mockReturnValue({ activeWorkspaceId: "ws-1" });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("with a workspace active, the CTA is enabled and reads the real action label", () => {
    const { getByTestId, getByText } = render(<WebPricingBody />);
    const button = getByTestId("plan-card-cta-pro");
    expect(button.props.accessibilityState?.disabled).toBe(false);
    expect(getByText("Upgrade to Pro")).toBeTruthy();
  });

  it("starts checkout with the active workspace id (via billingService.startCheckout) and opens the returned URL", async () => {
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    mockStartCheckout.mockResolvedValueOnce("https://checkout.stripe.test/s/1");

    const { getByTestId } = render(<WebPricingBody />);
    fireEvent.press(getByTestId("plan-card-cta-pro"));

    await waitFor(() => expect(mockStartCheckout).toHaveBeenCalledWith("ws-1"));
    await waitFor(() => expect(openURLSpy).toHaveBeenCalledWith("https://checkout.stripe.test/s/1"));
    openURLSpy.mockRestore();
  });

  it("shows the callable's error message rather than silently swallowing a failed checkout", async () => {
    mockStartCheckout.mockRejectedValueOnce(new Error("Checkout is temporarily unavailable."));
    const { getByTestId, findByText } = render(<WebPricingBody />);
    fireEvent.press(getByTestId("plan-card-cta-pro"));
    expect(await findByText(/temporarily unavailable/i)).toBeTruthy();
  });

  it("with no active workspace, the CTA is disabled and says so — not silently a no-op on an enabled-looking button", () => {
    mockUseWorkspace.mockReturnValue({ activeWorkspaceId: null });
    const { getByTestId, getByText } = render(<WebPricingBody />);
    const button = getByTestId("plan-card-cta-pro");
    expect(button.props.accessibilityState?.disabled).toBe(true);
    expect(getByText(/sign in to a workspace/i)).toBeTruthy();
    fireEvent.press(button);
    expect(mockStartCheckout).not.toHaveBeenCalled();
  });
});
