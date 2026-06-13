import { doc, updateDoc } from "firebase/firestore";
import Constants from "expo-constants";
import { db } from "../config/firebase";
import { captureException } from "../lib/errorReporting";

/**
 * Resolves the EAS project ID. Standalone (store) builds — unlike Expo Go —
 * cannot infer it, so `getExpoPushTokenAsync` must be given it explicitly or it
 * fails to mint a token. `eas init` (Phase 2) writes `extra.eas.projectId` to
 * app.json and also exposes it via `Constants.easConfig`.
 */
function getEasProjectId(): string | undefined {
  return (
    (Constants.expoConfig?.extra?.eas?.projectId as string | undefined) ??
    (Constants as any).easConfig?.projectId
  );
}

/**
 * Requests notification permissions and registers the device's Expo push token,
 * saving it to the user's Firestore profile.
 *
 * Requires `expo-notifications` to be installed:
 *   npx expo install expo-notifications
 *
 * Returns the token string on success, or null if permissions were denied or
 * the package is unavailable.
 */
export async function registerForPushNotifications(userId: string): Promise<string | null> {
  try {
    // Dynamic import so the rest of the app still boots if the package is missing
    const Notifications = await import("expo-notifications");
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;

    if (existing !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") return null;

    // Pass the EAS project ID so the call works in standalone builds, not just
    // Expo Go. Without it, a store build throws here and no token is minted.
    const projectId = getEasProjectId();
    const tokenData = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    const token = tokenData.data;

    await updateDoc(doc(db, "users", userId), { pushToken: token });

    // On Android, a notification channel is required for the heads-up banner
    const { Platform } = await import("react-native");
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("sessions", {
        name: "Board Sessions",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    return token;
  } catch (e) {
    // expo-notifications not installed or permissions unavailable — non-fatal,
    // but report so it's visible rather than silently dropped.
    captureException(e, { op: "registerForPushNotifications" });
    return null;
  }
}

/**
 * Sends a push notification to a list of Expo push tokens via the Expo Push API.
 * This is a direct client-side call — suitable for development and small apps.
 * For production, move this to a server/Cloud Function to protect tokens.
 */
export async function sendSessionPushNotifications(
  tokens: string[],
  sessionTitle: string,
  boardTitle: string,
  adminName: string,
  ids: { sessionId: string; boardId: string }
): Promise<void> {
  if (tokens.length === 0) return;

  const messages = tokens.map((to) => ({
    to,
    sound: "default",
    title: `Session: ${sessionTitle}`,
    body: `${adminName} has started a session on "${boardTitle}". Join now!`,
    // IDs travel in the payload so a tapped notification can deep-link straight
    // to the session (see addSessionTapListener).
    data: { type: "session", sessionId: ids.sessionId, boardId: ids.boardId },
    channelId: "sessions",
  }));

  // Expo's push endpoint accepts at most 100 messages per request.
  const chunks: (typeof messages)[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    chunks.push(messages.slice(i, i + 100));
  }

  try {
    for (const chunk of chunks) {
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(chunk),
      });

      // The endpoint returns 200 with per-message tickets; an "error" status on
      // a ticket (e.g. DeviceNotRegistered) won't throw, so inspect the body.
      const json = await res.json().catch(() => null);
      const tickets: Array<{ status?: string; message?: string }> =
        json?.data ?? [];
      const failed = tickets.filter((t) => t.status === "error");
      if (!res.ok || failed.length > 0) {
        captureException(
          new Error(
            `Expo push: ${failed.length || "request"} failed` +
              (failed[0]?.message ? ` — ${failed[0].message}` : "")
          ),
          { op: "sendSessionPushNotifications", httpStatus: res.status }
        );
      }
    }
  } catch (error) {
    // Non-fatal — session is still created even if the push fails
    captureException(error, { op: "sendSessionPushNotifications" });
  }
}

export interface SessionNotificationData {
  type: "session";
  sessionId: string;
  boardId: string;
}

function asSessionData(data: unknown): SessionNotificationData | null {
  const d = data as Partial<SessionNotificationData> | undefined;
  if (d?.type === "session" && typeof d.sessionId === "string") {
    return { type: "session", sessionId: d.sessionId, boardId: d.boardId ?? "" };
  }
  return null;
}

/**
 * Makes notifications visible while the app is foregrounded. Without this,
 * a push that lands while the app is open is delivered silently. Safe to call
 * at module load; no-ops if expo-notifications is unavailable.
 */
export async function configureForegroundHandler(): Promise<void> {
  try {
    const Notifications = await import("expo-notifications");
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch (e) {
    captureException(e, { op: "configureForegroundHandler" });
  }
}

/**
 * Routes notification taps to the session they reference. Handles both the
 * warm case (a listener while the app runs) and the cold-start case (the app
 * was launched by tapping the notification). Returns an unsubscribe function.
 */
export async function addSessionTapListener(
  onTap: (data: SessionNotificationData) => void
): Promise<() => void> {
  try {
    const Notifications = await import("expo-notifications");

    // Cold start: the app was opened by tapping a notification.
    const last = await Notifications.getLastNotificationResponseAsync();
    const coldData = asSessionData(
      last?.notification.request.content.data
    );
    if (coldData) onTap(coldData);

    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      const data = asSessionData(res.notification.request.content.data);
      if (data) onTap(data);
    });
    return () => sub.remove();
  } catch (e) {
    captureException(e, { op: "addSessionTapListener" });
    return () => {};
  }
}
