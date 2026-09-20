jest.mock("../../config/firebase", () => ({
  db: {},
  auth: { currentUser: null },
  functions: {},
}));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));

// `mockCallable` is the underlying callable function both `startCheckout` and
// `openBillingPortal` invoke; `mockHttpsCallable` wraps `httpsCallable` itself
// so tests can assert WHICH function name each wrapper resolved — a plain
// `httpsCallable: () => mockCallable` (the prior shape) ignores its `name`
// argument entirely, so swapping "createCheckoutSession" and
// "createPortalSession" in billingService.ts would still pass every test
// here silently, with no Stripe account to ever catch it at runtime.
const mockCallable = jest.fn();
const mockHttpsCallable = jest.fn((..._args: unknown[]) => mockCallable);
jest.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => mockHttpsCallable(...args),
}));

import * as fs from "firebase/firestore";
import { makeDocSnap } from "../../test-utils/firestoreMock";
import {
  mapSubscriptionDoc,
  isEntitledToPro,
  hasKnownRenewalDate,
  getSubscription,
  startCheckout,
  openBillingPortal,
  BillingCallableError,
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

  it("returns null for a runtime null doc without throwing", () => {
    // `data == null`, not `=== undefined`: a `snap.data()` that returns
    // `null` (or a caller outside TypeScript's view) must not reach
    // `data.status` and throw — that throw is exactly what the
    // tolerant-reader convention exists to prevent.
    expect(mapSubscriptionDoc(null)).toBeNull();
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

  it("entitles a trialing subscription — the server also grants Pro for it", () => {
    // The webhook's own PRO_STATUSES (functions/src/http/stripeWebhook.ts) is
    // {active, trialing}, and writes plan: "pro" for a trialing subscription.
    // "trialing" isn't a member of the SubscriptionStatus union, but
    // mapSubscriptionDoc passes it through untouched at runtime, so this
    // function must recognize the raw string, not just the typed union.
    expect(isEntitledToPro({ status: "trialing" } as never, 0)).toBe(true);
  });
});

describe("hasKnownRenewalDate", () => {
  it("is false for the unknown-renewal sentinel (0)", () => {
    expect(hasKnownRenewalDate({ currentPeriodEndMs: 0 } as never)).toBe(false);
  });

  it("is true for a real renewal timestamp", () => {
    expect(hasKnownRenewalDate({ currentPeriodEndMs: 1_700_000_000_000 } as never)).toBe(true);
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
    // Pins WHICH function name httpsCallable resolved — swapping this for
    // "createPortalSession" in billingService.ts would otherwise still pass
    // every other assertion in this file, since both wrappers share one
    // mocked callable.
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), "createCheckoutSession");
  });

  it("throws a readable error when the callable rejects", async () => {
    mockCallable.mockRejectedValueOnce(new Error("failed-precondition: already on a plan"));
    await expect(startCheckout("ws1")).rejects.toThrow(/already on a plan/);
  });

  it("preserves the callable's code and details on rejection, not just its message", async () => {
    // The double-checkout guard (functions/src/callable/
    // createCheckoutSession.ts) throws HttpsError with `details.reason` so a
    // UI can branch on structured data instead of regex-matching a message —
    // this wrapper must not discard that on the way through.
    const rejection = Object.assign(new Error("This workspace's subscription needs attention."), {
      code: "failed-precondition",
      details: { reason: "subscription-exists", canOpenPortal: true },
    });
    mockCallable.mockRejectedValueOnce(rejection);
    const err = await startCheckout("ws1").catch((e) => e);
    expect(err).toBeInstanceOf(BillingCallableError);
    expect(err.code).toBe("failed-precondition");
    expect(err.details).toEqual({ reason: "subscription-exists", canOpenPortal: true });
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
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), "createPortalSession");
  });

  it("throws a readable error when the callable rejects", async () => {
    mockCallable.mockRejectedValueOnce(new Error("failed-precondition: no billing account"));
    await expect(openBillingPortal("ws1")).rejects.toThrow(/no billing account/);
  });

  it("preserves the callable's code and details on rejection, not just its message", async () => {
    const rejection = Object.assign(new Error("no billing account"), {
      code: "failed-precondition",
      details: undefined,
    });
    mockCallable.mockRejectedValueOnce(rejection);
    const err = await openBillingPortal("ws1").catch((e) => e);
    expect(err).toBeInstanceOf(BillingCallableError);
    expect(err.code).toBe("failed-precondition");
  });

  it("throws when the callable resolves with no url", async () => {
    mockCallable.mockResolvedValueOnce({ data: {} });
    await expect(openBillingPortal("ws1")).rejects.toThrow(/portal/i);
  });
});
