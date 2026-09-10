// Standard service-boundary mocks (matches every other test that transitively
// touches billingService/Firebase — see src/services/__tests__/billingService.test.ts).
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("firebase/functions", () => ({ httpsCallable: jest.fn() }));

// Mock only the two callable-backed functions; keep the REAL `BillingCallableError`
// class so `instanceof` checks inside UpsellModal work against the real identity,
// not a test double's.
jest.mock("../../services/billingService", () => ({
  ...jest.requireActual("../../services/billingService"),
  startCheckout: jest.fn(),
  openBillingPortal: jest.fn(),
}));

import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Platform, Linking } from "react-native";
import UpsellModal from "../UpsellModal";
import { startCheckout, openBillingPortal, BillingCallableError } from "../../services/billingService";

const mockStartCheckout = startCheckout as jest.Mock;
const mockOpenBillingPortal = openBillingPortal as jest.Mock;

describe("UpsellModal", () => {
  afterEach(() => {
    Platform.OS = "web";
    jest.clearAllMocks();
  });

  it("shows the price and an upgrade action on web", () => {
    Platform.OS = "web";
    const { getByText } = render(<UpsellModal visible resource="board" onDismiss={() => {}} />);
    expect(getByText(/\$5/)).toBeTruthy();
    expect(getByText(/upgrade/i)).toBeTruthy();
  });

  it("names the limit that was hit", () => {
    Platform.OS = "web";
    const { getByText } = render(<UpsellModal visible resource="board" onDismiss={() => {}} />);
    expect(getByText(/5 boards/i)).toBeTruthy();
  });

  // The store-compliance guard. If this test ever fails, the binary is at risk.
  it("renders NO price and NO link on native", () => {
    Platform.OS = "ios";
    const { toJSON } = render(<UpsellModal visible resource="board" onDismiss={() => {}} />);
    const tree = JSON.stringify(toJSON());
    expect(tree).not.toMatch(/\$\d/);
    expect(tree).not.toMatch(/https?:\/\//);
    expect(tree).not.toMatch(/upgrade/i);
    expect(tree).not.toMatch(/subscri/i);
  });

  it("still explains the limit on native", () => {
    Platform.OS = "ios";
    const { getByText } = render(<UpsellModal visible resource="board" onDismiss={() => {}} />);
    expect(getByText(/5 boards/i)).toBeTruthy();
  });

  // Stronger than the text-regex checks above: a checkout/upgrade affordance
  // reworded to dodge every one of those regexes (e.g. a button that just says
  // "Continue" and silently opens Stripe) would still be a SECOND `button`-role
  // element next to Dismiss, so this catches it regardless of wording — it
  // counts actionable affordances by accessibility role, not by label text.
  it("offers no interactive affordance beyond Dismiss on native, however a checkout action might be worded", () => {
    Platform.OS = "android";
    const { getAllByRole } = render(<UpsellModal visible resource="board" onDismiss={() => {}} />);
    expect(getAllByRole("button")).toHaveLength(1);
  });

  it("never imports/calls billingService on native — pressing the sole native button never starts checkout", () => {
    Platform.OS = "ios";
    const { getByTestId } = render(<UpsellModal visible resource="board" onDismiss={() => {}} />);
    fireEvent.press(getByTestId("upsell-native-dismiss-button"));
    expect(mockStartCheckout).not.toHaveBeenCalled();
    expect(mockOpenBillingPortal).not.toHaveBeenCalled();
  });

  it("calls onDismiss when the native Dismiss action is pressed", () => {
    Platform.OS = "ios";
    const onDismiss = jest.fn();
    const { getByTestId } = render(<UpsellModal visible resource="board" onDismiss={onDismiss} />);
    fireEvent.press(getByTestId("upsell-native-dismiss-button"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("starts checkout with the given workspace and opens the returned URL", async () => {
    Platform.OS = "web";
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    mockStartCheckout.mockResolvedValueOnce("https://checkout.stripe.test/s/1");

    const { getByTestId } = render(
      <UpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));

    await waitFor(() => expect(mockStartCheckout).toHaveBeenCalledWith("ws-1"));
    await waitFor(() => expect(openURLSpy).toHaveBeenCalledWith("https://checkout.stripe.test/s/1"));
    openURLSpy.mockRestore();
  });

  it("routes on details.canOpenPortal=true by offering the Customer Portal, not a message-text guess", async () => {
    Platform.OS = "web";
    mockStartCheckout.mockRejectedValueOnce(
      new BillingCallableError("This workspace's subscription needs attention.", "failed-precondition", {
        reason: "subscription-exists",
        canOpenPortal: true,
      })
    );

    const { getByTestId, queryByTestId } = render(
      <UpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    expect(queryByTestId("upsell-web-portal-button")).toBeNull();
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));

    await waitFor(() => expect(getByTestId("upsell-web-portal-button")).toBeTruthy());
  });

  it("does NOT offer the portal when details.canOpenPortal=false, even if the message reads like it should", async () => {
    // The message deliberately mentions "portal" — if routing ever regresses to
    // sniffing `.message` text instead of `.details.canOpenPortal`, this fails.
    Platform.OS = "web";
    mockStartCheckout.mockRejectedValueOnce(
      new BillingCallableError(
        "Please open the billing portal to resolve this subscription.",
        "failed-precondition",
        { reason: "subscription-paused", canOpenPortal: false }
      )
    );

    const { getByTestId, queryByTestId, getByText } = render(
      <UpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));

    await waitFor(() => expect(getByText(/resolve this subscription/i)).toBeTruthy());
    expect(queryByTestId("upsell-web-portal-button")).toBeNull();
  });

  it("pressing the portal action opens the URL from openBillingPortal", async () => {
    Platform.OS = "web";
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    mockStartCheckout.mockRejectedValueOnce(
      new BillingCallableError("needs attention", "failed-precondition", {
        reason: "subscription-exists",
        canOpenPortal: true,
      })
    );
    mockOpenBillingPortal.mockResolvedValueOnce("https://billing.stripe.test/p/1");

    const { getByTestId } = render(
      <UpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));
    await waitFor(() => getByTestId("upsell-web-portal-button"));
    fireEvent.press(getByTestId("upsell-web-portal-button"));

    await waitFor(() => expect(mockOpenBillingPortal).toHaveBeenCalledWith("ws-1"));
    await waitFor(() => expect(openURLSpy).toHaveBeenCalledWith("https://billing.stripe.test/p/1"));
    openURLSpy.mockRestore();
  });
});
