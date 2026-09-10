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

const deps = (
  opts: {
    role?: string;
    plan?: unknown;
    /** The raw `workspaces/{id}/billing/subscription` doc `getSubscriptionStatus`
     *  resolves to. `undefined` (the default) means no subscription document
     *  exists at all — the ordinary case. Pass an object (even `{}`, an
     *  existing doc with no `status` field) to simulate one that does. */
    subscriptionDoc?: Record<string, unknown>;
  } = {}
) => {
  // `plan` is deliberately `unknown` so a test can hand in a garbage runtime
  // value (e.g. "__proto__") to exercise the fail-closed plan check; cast at
  // the boundary so the mock still satisfies CreateCheckoutSessionDeps.
  const plan = (opts.plan ?? "free") as string;
  return {
    getWorkspace: jest.fn(async () => ({
      plan,
      members: { u1: opts.role ?? "owner" },
    })),
    getSubscriptionStatus: jest.fn(async () => opts.subscriptionDoc ?? null),
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

describe("handleCreateCheckoutSession — the double-checkout guard", () => {
  // `plan` alone cannot catch these: every case below keeps `plan: "free"`
  // (the default from `deps()`), exactly the state a workspace is in before
  // its webhook event lands, or after a downgrade — so only the subscription
  // document read distinguishes them. See the header comment on
  // functions/src/callable/createCheckoutSession.ts for the exact rationale.

  it("blocks a second checkout while the recorded subscription is active", async () => {
    const d = deps({ subscriptionDoc: { status: "active" } });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "failed-precondition" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("blocks a second checkout while the recorded subscription is trialing", async () => {
    const d = deps({ subscriptionDoc: { status: "trialing" } });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "failed-precondition" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("blocks a second checkout while the first session's payment is still incomplete", async () => {
    // The "unsettled async payment" case from evaluateCheckoutSession in
    // functions/src/http/stripeWebhook.ts: `status: "incomplete"`, `plan`
    // left unchanged (still "free"). This is the case a `plan`-only check
    // cannot see at all.
    const d = deps({ subscriptionDoc: { status: "incomplete" } });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "failed-precondition" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("blocks a second checkout while the subscription is past_due", async () => {
    const d = deps({ subscriptionDoc: { status: "past_due" } });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "failed-precondition" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("blocks a second checkout while the subscription is unpaid (downgraded, not deleted), pointing at the portal", async () => {
    // Also a `plan`-only blind spot: "unpaid" is one of the webhook's
    // REVOKE_STATUSES, so `plan` has already reverted to "free" here — but
    // the Stripe subscription object itself still exists. The Customer
    // Portal, not a second Checkout, is the intended fix — and, unlike
    // "This workspace already has an active plan" (the plan check's
    // message, which would be false here since `plan` is "free"),
    // `details.reason` says the caller has a subscription to manage.
    const d = deps({ subscriptionDoc: { status: "unpaid" } });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d)).rejects.toMatchObject({
      code: "failed-precondition",
      details: { reason: "subscription-exists", canOpenPortal: true },
    });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("blocks a second checkout while the subscription is paused, with an honest operator-only message", async () => {
    // "paused" comes from `pause_collection`, which is operator-set — the
    // Customer Portal has no resume control for it, so this denial must NOT
    // claim the portal is the fix (that would be the false statement flagged
    // in review): it gets its own message and details.
    const d = deps({ subscriptionDoc: { status: "paused" } });
    const err = await handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d).catch(
      (e) => e
    );
    expect(err).toMatchObject({
      code: "failed-precondition",
      details: { reason: "subscription-paused", canOpenPortal: false },
    });
    expect(err.message).not.toMatch(/billing portal/i);
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("blocks a second checkout on an unrecognized status this file has never heard of", async () => {
    // Deny-unless-provably-permitted: a future Stripe status must not
    // silently fall through to "permitted" just because this file's allowlist
    // doesn't name it.
    const d = deps({ subscriptionDoc: { status: "some_future_status" } });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "failed-precondition" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("blocks a second checkout when the subscription document exists but its status is unreadable", async () => {
    // Fail closed on an unreadable document (brief requirement), not on its
    // absence: an existing-but-corrupt/partial doc must not be trusted to
    // permit a second charge.
    const d = deps({ subscriptionDoc: {} });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "failed-precondition" });
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("permits checkout when the prior subscription is canceled", async () => {
    const d = deps({ subscriptionDoc: { status: "canceled" } });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .resolves.toEqual({ url: "https://checkout.stripe.test/s/1" });
    expect(d.createSession).toHaveBeenCalledTimes(1);
  });

  it("permits checkout when the prior subscription's first invoice expired unpaid", async () => {
    const d = deps({ subscriptionDoc: { status: "incomplete_expired" } });
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .resolves.toEqual({ url: "https://checkout.stripe.test/s/1" });
    expect(d.createSession).toHaveBeenCalledTimes(1);
  });

  it("permits checkout when no subscription document exists at all", async () => {
    // The ordinary case: a workspace that has never paid. `subscriptionDoc`
    // is omitted, so `getSubscriptionStatus` resolves `null` (see `deps()`).
    const d = deps();
    await expect(handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .resolves.toEqual({ url: "https://checkout.stripe.test/s/1" });
    expect(d.getSubscriptionStatus).toHaveBeenCalledWith("ws1");
    expect(d.createSession).toHaveBeenCalledTimes(1);
  });

  it("propagates a failure to read the subscription document instead of treating it as absent", async () => {
    // "Fail closed on an unreadable subscription document" — a thrown read
    // must not be swallowed and defaulted to "no subscription, go ahead".
    const d = deps();
    d.getSubscriptionStatus.mockRejectedValueOnce(new Error("firestore unavailable"));
    await expect(
      handleCreateCheckoutSession(reqFor("u1", { workspaceId: "ws1" }), d)
    ).rejects.toThrow("firestore unavailable");
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("denies distinguishably from the plan check, which carries no details", async () => {
    // Both the guard and the `plan !== "free"` check above it use the SAME
    // `failed-precondition` code — before this, a caller had no way to tell
    // them apart except by matching the message string. `details.reason`
    // (guard-only) is that signal now, and it must actually differ, not just
    // exist as a type.
    const guardBlocked = deps({ subscriptionDoc: { status: "active" } });
    const guardErr = await handleCreateCheckoutSession(
      reqFor("u1", { workspaceId: "ws1" }),
      guardBlocked
    ).catch((e) => e);
    expect(guardErr.code).toBe("failed-precondition");
    expect(guardErr.details).toEqual({ reason: "subscription-exists", canOpenPortal: true });

    const planBlocked = deps({ plan: "pro" });
    const planErr = await handleCreateCheckoutSession(
      reqFor("u1", { workspaceId: "ws1" }),
      planBlocked
    ).catch((e) => e);
    expect(planErr.code).toBe("failed-precondition");
    // The plan check throws `new HttpsError(code, message)` with no third
    // argument — HttpsError's `details` defaults to `undefined` in that case
    // — so this is the concrete "no signal" the guard's denial improves on.
    expect(planErr.details).toBeUndefined();
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
