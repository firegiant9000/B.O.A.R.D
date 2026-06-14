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

import * as fbAuth from "firebase/auth";
import * as fs from "firebase/firestore";
import { makeDocSnap } from "../../test-utils/firestoreMock";
import { auth } from "../../config/firebase";
import * as authService from "../authService";
import { ensurePersonalWorkspace } from "../workspaceService";

const createUser = fbAuth.createUserWithEmailAndPassword as jest.Mock;
const signInFb = fbAuth.signInWithEmailAndPassword as jest.Mock;
const updateProfile = fbAuth.updateProfile as jest.Mock;
const sendEmailVerification = fbAuth.sendEmailVerification as jest.Mock;
const sendPasswordResetEmail = fbAuth.sendPasswordResetEmail as jest.Mock;
const reload = fbAuth.reload as jest.Mock;
const setDoc = fs.setDoc as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const ensurePersonalWorkspaceMock = ensurePersonalWorkspace as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (auth as any).currentUser = null;
  // Default: no profile doc yet, so provisioning writes one.
  getDoc.mockResolvedValue(makeDocSnap("u1", null));
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
