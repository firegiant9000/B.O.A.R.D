jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));
jest.mock("../../lib/errorReporting", () => ({ captureException: jest.fn() }));

const mockNotifications = {
  __esModule: true,
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  setNotificationHandler: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(async (): Promise<any> => null),
  addNotificationResponseReceivedListener: jest.fn((_cb?: any) => ({ remove: jest.fn() })),
  AndroidImportance: { MAX: 5 },
};

const IDS = { sessionId: "sess-1", boardId: "board-1" };
jest.mock("expo-notifications", () => mockNotifications);
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: "proj-123" } } } },
}));

import * as notificationService from "../notificationService";
import { captureException } from "../../lib/errorReporting";

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ status: "ok" }] }),
  }));
});

describe("sendSessionPushNotifications", () => {
  it("does nothing when there are no tokens", async () => {
    await notificationService.sendSessionPushNotifications([], "S", "B", "Arlo", IDS);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts one message per token to the Expo push API", async () => {
    await notificationService.sendSessionPushNotifications(
      ["tok-1", "tok-2"],
      "Study",
      "Board",
      "Arlo",
      IDS
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ to: "tok-1", title: "Session: Study" });
  });

  it("includes session and board ids in the payload for deep-linking", async () => {
    await notificationService.sendSessionPushNotifications(["tok-1"], "S", "B", "A", IDS);
    const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
    expect(body[0].data).toEqual({
      type: "session",
      sessionId: "sess-1",
      boardId: "board-1",
    });
  });

  it("reports (does not throw) when delivery fails", async () => {
    (global as any).fetch = jest.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      notificationService.sendSessionPushNotifications(["tok-1"], "S", "B", "A", IDS)
    ).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("reports when a ticket comes back with an error status", async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ status: "error", message: "DeviceNotRegistered" }],
      }),
    }));
    await notificationService.sendSessionPushNotifications(["tok-1"], "S", "B", "A", IDS);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("splits more than 100 messages into separate requests", async () => {
    const tokens = Array.from({ length: 150 }, (_, i) => `tok-${i}`);
    await notificationService.sendSessionPushNotifications(tokens, "S", "B", "A", IDS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("addSessionTapListener", () => {
  it("fires immediately for a cold-start session tap", async () => {
    mockNotifications.getLastNotificationResponseAsync.mockResolvedValueOnce({
      notification: {
        request: { content: { data: { type: "session", sessionId: "s9", boardId: "b9" } } },
      },
    });
    const onTap = jest.fn();
    await notificationService.addSessionTapListener(onTap);
    expect(onTap).toHaveBeenCalledWith({ type: "session", sessionId: "s9", boardId: "b9" });
  });

  it("forwards a warm tap and ignores non-session notifications", async () => {
    let captured: (res: any) => void = () => {};
    mockNotifications.addNotificationResponseReceivedListener.mockImplementationOnce(
      (cb: any) => {
        captured = cb;
        return { remove: jest.fn() };
      }
    );
    const onTap = jest.fn();
    await notificationService.addSessionTapListener(onTap);

    captured({ notification: { request: { content: { data: { type: "other" } } } } });
    expect(onTap).not.toHaveBeenCalled();

    captured({
      notification: {
        request: { content: { data: { type: "session", sessionId: "s1", boardId: "b1" } } },
      },
    });
    expect(onTap).toHaveBeenCalledWith({ type: "session", sessionId: "s1", boardId: "b1" });
  });

  it("returns an unsubscribe that removes the listener", async () => {
    const remove = jest.fn();
    mockNotifications.addNotificationResponseReceivedListener.mockReturnValueOnce({ remove });
    const unsubscribe = await notificationService.addSessionTapListener(jest.fn());
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
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

  it("passes the EAS projectId so tokens work in standalone builds", async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValueOnce({ status: "granted" });
    mockNotifications.getExpoPushTokenAsync.mockResolvedValueOnce({ data: "expo-tok" });
    await notificationService.registerForPushNotifications("u1");
    expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: "proj-123",
    });
  });
});
