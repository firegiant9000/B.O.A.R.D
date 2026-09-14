// Standard service-boundary mocks (matches every other test that transitively
// touches billingService/Firebase — see src/components/__tests__/UpsellModal.test.tsx).
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("firebase/functions", () => ({ httpsCallable: jest.fn() }));

jest.mock("../../services/billingService", () => ({
  ...jest.requireActual("../../services/billingService"),
  startCheckout: jest.fn(),
}));

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

const mockBack = jest.fn();
jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({})),
  useRouter: jest.fn(() => ({ back: mockBack })),
}));

jest.mock("../../hooks/useWorkspace", () => ({
  useWorkspace: jest.fn(() => ({ activeWorkspaceId: "ws-1" })),
}));

import fs from "fs";
import path from "path";
import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { useLocalSearchParams } from "expo-router";
import { PLAN_LIMITS } from "../../lib/planLimits";
import { BILLING_LIVE, PRICE_PROVISIONAL_NOTE } from "../../lib/pricingCopy";
import { startCheckout } from "../../services/billingService";
import { useWorkspace } from "../../hooks/useWorkspace";

// The load-bearing part of this file: two SEPARATE physical modules, not one
// module switched by a runtime Platform.OS check — mirrors
// UpsellModal.test.tsx's own header comment exactly (same haste-platform
// resolution mechanics, same repo).
//
//   - `"../PricingBody"` (no extension) resolves the way a real consumer's
//     import resolves under this repo's Jest config: `haste.platforms` for
//     the bare "jest-expo" preset is `['android', 'ios', 'native']` with
//     `defaultPlatform: 'ios'` — no `.ios.tsx` file exists here, so the
//     resolver falls through to `.native.tsx`, which does. This is the SAME
//     resolution a native build's bundler performs.
//   - `"../PricingBody.tsx"` (explicit extension) bypasses platform-extension
//     resolution entirely to reach the bare (web) file.
import NativePricingBody from "../PricingBody";
const WebPricingBody: React.ComponentType = require("../PricingBody.tsx").default;

const mockStartCheckout = startCheckout as jest.Mock;
const mockUseWorkspace = useWorkspace as jest.Mock;
const mockUseLocalSearchParams = useLocalSearchParams as jest.Mock;

const NO_PAYMENT_CONTENT = /\$(?!\{)|https?:|stripe|checkout|price/i;

describe("PricingBody — native-reachable source (store-compliance guard)", () => {
  it("PricingBody.native.tsx contains no price, currency, Stripe reference, or link scheme anywhere in its source — not just rendered output", () => {
    const source = fs.readFileSync(path.join(__dirname, "../PricingBody.native.tsx"), "utf8");
    expect(source).not.toMatch(NO_PAYMENT_CONTENT);
  });

  it("PricingBody.native.tsx imports nothing from billingService or the pricing-copy module", () => {
    const source = fs.readFileSync(path.join(__dirname, "../PricingBody.native.tsx"), "utf8");
    expect(source).not.toMatch(/billingService/i);
    expect(source).not.toMatch(/pricingCopy/);
  });
});

describe("PricingBody.native.tsx (rendered)", () => {
  beforeEach(() => {
    mockBack.mockClear();
  });

  it("renders no price and no link, however worded", () => {
    const { toJSON } = render(<NativePricingBody />);
    const tree = JSON.stringify(toJSON());
    expect(tree).not.toMatch(/\$\d/);
    expect(tree).not.toMatch(/https?:\/\//);
    expect(tree).not.toMatch(/upgrade/i);
    expect(tree).not.toMatch(/subscri/i);
  });

  it("offers a way back rather than a dead end — the root Stack hides the default header, so a cold-start deep link here needs its own escape", () => {
    const { getByTestId } = render(<NativePricingBody />);
    fireEvent.press(getByTestId("pricing-native-back-button"));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});

describe("PricingBody.tsx (web, rendered)", () => {
  beforeEach(() => {
    mockUseWorkspace.mockReturnValue({ activeWorkspaceId: "ws-1" });
    mockUseLocalSearchParams.mockReturnValue({});
    mockBack.mockClear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Brief Step 1, verbatim.
  it("renders every free-tier limit from the shared table", () => {
    const { getByText } = render(<WebPricingBody />);
    expect(getByText(new RegExp(`${PLAN_LIMITS.free.boards} boards`, "i"))).toBeTruthy();
    expect(getByText(new RegExp(`${PLAN_LIMITS.free.sessionsPerPeriod} sessions`, "i"))).toBeTruthy();
  });

  it("lists the free tier before pro", () => {
    const { getAllByTestId } = render(<WebPricingBody />);
    expect(getAllByTestId("plan-card").map((c) => c.props.accessibilityLabel)).toEqual([
      "Free",
      "Pro",
      "Edu",
    ]);
  });

  it("renders Pro's and Edu's unlimited limits as the word Unlimited, never Infinity or a raw number", () => {
    const { getAllByText, queryByText } = render(<WebPricingBody />);
    expect(getAllByText(/Unlimited boards/i).length).toBe(2);
    expect(queryByText(/Infinity/i)).toBeNull();
  });

  it("phrases the collaborator cap as per board on every card, never per workspace", () => {
    const { getAllByText, queryByText } = render(<WebPricingBody />);
    expect(getAllByText(/collaborators? per board/i).length).toBe(3);
    expect(queryByText(/per workspace/i)).toBeNull();
  });

  it("never mentions the unenforced `workspaces` limit anywhere on the page", () => {
    const { queryByText } = render(<WebPricingBody />);
    expect(queryByText(/workspace/i)).toBeNull();
  });

  it("shows a user-visible provisional-pricing note beside the Pro price — not just a code comment", () => {
    const { getByText } = render(<WebPricingBody />);
    expect(getByText(PRICE_PROVISIONAL_NOTE)).toBeTruthy();
  });

  it("only the Pro card offers a checkout action — Free and Edu are not self-serve purchasable", () => {
    const { getByTestId, queryByTestId } = render(<WebPricingBody />);
    expect(getByTestId("plan-card-cta-pro")).toBeTruthy();
    expect(queryByTestId("plan-card-cta-free")).toBeNull();
    expect(queryByTestId("plan-card-cta-edu")).toBeNull();
  });

  it("today's real BILLING_LIVE is false, so the Pro CTA renders disabled with an honest label instead of presenting as a working purchase", () => {
    expect(BILLING_LIVE).toBe(false); // guards the premise of this test
    const { getByTestId, queryByText, getByText } = render(<WebPricingBody />);
    const button = getByTestId("plan-card-cta-pro");
    expect(button.props.accessibilityState?.disabled).toBe(true);
    expect(getByText(/checkout isn't available yet/i)).toBeTruthy();
    expect(queryByText(/^Upgrade to Pro$/)).toBeNull();
  });

  it("pressing the disabled Pro CTA does not start a checkout", () => {
    const { getByTestId } = render(<WebPricingBody />);
    fireEvent.press(getByTestId("plan-card-cta-pro"));
    expect(mockStartCheckout).not.toHaveBeenCalled();
  });

  it("offers a way back, same as the native fallback", () => {
    const { getByTestId } = render(<WebPricingBody />);
    fireEvent.press(getByTestId("pricing-back-button"));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("shows a checkout-complete banner, without claiming the plan already changed, when redirected back from Stripe", () => {
    mockUseLocalSearchParams.mockReturnValue({ checkout: "success" });
    const { getByTestId, queryByText } = render(<WebPricingBody />);
    expect(getByTestId("checkout-success-banner")).toBeTruthy();
    // The webhook (not this redirect) is what actually grants Pro, and it
    // runs asynchronously — this page must not claim the upgrade is done.
    expect(queryByText(/you're now on pro/i)).toBeNull();
    expect(queryByText(/you are now/i)).toBeNull();
  });

  it("shows a checkout-canceled banner when redirected back after canceling", () => {
    mockUseLocalSearchParams.mockReturnValue({ checkout: "cancel" });
    const { getByTestId } = render(<WebPricingBody />);
    expect(getByTestId("checkout-cancel-banner")).toBeTruthy();
  });

  it("shows neither banner on an ordinary visit with no checkout param", () => {
    const { queryByTestId } = render(<WebPricingBody />);
    expect(queryByTestId("checkout-success-banner")).toBeNull();
    expect(queryByTestId("checkout-cancel-banner")).toBeNull();
  });
});
