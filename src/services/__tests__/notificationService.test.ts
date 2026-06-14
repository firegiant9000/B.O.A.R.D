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
import * as fs from "firebase/firestore";
import { makeDocSnap, makeQuerySnap } from "../../test-utils/firestoreMock";
import { captureException } from "../../lib/errorReporting";

const getDoc = fs.getDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const addDoc = fs.addDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;

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

// ── Phase 10 ──────────────────────────────────────────────────────────────────

describe("getNotificationPref", () => {
  it("defaults missing fields to DEFAULT_NOTIFICATION_PREF", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("u1", { displayName: "A" }));
    expect(await notificationService.getNotificationPref("u1")).toEqual(
      notificationService.DEFAULT_NOTIFICATION_PREF
    );
  });

  it("merges a partial stored pref over the defaults", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("u1", { notificationPref: { pushOnMention: false } })
    );
    expect(await notificationService.getNotificationPref("u1")).toEqual({
      pushOnMention: false,
      emailDigest: true,
    });
  });
});

describe("updateNotificationPref", () => {
  it("merges the patch over the current pref and writes it", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("u1", { notificationPref: { pushOnMention: true, emailDigest: true } })
    );
    await notificationService.updateNotificationPref("u1", { emailDigest: false });
    expect(updateDoc.mock.calls[0][1]).toEqual({
      notificationPref: { pushOnMention: true, emailDigest: false },
    });
  });
});

describe("notifyMentions", () => {
  const baseArgs = {
    actorId: "author",
    actorName: "Author",
    boardId: "b1",
    boardTitle: "Calc HW",
    commentId: "c1",
    body: "hey @[Bob](u-bob) look",
  };

  it("never notifies the author about their own mention", async () => {
    await notificationService.notifyMentions({ ...baseArgs, mentionUids: ["author"] });
    expect(addDoc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes an in-app notification per recipient and pushes to those who opt in", async () => {
    getDoc
      .mockResolvedValueOnce(
        makeDocSnap("u-bob", { pushToken: "ExpoTok[bob]", notificationPref: { pushOnMention: true } })
      )
      .mockResolvedValueOnce(
        makeDocSnap("u-cara", { pushToken: "ExpoTok[cara]", notificationPref: { pushOnMention: false } })
      );

    await notificationService.notifyMentions({
      ...baseArgs,
      mentionUids: ["u-bob", "u-cara", "author"],
    });

    expect(addDoc).toHaveBeenCalledTimes(2);
    const payloads = addDoc.mock.calls.map((c) => c[1]);
    expect(payloads.every((p) => p.type === "mention" && p.actorId === "author")).toBe(true);
    expect(payloads.map((p) => p.recipientId).sort()).toEqual(["u-bob", "u-cara"]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.map((m: any) => m.to)).toEqual(["ExpoTok[bob]"]);
    expect(body[0].data).toEqual({ type: "mention", boardId: "b1", commentId: "c1" });
  });

  it("does not push when no recipient has push enabled", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("u-bob", { pushToken: "tok", notificationPref: { pushOnMention: false } })
    );
    await notificationService.notifyMentions({ ...baseArgs, mentionUids: ["u-bob"] });
    expect(addDoc).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("in-app notification read state", () => {
  it("markNotificationRead flips read on the addressed doc", async () => {
    await notificationService.markNotificationRead("u1", "n1");
    expect((fs.doc as jest.Mock).mock.calls.at(-1)).toEqual([
      {},
      "users",
      "u1",
      "notifications",
      "n1",
    ]);
    expect(updateDoc.mock.calls[0][1]).toEqual({ read: true });
  });

  it("markAllNotificationsRead only updates the unread docs", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["n1", { read: false }],
        ["n2", { read: true }],
        ["n3", { read: false }],
      ])
    );
    const batch = { update: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);

    await notificationService.markAllNotificationsRead("u1");

    expect(batch.update).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("addMentionTapListener fires on a cold-start mention tap", async () => {
    mockNotifications.getLastNotificationResponseAsync.mockResolvedValueOnce({
      notification: {
        request: { content: { data: { type: "mention", boardId: "b9", commentId: "c9" } } },
      },
    });
    const onTap = jest.fn();
    await notificationService.addMentionTapListener(onTap);
    expect(onTap).toHaveBeenCalledWith({ type: "mention", boardId: "b9", commentId: "c9" });
  });
});
