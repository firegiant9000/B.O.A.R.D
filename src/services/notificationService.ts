import { doc, updateDoc } from "firebase/firestore";
import { db } from "../config/firebase";
import { captureException } from "../lib/errorReporting";

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

    const tokenData = await Notifications.getExpoPushTokenAsync();
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
  adminName: string
): Promise<void> {
  if (tokens.length === 0) return;

  const messages = tokens.map((to) => ({
    to,
    sound: "default",
    title: `Session: ${sessionTitle}`,
    body: `${adminName} has started a session on "${boardTitle}". Join now!`,
    data: { type: "session" },
    channelId: "sessions",
  }));

  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });
  } catch (error) {
    // Non-fatal — session is still created even if the push fails
    captureException(error, { op: "sendSessionPushNotifications" });
  }
}
