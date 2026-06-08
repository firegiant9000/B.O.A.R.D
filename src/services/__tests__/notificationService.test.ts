jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));
jest.mock("../../lib/errorReporting", () => ({ captureException: jest.fn() }));

const mockNotifications = {
  __esModule: true,
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  AndroidImportance: { MAX: 5 },
};
jest.mock("expo-notifications", () => mockNotifications);

import * as notificationService from "../notificationService";
import { captureException } from "../../lib/errorReporting";

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).fetch = jest.fn(async () => ({ ok: true }));
});

describe("sendSessionPushNotifications", () => {
  it("does nothing when there are no tokens", async () => {
    await notificationService.sendSessionPushNotifications([], "S", "B", "Arlo");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts one message per token to the Expo push API", async () => {
    await notificationService.sendSessionPushNotifications(
      ["tok-1", "tok-2"],
      "Study",
      "Board",
      "Arlo"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ to: "tok-1", title: "Session: Study" });
  });

  it("reports (does not throw) when delivery fails", async () => {
    (global as any).fetch = jest.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      notificationService.sendSessionPushNotifications(["tok-1"], "S", "B", "A")
    ).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe("registerForPushNotifications", () => {
  it("returns null and reports when permission is denied", async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValueOnce({ status: "denied" });
    mockNotifications.requestPermissionsAsync.mockResolvedValueOnce({ status: "denied" });
    const token = await notificationService.registerForPushNotifications("u1");
    expect(token).toBeNull();
  });

  it("returns the token and persists it when granted", async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValueOnce({ status: "granted" });
    mockNotifications.getExpoPushTokenAsync.mockResolvedValueOnce({ data: "expo-tok" });
    const token = await notificationService.registerForPushNotifications("u1");
    expect(token).toBe("expo-tok");
  });
});
