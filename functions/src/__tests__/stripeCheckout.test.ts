import Stripe from "stripe";
import { HttpsError } from "firebase-functions/v2/https";
import { handleCreateCheckoutSession } from "../callable/createCheckoutSession";
import {
  assertStripeConfigured,
  createCheckoutSession,
  type StripeCheckoutClient,
} from "../billing/stripe";

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

const deps = (opts: { role?: string; plan?: unknown } = {}) => {
  // `plan` is deliberately `unknown` so a test can hand in a garbage runtime
  // value (e.g. "__proto__") to exercise the fail-closed plan check; cast at
  // the boundary so the mock still satisfies CreateCheckoutSessionDeps.
  const plan = (opts.plan ?? "free") as string;
  return {
    getWorkspace: jest.fn(async () => ({
      plan,
      members: { u1: opts.role ?? "owner" },
    })),
    createSession: jest.fn(async () => ({ url: "https://checkout.stripe.test/s/1" })),
  };
};

describe("handleCreateCheckoutSession", () => {
  it("rejects an unauthenticated caller", async () => {
    // Asserts the actual error code, not merely that something threw — a
    // bare `.rejects.toThrow()` would also pass on an unrelated TypeError.
    await expect(handleCreateCheckoutSession(reqFor(undefined, { workspaceId: "ws1" }), deps()))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects a non-owner", async () => {
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), deps({ role: "member" })))
      .rejects.toThrow(/owner/i);
  });

  it("returns a checkout url for the owner", async () => {
    const d = deps();
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .resolves.toEqual({ url: "https://checkout.stripe.test/s/1" });
  });

  it("passes the workspace id and the token's uid through to createSession", async () => {
    // `client_reference_id` itself is a billing/stripe.ts-level detail (see
    // the "createCheckoutSession (billing/stripe.ts)" tests below) — at the
    // handler level, all that's observable is what reaches the dep.
    const d = deps();
    await handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d);
    expect(d.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws1", uid: "u1" })
    );
  });

  it("ignores a client-supplied priceId", async () => {
    const d = deps();
    await handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1", priceId: "price_cheap" } as never), d);
    expect(JSON.stringify(d.createSession.mock.calls[0])).not.toContain("price_cheap");
  });

  it("rejects a request with no workspaceId", async () => {
    const d = deps();
    await expect(handleCreateCheckoutSession(reqFor("u1", {}), d))
      .rejects.toMatchObject({ code: "invalid-argument" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("rejects when the workspace does not exist", async () => {
    const d = deps();
    d.getWorkspace.mockResolvedValueOnce(null as never);
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "not-found" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("rejects a caller who is not a member at all (not merely the wrong role)", async () => {
    // Distinct from the "non-owner" test above: here `u1` is absent from
    // `members` entirely, so `members[uid]` is `undefined`, not a string. The
    // `!== "owner"` comparison must still deny rather than throwing or,
    // worse, coercing an absent key into a pass.
    const d = deps();
    d.getWorkspace.mockResolvedValueOnce({ plan: "free", members: { other: "owner" } } as never);
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "permission-denied" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("rejects a workspace that is already on a paid plan", async () => {
    const d = deps({ plan: "pro" });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "failed-precondition" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("rejects a workspace already on the edu plan (not just literally 'pro')", async () => {
    const d = deps({ plan: "edu" });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "failed-precondition" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("fails closed on a garbage plan value instead of treating it as free", async () => {
    // Mirrors the createBoard/createSession __proto__ hardening: an
    // unrecognized plan string must not be treated as eligible for checkout.
    const d = deps({ plan: "__proto__" });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "failed-precondition" });
    expect(d.createSession).not.toHaveBeenCalled();
  });
});

describe("assertStripeConfigured", () => {
  it("throws when the secret key is missing", () => {
    expect(() => assertStripeConfigured("", "price_123")).toThrow(HttpsError);
    try {
      assertStripeConfigured("", "price_123");
      throw new Error("expected assertStripeConfigured to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpsError);
      expect((err as HttpsError).code).toBe("failed-precondition");
    }
  });

  it("throws when the price id is missing", () => {
    expect(() => assertStripeConfigured("sk_test_123", "")).toThrow(HttpsError);
    try {
      assertStripeConfigured("sk_test_123", "");
      throw new Error("expected assertStripeConfigured to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpsError);
      expect((err as HttpsError).code).toBe("failed-precondition");
    }
  });

  it("does not throw when both are present", () => {
    expect(() => assertStripeConfigured("sk_test_123", "price_123")).not.toThrow();
  });
});

describe("createCheckoutSession (billing/stripe.ts)", () => {
  it("passes the server-resolved price, never a client-chosen one, to Stripe", async () => {
    const create = jest.fn(async (_params: Stripe.Checkout.SessionCreateParams) => ({
      url: "https://checkout.stripe.test/s/2",
    }));
    const fakeStripe: StripeCheckoutClient = { checkout: { sessions: { create } } };

    await createCheckoutSession(fakeStripe, "price_server_resolved", {
      workspaceId: "ws1",
      uid: "u1",
    });

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0];
    expect(params.mode).toBe("subscription");
    expect(params.line_items).toEqual([{ price: "price_server_resolved", quantity: 1 }]);
    expect(params.client_reference_id).toBe("ws1");
    expect(params.metadata).toEqual({ workspaceId: "ws1", uid: "u1" });
    // Load-bearing for the webhook, not for checkout: Stripe does not copy
    // session metadata onto the subscription, and subscription/invoice events
    // carry neither `client_reference_id` nor the session's metadata. Drop
    // this and every downgrade path in functions/src/http/stripeWebhook.ts
    // loses its only way to identify the workspace.
    expect(params.subscription_data?.metadata).toEqual({ workspaceId: "ws1", uid: "u1" });
    // Load-bearing for a live call (Stripe's hosted Checkout rejects a
    // session with no success_url at runtime, even though the TS types mark
    // it optional for the embedded-ui_mode case this app doesn't use) — a
    // later refactor that dropped these would break checkout with a Stripe
    // 4xx and nothing here would go red without this assertion.
    expect(typeof params.success_url).toBe("string");
    expect(params.success_url).toBeTruthy();
    expect(typeof params.cancel_url).toBe("string");
    expect(params.cancel_url).toBeTruthy();
  });

  it("throws when Stripe returns a session with no url, instead of returning an empty URL", async () => {
    const fakeStripe: StripeCheckoutClient = {
      checkout: { sessions: { create: jest.fn(async () => ({ url: null })) } },
    };
    await expect(
      createCheckoutSession(fakeStripe, "price_123", { workspaceId: "ws1", uid: "u1" })
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("maps a StripeInvalidRequestError to a caller-safe failed-precondition, not a leaked Stripe message", async () => {
    // Simulates a real misconfiguration Stripe would reject at the API level
    // (an archived price, a one-time price used with mode: "subscription",
    // ...) rather than something a fake client just makes up. The raw Stripe
    // message can name the price id or key mode, so it must not reach the
    // caller verbatim -- only the error CODE is asserted here.
    const stripeErr = new Stripe.errors.StripeInvalidRequestError({
      message: "This price is not a recurring price and cannot be used with mode=subscription.",
      type: "invalid_request_error",
    } as never);
    const fakeStripe: StripeCheckoutClient = {
      checkout: {
        sessions: {
          create: jest.fn(async () => {
            throw stripeErr;
          }),
        },
      },
    };

    await expect(
      createCheckoutSession(fakeStripe, "price_bad", { workspaceId: "ws1", uid: "u1" })
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("does not map a non-Stripe error, letting it propagate for the default internal scrub", async () => {
    const networkErr = new Error("ECONNRESET");
    const fakeStripe: StripeCheckoutClient = {
      checkout: {
        sessions: {
          create: jest.fn(async () => {
            throw networkErr;
          }),
        },
      },
    };

    await expect(
      createCheckoutSession(fakeStripe, "price_123", { workspaceId: "ws1", uid: "u1" })
    ).rejects.toBe(networkErr);
  });
});
