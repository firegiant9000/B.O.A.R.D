// Standard service-boundary mocks — see UpsellModal.test.tsx.
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("firebase/functions", () => ({ httpsCallable: jest.fn() }));

// Mock only the two callable-backed functions; keep the REAL `BillingCallableError`
// class so `instanceof` checks inside UpsellModal.tsx work against the real
// identity, not a test double's.
jest.mock("../../services/billingService", () => ({
  ...jest.requireActual("../../services/billingService"),
  startCheckout: jest.fn(),
  openBillingPortal: jest.fn(),
}));

// The load-bearing mock for THIS FILE — separate from UpsellModal.test.tsx
// specifically so that file can exercise the modal against the REAL,
// currently-`false` BILLING_LIVE (proving Fix Wave F3's honest "not
// available yet" CTA), while this one mocks it `true` to prove the actual
// checkout wiring — success, the Customer Portal routing, and the portal
// button itself — the ONLY way to reach any of that while the real flag is
// false. Mirrors PricingBody.mockedCopy.test.tsx's identical split exactly.
jest.mock("../../lib/pricingCopy", () => ({
  ...jest.requireActual("../../lib/pricingCopy"),
  BILLING_LIVE: true,
}));

import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { startCheckout, openBillingPortal, BillingCallableError } from "../../services/billingService";

// Explicit-extension import bypasses platform-extension resolution to reach
// the bare (web) file — see UpsellModal.test.tsx's header for the fuller
// explanation of why this repo's two-physical-module split needs this.
const WebUpsellModal: React.ComponentType<any> = require("../UpsellModal.tsx").default;

const mockStartCheckout = startCheckout as jest.Mock;
const mockOpenBillingPortal = openBillingPortal as jest.Mock;

afterEach(() => jest.clearAllMocks());

describe("UpsellModal.tsx checkout wiring, exercised with BILLING_LIVE mocked true (Fix Wave F3 — the only way to reach it while the real flag is false)", () => {
  it("with a workspace given, the CTA is enabled and reads the real action label", () => {
    const { getByTestId, getByText } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    const button = getByTestId("upsell-web-upgrade-button");
    expect(button.props.accessibilityState?.disabled).toBe(false);
    expect(getByText("Upgrade to Pro")).toBeTruthy();
  });

  it("starts checkout with the given workspace and opens the returned URL", async () => {
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    mockStartCheckout.mockResolvedValueOnce("https://checkout.stripe.test/s/1");

    const { getByTestId } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));

    await waitFor(() => expect(mockStartCheckout).toHaveBeenCalledWith("ws-1"));
    await waitFor(() => expect(openURLSpy).toHaveBeenCalledWith("https://checkout.stripe.test/s/1"));
    openURLSpy.mockRestore();
  });

  it("routes on details.canOpenPortal=true by offering the Customer Portal, not a message-text guess", async () => {
    mockStartCheckout.mockRejectedValueOnce(
      new BillingCallableError("This workspace's subscription needs attention.", "failed-precondition", {
        reason: "subscription-exists",
        canOpenPortal: true,
      })
    );

    const { getByTestId, queryByTestId } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    expect(queryByTestId("upsell-web-portal-button")).toBeNull();
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));

    await waitFor(() => expect(getByTestId("upsell-web-portal-button")).toBeTruthy());
  });

  it("does NOT offer the portal when details.canOpenPortal=false, even if the message reads like it should", async () => {
    // The message deliberately mentions "portal" — if routing ever regresses
    // to sniffing `.message` text instead of `.details.canOpenPortal`, this fails.
    mockStartCheckout.mockRejectedValueOnce(
      new BillingCallableError(
        "Please open the billing portal to resolve this subscription.",
        "failed-precondition",
        { reason: "subscription-paused", canOpenPortal: false }
      )
    );

    const { getByTestId, queryByTestId, getByText } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));

    await waitFor(() => expect(getByText(/resolve this subscription/i)).toBeTruthy());
    expect(queryByTestId("upsell-web-portal-button")).toBeNull();
  });

  it("pressing the portal action opens the URL from openBillingPortal", async () => {
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    mockStartCheckout.mockRejectedValueOnce(
      new BillingCallableError("needs attention", "failed-precondition", {
        reason: "subscription-exists",
        canOpenPortal: true,
      })
    );
    mockOpenBillingPortal.mockResolvedValueOnce("https://billing.stripe.test/p/1");

    const { getByTestId } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));
    await waitFor(() => getByTestId("upsell-web-portal-button"));
    fireEvent.press(getByTestId("upsell-web-portal-button"));

    await waitFor(() => expect(mockOpenBillingPortal).toHaveBeenCalledWith("ws-1"));
    await waitFor(() => expect(openURLSpy).toHaveBeenCalledWith("https://billing.stripe.test/p/1"));
    openURLSpy.mockRestore();
  });
});
