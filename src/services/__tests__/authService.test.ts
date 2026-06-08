jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: jest.fn(),
  signInWithEmailAndPassword: jest.fn(),
  signOut: jest.fn(async () => undefined),
  updateProfile: jest.fn(async () => undefined),
}));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { __type: "auth" } }));

import * as fbAuth from "firebase/auth";
import * as fs from "firebase/firestore";
import * as authService from "../authService";

const createUser = fbAuth.createUserWithEmailAndPassword as jest.Mock;
const signInFb = fbAuth.signInWithEmailAndPassword as jest.Mock;
const updateProfile = fbAuth.updateProfile as jest.Mock;
const setDoc = fs.setDoc as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("signUp", () => {
  it("creates the account, sets the display name, and writes the user doc", async () => {
    const user = { uid: "u1", email: "a@x.z" };
    createUser.mockResolvedValueOnce({ user });

    const result = await authService.signUp("a@x.z", "pw", "Arlo");

    expect(result).toBe(user);
    expect(updateProfile).toHaveBeenCalledWith(user, { displayName: "Arlo" });
    const [ref, data] = setDoc.mock.calls[0];
    expect(ref.path).toEqual(["users", "u1"]);
    expect(data).toMatchObject({ email: "a@x.z", displayName: "Arlo" });
    expect(data.createdAt).toBe("__serverTimestamp__");
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
