jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: jest.fn(),
  signInWithEmailAndPassword: jest.fn(),
  signOut: jest.fn(async () => undefined),
  updateProfile: jest.fn(async () => undefined),
  sendEmailVerification: jest.fn(async () => undefined),
  sendPasswordResetEmail: jest.fn(async () => undefined),
  reload: jest.fn(async () => undefined),
}));
jest.mock("../../config/firebase", () => ({
  db: {},
  auth: { __type: "auth", currentUser: null },
}));
jest.mock("../workspaceService", () => ({
  ensurePersonalWorkspace: jest.fn(async () => "ws-1"),
}));
jest.mock("../onboardingService", () => ({
  seedSampleWorkspace: jest.fn(async () => undefined),
}));
// Month 6 — this module now emits `signup`. Mocked rather than left real:
// with no PostHog key configured the real seam no-ops silently, so the
// fire-once assertions at the bottom of this file would pass without ever
// observing an emit.
jest.mock("../analyticsService");

import * as fbAuth from "firebase/auth";
import * as fs from "firebase/firestore";
import { makeDocSnap } from "../../test-utils/firestoreMock";
import { auth } from "../../config/firebase";
import * as authService from "../authService";
import { ensurePersonalWorkspace } from "../workspaceService";
import { seedSampleWorkspace } from "../onboardingService";
import { track } from "../analyticsService";

const createUser = fbAuth.createUserWithEmailAndPassword as jest.Mock;
const signInFb = fbAuth.signInWithEmailAndPassword as jest.Mock;
const updateProfile = fbAuth.updateProfile as jest.Mock;
const sendEmailVerification = fbAuth.sendEmailVerification as jest.Mock;
const sendPasswordResetEmail = fbAuth.sendPasswordResetEmail as jest.Mock;
const reload = fbAuth.reload as jest.Mock;
const setDoc = fs.setDoc as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const ensurePersonalWorkspaceMock = ensurePersonalWorkspace as jest.Mock;
const seedSampleWorkspaceMock = seedSampleWorkspace as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (auth as any).currentUser = null;
  // Default: no profile doc yet, so provisioning writes one.
  getDoc.mockResolvedValue(makeDocSnap("u1", null));
  ensurePersonalWorkspaceMock.mockResolvedValue("ws-1");
});

describe("signUp", () => {
  it("creates the account, sets the display name, writes the doc, and sends verification", async () => {
    const user = { uid: "u1", email: "a@x.z" };
    createUser.mockResolvedValueOnce({ user });

    const result = await authService.signUp("a@x.z", "pw", "Arlo");

    expect(result).toBe(user);
    expect(updateProfile).toHaveBeenCalledWith(user, { displayName: "Arlo" });
    expect(sendEmailVerification).toHaveBeenCalledWith(user);
    const [ref, data] = setDoc.mock.calls[0];
    expect(ref.path).toEqual(["users", "u1"]);
    expect(data).toMatchObject({ email: "a@x.z", displayName: "Arlo" });
    expect(data.createdAt).toBe("__serverTimestamp__");
  });

  it("auto-creates the new user's personal workspace", async () => {
    const user = { uid: "u1", email: "a@x.z" };
    createUser.mockResolvedValueOnce({ user });

    await authService.signUp("a@x.z", "pw", "Arlo");

    expect(ensurePersonalWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(ensurePersonalWorkspaceMock).toHaveBeenCalledWith("u1");
  });

  it("still resolves when the verification email fails to send", async () => {
    const user = { uid: "u1", email: "a@x.z" };
    createUser.mockResolvedValueOnce({ user });
    sendEmailVerification.mockRejectedValueOnce(new Error("rate limited"));

    await expect(authService.signUp("a@x.z", "pw", "Arlo")).resolves.toBe(user);
  });

  it("still resolves when the personal-workspace write fails", async () => {
    const user = { uid: "u1", email: "a@x.z" };
    createUser.mockResolvedValueOnce({ user });
    ensurePersonalWorkspaceMock.mockRejectedValueOnce(
      new Error("ws write lagged")
    );

    await expect(authService.signUp("a@x.z", "pw", "Arlo")).resolves.toBe(user);
  });

  it("seeds the new signup's sample workspace — the real hook for ROADMAP's sample workspace seeding", async () => {
    const user = { uid: "u1", email: "a@x.z" };
    createUser.mockResolvedValueOnce({ user });

    await authService.signUp("a@x.z", "pw", "Arlo");

    expect(seedSampleWorkspaceMock).toHaveBeenCalledWith("ws-1", "u1", "Arlo");
  });
});

describe("ensureUserProvisioned", () => {
  it("writes the profile doc and personal workspace when the doc is absent", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));
    const user = { uid: "u1", email: "g@x.z", displayName: "Gina" };

    await authService.ensureUserProvisioned(user as any);

    const [ref, data] = setDoc.mock.calls[0];
    expect(ref.path).toEqual(["users", "u1"]);
    expect(data).toMatchObject({ email: "g@x.z", displayName: "Gina" });
    expect(ensurePersonalWorkspaceMock).toHaveBeenCalledWith("u1");
  });

  it("does not overwrite an existing profile doc but still ensures the workspace", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", { email: "g@x.z" }));
    const user = { uid: "u1", email: "g@x.z", displayName: "Gina" };

    await authService.ensureUserProvisioned(user as any);

    expect(setDoc).not.toHaveBeenCalled();
    expect(ensurePersonalWorkspaceMock).toHaveBeenCalledWith("u1");
  });

  it("prefers an explicit displayName over the auth record's", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));
    const user = { uid: "u1", email: "g@x.z", displayName: "stale" };

    await authService.ensureUserProvisioned(user as any, "Override");

    expect(setDoc.mock.calls[0][1]).toMatchObject({ displayName: "Override" });
  });

  it("resolves even when the workspace write fails", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));
    ensurePersonalWorkspaceMock.mockRejectedValueOnce(new Error("lagged"));
    const user = { uid: "u1", email: "g@x.z", displayName: "Gina" };

    await expect(
      authService.ensureUserProvisioned(user as any)
    ).resolves.toBeUndefined();
  });

  // Month 6 — sample workspace seeding (task-28-brief.md). These tests guard
  // the single real hook point: a genuinely new account seeds a sample
  // workspace once; a returning sign-in for an EXISTING account never does,
  // no matter how many times ensureUserProvisioned is called for it.
  describe("sample workspace seeding", () => {
    it("seeds the sample workspace for a brand-new account", async () => {
      getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));
      ensurePersonalWorkspaceMock.mockResolvedValueOnce("ws-1");
      const user = { uid: "u1", email: "g@x.z", displayName: "Gina" };

      await authService.ensureUserProvisioned(user as any);

      expect(seedSampleWorkspaceMock).toHaveBeenCalledTimes(1);
      expect(seedSampleWorkspaceMock).toHaveBeenCalledWith("ws-1", "u1", "Gina");
    });

    it("does NOT seed for an existing account merely reconciling its workspace on a returning sign-in", async () => {
      // Profile doc already exists -> not a new account.
      getDoc.mockResolvedValueOnce(makeDocSnap("u1", { email: "g@x.z" }));
      ensurePersonalWorkspaceMock.mockResolvedValueOnce("ws-1");
      const user = { uid: "u1", email: "g@x.z", displayName: "Gina" };

      await authService.ensureUserProvisioned(user as any);

      expect(seedSampleWorkspaceMock).not.toHaveBeenCalled();
    });

    it("does not seed when the personal-workspace write failed (no workspace id to seed onto)", async () => {
      getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));
      ensurePersonalWorkspaceMock.mockRejectedValueOnce(new Error("lagged"));
      const user = { uid: "u1", email: "g@x.z", displayName: "Gina" };

      await authService.ensureUserProvisioned(user as any);

      expect(seedSampleWorkspaceMock).not.toHaveBeenCalled();
    });

    it("resolves even when seedSampleWorkspace rejects, as defense in depth", async () => {
      getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));
      seedSampleWorkspaceMock.mockRejectedValueOnce(new Error("seed failed"));
      const user = { uid: "u1", email: "g@x.z", displayName: "Gina" };

      await expect(
        authService.ensureUserProvisioned(user as any)
      ).resolves.toBeUndefined();
    });

    it("prefers the explicit displayName override over the auth record's for the seed's createdByName", async () => {
      getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));
      const user = { uid: "u1", email: "g@x.z", displayName: "stale" };

      await authService.ensureUserProvisioned(user as any, "Override");

      expect(seedSampleWorkspaceMock).toHaveBeenCalledWith("ws-1", "u1", "Override");
    });
  });
});

describe("sendPasswordReset", () => {
  it("delegates to firebase with the auth instance and email", async () => {
    await authService.sendPasswordReset("a@x.z");
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(auth, "a@x.z");
  });
});

describe("sendVerificationEmail", () => {
  it("sends to the current user", async () => {
    const user = { uid: "u1" };
    (auth as any).currentUser = user;
    await authService.sendVerificationEmail();
    expect(sendEmailVerification).toHaveBeenCalledWith(user);
  });

  it("throws when no one is signed in", async () => {
    await expect(authService.sendVerificationEmail()).rejects.toThrow(
      "Not signed in."
    );
  });
});

describe("reloadUser", () => {
  it("returns false when no one is signed in", async () => {
    expect(await authService.reloadUser()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads and returns the latest emailVerified flag", async () => {
    const user = { uid: "u1", emailVerified: true };
    (auth as any).currentUser = user;
    expect(await authService.reloadUser()).toBe(true);
    expect(reload).toHaveBeenCalledWith(user);
  });
});

describe("signIn", () => {
  it("returns the authenticated user", async () => {
    const user = { uid: "u1" };
    signInFb.mockResolvedValueOnce({ user });
    expect(await authService.signIn("a@x.z", "pw")).toBe(user);
  });
});

describe("signOut", () => {
  it("delegates to firebase signOut", async () => {
    await authService.signOut();
    expect(fbAuth.signOut).toHaveBeenCalledTimes(1);
  });
});

// Month 6 — ROADMAP.md:685's `signup`, the top of the funnel. Emitted inside
// `ensureUserProvisioned`'s `isNewAccount` branch rather than in `signUp`,
// because `signUp` is only the email path — social first-sign-in reaches this
// function with no signup step of its own (see authService.ts's header). These
// pin both halves of "once per new account, never per sign-in".
describe("signup analytics", () => {
  const mockTrack = track as jest.Mock;
  const signups = () => mockTrack.mock.calls.filter(([event]) => event === "signup");

  it("emits signup when the profile doc is created", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));

    await authService.ensureUserProvisioned({ uid: "u1", email: "g@x.z" } as any);

    expect(signups()).toHaveLength(1);
  });

  // THE test. `ensureUserProvisioned` runs on EVERY returning Google sign-in
  // (authProviders.ts), so an emit outside the isNewAccount branch would count
  // every sign-in as an acquisition and make the funnel's first number a
  // measure of engagement instead.
  it("does NOT emit on a later sign-in, when the profile doc already exists", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", { email: "g@x.z" }));

    await authService.ensureUserProvisioned({ uid: "u1", email: "g@x.z" } as any);

    expect(signups()).toHaveLength(0);
  });

  it("emits exactly once for an email signup, not once per provisioning step", async () => {
    const user = { uid: "u1", email: "a@x.z" };
    createUser.mockResolvedValueOnce({ user });

    await authService.signUp("a@x.z", "pw", "Arlo");

    expect(signups()).toHaveLength(1);
  });

  it("still emits when the personal workspace or the sample seed fails — an account that exists is a signup", async () => {
    // Both of those steps are explicitly best-effort (see the comments around
    // them), so a signup must not be reported only when they happen to work.
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));
    ensurePersonalWorkspaceMock.mockRejectedValueOnce(new Error("offline"));

    await authService.ensureUserProvisioned({ uid: "u1", email: "g@x.z" } as any);

    expect(signups()).toHaveLength(1);
    expect(seedSampleWorkspaceMock).not.toHaveBeenCalled();
  });

  it("carries no properties at all — uid, email and display name are the only facts in hand, and all three are forbidden", () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", null));
    return authService
      .ensureUserProvisioned({ uid: "u1", email: "g@x.z", displayName: "Gina" } as any)
      .then(() => {
        expect(signups()[0]).toEqual(["signup"]);
      });
  });
});
