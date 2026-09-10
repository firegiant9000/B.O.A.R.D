import type Stripe from "stripe";
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
    await expect(handleCreateCheckoutSession(reqFor(undefined, { workspaceId: "ws1" }), deps()))
      .rejects.toThrow();
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

  it("stamps the workspace id as client_reference_id", async () => {
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
  });

  it("throws when Stripe returns a session with no url, instead of returning an empty URL", async () => {
    const fakeStripe: StripeCheckoutClient = {
      checkout: { sessions: { create: jest.fn(async () => ({ url: null })) } },
    };
    await expect(
      createCheckoutSession(fakeStripe, "price_123", { workspaceId: "ws1", uid: "u1" })
    ).rejects.toMatchObject({ code: "internal" });
  });
});
