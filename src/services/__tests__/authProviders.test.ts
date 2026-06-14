const mockPromptAsync = jest.fn();
const mockCredential = jest.fn((..._a: any[]) => ({ __type: "cred" }));
const mockSignInWithCredential = jest.fn(async (..._a: any[]) => ({
  user: { uid: "g1", email: "g@x.z" },
}));

jest.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "nonce-123" }));
jest.mock("expo-auth-session", () => ({
  ResponseType: { IdToken: "id_token" },
  makeRedirectUri: jest.fn(() => "boardapp://redirect"),
  AuthRequest: jest.fn().mockImplementation(() => ({
    promptAsync: mockPromptAsync,
  })),
}));
jest.mock("firebase/auth", () => ({
  GoogleAuthProvider: { credential: (...a: any[]) => mockCredential(...a) },
  signInWithCredential: (...a: any[]) => mockSignInWithCredential(...a),
}));
jest.mock("../../config/firebase", () => ({ auth: { __type: "auth" } }));
jest.mock("../authService", () => ({
  ensureUserProvisioned: jest.fn(async () => undefined),
}));

import { ensureUserProvisioned } from "../authService";

const ensureProvisionedMock = ensureUserProvisioned as jest.Mock;

const WEB_ID = "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID";

/** Load authProviders fresh so module-load-time env reads (isAvailable) re-evaluate. */
function loadProviders() {
  let mod: typeof import("../authProviders");
  jest.isolateModules(() => {
    mod = require("../authProviders");
  });
  return mod!;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[WEB_ID];
});

describe("getProvider('google')", () => {
  it("is unavailable and refuses to sign in when no client ID is configured", async () => {
    const { getProvider } = loadProviders();
    const provider = getProvider("google");

    expect(provider.isAvailable).toBe(false);
    await expect(provider.signIn()).rejects.toThrow(/not configured/i);
  });

  it("is available once a client ID is configured", () => {
    process.env[WEB_ID] = "web-client.apps.googleusercontent.com";
    const { getProvider } = loadProviders();
    expect(getProvider("google").isAvailable).toBe(true);
  });

  it("exchanges the Google ID token for a Firebase credential and provisions the user", async () => {
    process.env[WEB_ID] = "web-client.apps.googleusercontent.com";
    mockPromptAsync.mockResolvedValueOnce({
      type: "success",
      params: { id_token: "google-tok" },
    });

    const { getProvider } = loadProviders();
    const user = await getProvider("google").signIn();

    expect(mockCredential).toHaveBeenCalledWith("google-tok");
    expect(mockSignInWithCredential).toHaveBeenCalled();
    expect(ensureProvisionedMock).toHaveBeenCalledWith(user);
    expect(user).toMatchObject({ uid: "g1" });
  });

  it("throws a cancellation error when the user dismisses the flow", async () => {
    process.env[WEB_ID] = "web-client.apps.googleusercontent.com";
    mockPromptAsync.mockResolvedValueOnce({ type: "cancel" });

    const { getProvider } = loadProviders();
    await expect(getProvider("google").signIn()).rejects.toThrow(/cancel/i);
    expect(mockSignInWithCredential).not.toHaveBeenCalled();
  });

  it("throws when no ID token comes back", async () => {
    process.env[WEB_ID] = "web-client.apps.googleusercontent.com";
    mockPromptAsync.mockResolvedValueOnce({ type: "success", params: {} });

    const { getProvider } = loadProviders();
    await expect(getProvider("google").signIn()).rejects.toThrow(/ID token/i);
  });
});
