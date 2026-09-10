jest.mock("../../config/firebase", () => ({
  db: {},
  auth: { currentUser: null },
  functions: {},
}));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
const mockCallable = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: () => mockCallable,
}));

import * as fs from "firebase/firestore";
import { makeDocSnap } from "../../test-utils/firestoreMock";
import {
  mapSubscriptionDoc,
  isEntitledToPro,
  getSubscription,
  startCheckout,
  openBillingPortal,
} from "../billingService";

const getDoc = fs.getDoc as jest.Mock;
const doc = fs.doc as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("mapSubscriptionDoc", () => {
  it("returns null for a missing doc", () => {
    expect(mapSubscriptionDoc(undefined)).toBeNull();
  });

  it("tolerates a partial doc", () => {
    const s = mapSubscriptionDoc({ status: "active" });
    expect(s?.status).toBe("active");
    expect(s?.stripeCustomerId).toBe("");
    expect(s?.currentPeriodEndMs).toBe(0);
  });

  it("tolerates a fully empty doc (every field missing)", () => {
    const s = mapSubscriptionDoc({});
    expect(s).toEqual({
      schemaVersion: 1,
      status: "incomplete",
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      currentPeriodEndMs: 0,
    });
  });

  it("maps a fully-populated doc through unchanged", () => {
    const s = mapSubscriptionDoc({
      schemaVersion: 1,
      status: "past_due",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      currentPeriodEndMs: 1_700_000_000_000,
    });
    expect(s).toEqual({
      schemaVersion: 1,
      status: "past_due",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      currentPeriodEndMs: 1_700_000_000_000,
    });
  });

  it("treats a stored null currentPeriodEndMs as the unknown sentinel (0), not a crash", () => {
    // The webhook's stored field is `number | null` (functions/src/http/
    // stripeWebhook.ts SubscriptionState) — `null` is a legitimate value, not
    // a malformed doc, so this must not throw.
    const s = mapSubscriptionDoc({ status: "active", currentPeriodEndMs: null });
    expect(s?.currentPeriodEndMs).toBe(0);
  });
});

describe("isEntitledToPro", () => {
  it("entitles an active subscription", () => {
    expect(isEntitledToPro({ status: "active" } as never, 0)).toBe(true);
  });

  it("entitles past_due until the period ends (grace)", () => {
    expect(isEntitledToPro({ status: "past_due", currentPeriodEndMs: 1000 } as never, 500)).toBe(true);
    expect(isEntitledToPro({ status: "past_due", currentPeriodEndMs: 1000 } as never, 1500)).toBe(false);
  });

  it("does not entitle a canceled subscription", () => {
    expect(isEntitledToPro({ status: "canceled" } as never, 0)).toBe(false);
  });

  it("does not entitle a null subscription", () => {
    expect(isEntitledToPro(null, 0)).toBe(false);
  });

  it("does not entitle an incomplete subscription", () => {
    expect(isEntitledToPro({ status: "incomplete" } as never, 0)).toBe(false);
  });

  it("does not entitle past_due with an unknown (0) renewal date — fails closed, not open", () => {
    // NaN/undefined-style gate applied to a category: an unknown period end
    // must not silently grant the grace window.
    expect(isEntitledToPro({ status: "past_due", currentPeriodEndMs: 0 } as never, 1)).toBe(false);
  });
});

describe("getSubscription", () => {
  it("reads the single billing/subscription document, not the billing collection", () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("subscription", null));
    return getSubscription("ws1").then(() => {
      expect(doc).toHaveBeenCalledWith({}, "workspaces", "ws1", "billing", "subscription");
      // No collection() call anywhere in this path — the whole point is
      // never touching the idempotency-record documents that live alongside
      // it in that subcollection.
      expect(fs.collection).not.toHaveBeenCalled();
    });
  });

  it("returns null when the workspace has never had a subscription", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("subscription", null));
    await expect(getSubscription("ws1")).resolves.toBeNull();
  });

  it("maps an existing document through mapSubscriptionDoc", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("subscription", {
        schemaVersion: 1,
        status: "active",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        currentPeriodEndMs: 123,
      })
    );
    await expect(getSubscription("ws1")).resolves.toEqual({
      schemaVersion: 1,
      status: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      currentPeriodEndMs: 123,
    });
  });
});

describe("startCheckout", () => {
  it("calls the createCheckoutSession callable with the workspace id and returns its url", async () => {
    mockCallable.mockResolvedValueOnce({ data: { url: "https://checkout.stripe.test/s/1" } });
    await expect(startCheckout("ws1")).resolves.toBe("https://checkout.stripe.test/s/1");
    expect(mockCallable).toHaveBeenCalledWith({ workspaceId: "ws1" });
  });

  it("throws a readable error when the callable rejects", async () => {
    mockCallable.mockRejectedValueOnce(new Error("failed-precondition: already on a plan"));
    await expect(startCheckout("ws1")).rejects.toThrow(/already on a plan/);
  });

  it("throws when the callable resolves with no url", async () => {
    mockCallable.mockResolvedValueOnce({ data: {} });
    await expect(startCheckout("ws1")).rejects.toThrow(/checkout/i);
  });
});

describe("openBillingPortal", () => {
  it("calls the createPortalSession callable with the workspace id and returns its url", async () => {
    mockCallable.mockResolvedValueOnce({ data: { url: "https://billing.stripe.test/p/1" } });
    await expect(openBillingPortal("ws1")).resolves.toBe("https://billing.stripe.test/p/1");
    expect(mockCallable).toHaveBeenCalledWith({ workspaceId: "ws1" });
  });

  it("throws a readable error when the callable rejects", async () => {
    mockCallable.mockRejectedValueOnce(new Error("failed-precondition: no billing account"));
    await expect(openBillingPortal("ws1")).rejects.toThrow(/no billing account/);
  });

  it("throws when the callable resolves with no url", async () => {
    mockCallable.mockResolvedValueOnce({ data: {} });
    await expect(openBillingPortal("ws1")).rejects.toThrow(/portal/i);
  });
});
