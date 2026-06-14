import {
  doc,
  updateDoc,
  getDoc,
  collection,
  addDoc,
  query,
  orderBy,
  limit as limitTo,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  getDocs,
} from "firebase/firestore";
import Constants from "expo-constants";
import { db } from "../config/firebase";
import { captureException } from "../lib/errorReporting";
import { AppNotification, NotificationPref } from "../types";
import { toPlainText } from "../lib/mentions";

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
      // Phase 10: a separate channel for @-mentions so users can tune them apart
      // from session alerts in OS settings.
      await Notifications.setNotificationChannelAsync("mentions", {
        name: "Mentions",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 200],
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

// ── Phase 10: notification preferences ─────────────────────────────────────────

/**
 * Default preferences for a user with no `notificationPref` on their doc (every
 * pre-Phase-10 account, plus the field is optional): push on mention is on, and the
 * daily email digest is opted-in. Reads default to this so the absence of the field
 * never reads as "all off".
 */
export const DEFAULT_NOTIFICATION_PREF: NotificationPref = {
  pushOnMention: true,
  emailDigest: true,
};

/** Reads a user's notification preferences, defaulting missing fields. */
export async function getNotificationPref(userId: string): Promise<NotificationPref> {
  try {
    const snap = await getDoc(doc(db, "users", userId));
    const pref = snap.exists() ? (snap.data().notificationPref as Partial<NotificationPref>) : null;
    return { ...DEFAULT_NOTIFICATION_PREF, ...(pref ?? {}) };
  } catch (e) {
    captureException(e, { op: "getNotificationPref" });
    return DEFAULT_NOTIFICATION_PREF;
  }
}

/** Updates (merges) a user's notification preferences on their user doc. */
export async function updateNotificationPref(
  userId: string,
  patch: Partial<NotificationPref>
): Promise<void> {
  const current = await getNotificationPref(userId);
  await updateDoc(doc(db, "users", userId), {
    notificationPref: { ...current, ...patch },
  });
}

// ── Phase 10: in-app notifications (users/{uid}/notifications) ───────────────────

function notificationsRef(userId: string) {
  return collection(db, "users", userId, "notifications");
}

function mapNotification(id: string, data: any): AppNotification {
  return {
    id,
    recipientId: data.recipientId ?? "",
    type: (data.type ?? "mention") as AppNotification["type"],
    actorId: data.actorId ?? "",
    actorName: data.actorName ?? "Someone",
    boardId: data.boardId ?? "",
    boardTitle: data.boardTitle ?? "a board",
    commentId: data.commentId ?? "",
    snippet: data.snippet ?? "",
    read: !!data.read,
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

/** Realtime subscription to a user's in-app notifications, newest-first. */
export function subscribeToNotifications(
  userId: string,
  onChange: (items: AppNotification[]) => void,
  max = 50
): () => void {
  const q = query(notificationsRef(userId), orderBy("createdAt", "desc"), limitTo(max));
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => mapNotification(d.id, d.data())));
  });
}

/** Marks a single notification read. */
export async function markNotificationRead(
  userId: string,
  notificationId: string
): Promise<void> {
  await updateDoc(doc(db, "users", userId, "notifications", notificationId), { read: true });
}

/** Marks every unread notification read, in 500-doc batches. */
export async function markAllNotificationsRead(userId: string): Promise<void> {
  const snap = await getDocs(notificationsRef(userId));
  const unread = snap.docs.filter((d) => !d.data().read);
  for (let i = 0; i < unread.length; i += 500) {
    const batch = writeBatch(db);
    unread.slice(i, i + 500).forEach((d) => batch.update(d.ref, { read: true }));
    await batch.commit();
  }
}

// ── Phase 10: mention notification fan-out ───────────────────────────────────────

export interface MentionNotificationData {
  type: "mention";
  boardId: string;
  commentId: string;
}

function asMentionData(data: unknown): MentionNotificationData | null {
  const d = data as Partial<MentionNotificationData> | undefined;
  if (d?.type === "mention" && typeof d.boardId === "string") {
    return { type: "mention", boardId: d.boardId, commentId: d.commentId ?? "" };
  }
  return null;
}

export interface MentionFanoutArgs {
  /** uids @-mentioned in the comment/reply body (already parsed). */
  mentionUids: string[];
  actorId: string;
  actorName: string;
  boardId: string;
  boardTitle: string;
  commentId: string;
  /** The comment/reply body — collapsed to plain text for the snippet/push body. */
  body: string;
}

/**
 * Fans a mention out to each mentioned member: writes an in-app notification doc
 * (always) and sends a push to those whose `pushOnMention` preference is on. The
 * author is never notified about their own mention. Fire-and-forget by contract —
 * a failure here must never block the comment write that triggered it, so the whole
 * routine swallows and reports errors rather than throwing.
 *
 * The daily email digest (the other Phase 10 channel) has no delivery backend this
 * month; `emailDigest` is recorded as a preference and a later milestone reads it.
 */
export async function notifyMentions(args: MentionFanoutArgs): Promise<void> {
  const recipients = Array.from(new Set(args.mentionUids)).filter((uid) => uid !== args.actorId);
  if (recipients.length === 0) return;

  const snippet = toPlainText(args.body).slice(0, 140);
  const pushTokens: string[] = [];

  await Promise.all(
    recipients.map(async (uid) => {
      try {
        const snap = await getDoc(doc(db, "users", uid));
        if (!snap.exists()) return;
        const data = snap.data();
        const pref: NotificationPref = { ...DEFAULT_NOTIFICATION_PREF, ...(data.notificationPref ?? {}) };

        // In-app notification always lands (the user can mute push but still has an
        // inbox). actorId is pinned to the caller to satisfy the create rule.
        await addDoc(notificationsRef(uid), {
          recipientId: uid,
          type: "mention",
          actorId: args.actorId,
          actorName: args.actorName,
          boardId: args.boardId,
          boardTitle: args.boardTitle,
          commentId: args.commentId,
          snippet,
          read: false,
          createdAt: serverTimestamp(),
        });

        if (pref.pushOnMention && typeof data.pushToken === "string" && data.pushToken) {
          pushTokens.push(data.pushToken);
        }
      } catch (e) {
        captureException(e, { op: "notifyMentions.recipient", uid });
      }
    })
  );

  if (pushTokens.length > 0) {
    await sendMentionPushNotifications(pushTokens, args.actorName, args.boardTitle, snippet, {
      boardId: args.boardId,
      commentId: args.commentId,
    });
  }
}

/**
 * Sends a mention push to a list of Expo push tokens. Mirrors
 * `sendSessionPushNotifications` (chunked, ticket-inspected, non-fatal); the tapped
 * notification deep-links to the board via the `mention` payload.
 */
export async function sendMentionPushNotifications(
  tokens: string[],
  actorName: string,
  boardTitle: string,
  snippet: string,
  ids: { boardId: string; commentId: string }
): Promise<void> {
  if (tokens.length === 0) return;

  const messages = tokens.map((to) => ({
    to,
    sound: "default",
    title: `${actorName} mentioned you`,
    body: snippet ? `${snippet}` : `on "${boardTitle}"`,
    data: { type: "mention", boardId: ids.boardId, commentId: ids.commentId },
    channelId: "mentions",
  }));

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
      const json = await res.json().catch(() => null);
      const tickets: Array<{ status?: string; message?: string }> = json?.data ?? [];
      const failed = tickets.filter((t) => t.status === "error");
      if (!res.ok || failed.length > 0) {
        captureException(
          new Error(
            `Expo push (mention): ${failed.length || "request"} failed` +
              (failed[0]?.message ? ` — ${failed[0].message}` : "")
          ),
          { op: "sendMentionPushNotifications", httpStatus: res.status }
        );
      }
    }
  } catch (error) {
    captureException(error, { op: "sendMentionPushNotifications" });
  }
}

/**
 * Routes a tapped mention notification to its board (cold-start + warm cases),
 * mirroring `addSessionTapListener`. Returns an unsubscribe function.
 */
export async function addMentionTapListener(
  onTap: (data: MentionNotificationData) => void
): Promise<() => void> {
  try {
    const Notifications = await import("expo-notifications");

    const last = await Notifications.getLastNotificationResponseAsync();
    const coldData = asMentionData(last?.notification.request.content.data);
    if (coldData) onTap(coldData);

    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      const data = asMentionData(res.notification.request.content.data);
      if (data) onTap(data);
    });
    return () => sub.remove();
  } catch (e) {
    captureException(e, { op: "addMentionTapListener" });
    return () => {};
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
