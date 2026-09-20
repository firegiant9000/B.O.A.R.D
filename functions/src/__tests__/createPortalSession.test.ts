import Stripe from "stripe";
import {
  handleCreatePortalSession,
  createBillingPortalSession,
  type CreatePortalSessionDeps,
  type StripeBillingPortalClient,
} from "../callable/createPortalSession";

function reqFor(uid: string | undefined, data: unknown) {
  return { auth: uid ? { uid } : undefined, data } as never;
}

const deps = (
  opts: { role?: string; stripeCustomerId?: string | null } = {}
): CreatePortalSessionDeps & {
  getWorkspace: jest.Mock;
  getStripeCustomerId: jest.Mock;
  createPortalSession: jest.Mock;
} => ({
  getWorkspace: jest.fn(async () => ({ members: { u1: opts.role ?? "owner" } })),
  getStripeCustomerId: jest.fn(
    async () => (opts.stripeCustomerId === undefined ? "cus_123" : opts.stripeCustomerId)
  ),
  createPortalSession: jest.fn(async () => ({ url: "https://billing.stripe.test/p/1" })),
});

describe("handleCreatePortalSession", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(handleCreatePortalSession(reqFor(undefined, { workspaceId: "ws1" }), deps()))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects a request with no workspaceId", async () => {
    const d = deps();
    await expect(handleCreatePortalSession(reqFor("u1", {}), d))
      .rejects.toMatchObject({ code: "invalid-argument" });
    expect(d.createPortalSession).not.toHaveBeenCalled();
  });

  it("rejects when the workspace does not exist", async () => {
    const d = deps();
    d.getWorkspace.mockResolvedValueOnce(null as never);
    await expect(handleCreatePortalSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "not-found" });
    expect(d.createPortalSession).not.toHaveBeenCalled();
  });

  it("rejects a non-owner", async () => {
    const d = deps({ role: "member" });
    await expect(handleCreatePortalSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "permission-denied" });
    expect(d.createPortalSession).not.toHaveBeenCalled();
  });

  it("rejects a caller who is not a member at all (not merely the wrong role)", async () => {
    const d = deps();
    d.getWorkspace.mockResolvedValueOnce({ members: { other: "owner" } } as never);
    await expect(handleCreatePortalSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "permission-denied" });
    expect(d.createPortalSession).not.toHaveBeenCalled();
  });

  it("rejects a workspace with no Stripe customer id (never paid)", async () => {
    const d = deps({ stripeCustomerId: null });
    await expect(handleCreatePortalSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .rejects.toMatchObject({ code: "failed-precondition" });
    expect(d.createPortalSession).not.toHaveBeenCalled();
  });

  it("returns the portal url for the owner of a workspace with a Stripe customer id", async () => {
    const d = deps();
    await expect(handleCreatePortalSession(reqFor("u1", { workspaceId: "ws1" }), d))
      .resolves.toEqual({ url: "https://billing.stripe.test/p/1" });
  });

  it("passes the resolved customer id through to createPortalSession", async () => {
    const d = deps({ stripeCustomerId: "cus_abc" });
    await handleCreatePortalSession(reqFor("u1", { workspaceId: "ws1" }), d);
    expect(d.createPortalSession).toHaveBeenCalledWith("cus_abc");
  });
});

describe("createBillingPortalSession (the real Stripe-calling function, not a reimplementation)", () => {
  // Mirrors how stripeCheckout.test.ts exercises billing/stripe.ts's
  // createCheckoutSession: against a fake Stripe-shaped client, asserting on
  // the params sent and on the error-mapping behaviour, not on a mock's own
  // return value. `createPortalSession` (the onCall binding) calls exactly
  // this function, so these tests cover the real code path end to end.

  function fakeStripe(create: jest.Mock): StripeBillingPortalClient {
    return { billingPortal: { sessions: { create } } };
  }

  it("sends the resolved customer id and the given return_url to Stripe", async () => {
    const create = jest.fn(async () => ({ url: "https://billing.stripe.test/p/2" }));
    await createBillingPortalSession(fakeStripe(create), "cus_1", "boardapp://billing");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ customer: "cus_1", return_url: "boardapp://billing" });
  });

  it("returns the url Stripe gives back", async () => {
    const create = jest.fn(async () => ({ url: "https://billing.stripe.test/p/2" }));
    await expect(
      createBillingPortalSession(fakeStripe(create), "cus_1", "boardapp://billing")
    ).resolves.toEqual({ url: "https://billing.stripe.test/p/2" });
  });

  it("throws when Stripe returns a session with no url, instead of returning an empty URL", async () => {
    const create = jest.fn(async () => ({ url: "" }));
    await expect(
      createBillingPortalSession(fakeStripe(create), "cus_1", "boardapp://billing")
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("maps a StripeInvalidRequestError to a caller-safe failed-precondition, not a leaked Stripe message", async () => {
    // Simulates a real misconfiguration Stripe would reject at the API level
    // (e.g. no default portal configuration created for the account) rather
    // than something a fake client just makes up. The raw Stripe message can
    // name account details, so it must not reach the caller verbatim — only
    // the error CODE is asserted here.
    const stripeErr = new Stripe.errors.StripeInvalidRequestError({
      message:
        "No configuration provided and your test mode default configuration has not been created.",
      type: "invalid_request_error",
    } as never);
    const create = jest.fn(async () => {
      throw stripeErr;
    });
    await expect(
      createBillingPortalSession(fakeStripe(create), "cus_1", "boardapp://billing")
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("does not map a non-Stripe error, letting it propagate for the default internal scrub", async () => {
    const networkErr = new Error("ECONNRESET");
    const create = jest.fn(async () => {
      throw networkErr;
    });
    await expect(
      createBillingPortalSession(fakeStripe(create), "cus_1", "boardapp://billing")
    ).rejects.toBe(networkErr);
  });
});
