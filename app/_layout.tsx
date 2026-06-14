import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack, useRouter, useSegments } from "expo-router";
import * as Sentry from "@sentry/react-native";
import {
  ShareIntentProvider,
  useShareIntentContext,
} from "expo-share-intent";
import { AuthProvider } from "../src/contexts/AuthContext";
import { WorkspaceProvider } from "../src/contexts/WorkspaceContext";
import { useAuth } from "../src/hooks/useAuth";
import LoadingScreen from "../src/components/LoadingScreen";
import ErrorBoundary from "../src/components/ErrorBoundary";
import PWAInstallPrompt from "../src/components/PWAInstallPrompt";
import { initErrorReporting, captureException } from "../src/lib/errorReporting";
import { initConnectivity } from "../src/lib/connectivity";
import { classifyShare, handleSharedItem } from "../src/lib/shareIntake";
import { setPendingShare } from "../src/lib/pendingShare";
import {
  registerForPushNotifications,
  configureForegroundHandler,
  addSessionTapListener,
  addMentionTapListener,
} from "../src/services/notificationService";
import { loadOpenAIKey } from "../src/services/aiService";

initErrorReporting();
initConnectivity();
configureForegroundHandler();

/**
 * Routes an inbound OS share (Android SEND / iOS Share Extension via
 * `expo-share-intent`). A shared link/text is parsed through the deep-link
 * contract and navigated inline; shared image(s) are stashed and the user is sent
 * to the `/share` board-picker to place them. No-ops on web and until signed in.
 */
function useIncomingShare(authed: boolean): void {
  const { isReady, hasShareIntent, shareIntent, resetShareIntent } =
    useShareIntentContext();
  const router = useRouter();

  useEffect(() => {
    if (!isReady || !hasShareIntent || !authed) return;
    try {
      const images = (shareIntent.files ?? []).filter((f) =>
        f.mimeType?.startsWith("image/")
      );
      if (images.length > 0) {
        setPendingShare(
          images.map((f) => ({
            uri: f.path,
            width: f.width ?? 0,
            height: f.height ?? 0,
            name: f.fileName ?? "shared-image",
          }))
        );
        router.push("/share");
      } else {
        // Link / text: route through the same contract as the share-sheet logic.
        const raw = shareIntent.webUrl ?? shareIntent.text ?? "";
        const item = classifyShare({ text: raw });
        const outcome = item ? handleSharedItem(item) : null;
        if (outcome?.action === "open-board") {
          router.push(`/board/${outcome.boardId}`);
        } else if (outcome?.action === "join-invite") {
          router.push(`/b/${outcome.inviteCode}`);
        }
        // Unsupported text is silently ignored (nothing to place).
      }
    } catch (e) {
      captureException(e, { op: "incomingShare" });
    } finally {
      resetShareIntent();
    }
    // shareIntent is replaced wholesale on each share; key off the ready flags.
  }, [isReady, hasShareIntent, authed]);
}

function RootNavigator() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useIncomingShare(!!user);

  // Register for push notifications and load remote API key once authenticated
  useEffect(() => {
    if (user) {
      registerForPushNotifications(user.uid);
      loadOpenAIKey();
    }
  }, [user?.uid]);

  // Deep-link a tapped session notification straight to that session.
  useEffect(() => {
    let unsubscribe = () => {};
    addSessionTapListener((data) => {
      router.push(`/session/${data.sessionId}`);
    }).then((fn) => {
      unsubscribe = fn;
    });
    return () => unsubscribe();
  }, [router]);

  // Deep-link a tapped mention notification to the board it lives on (Phase 10).
  useEffect(() => {
    let unsubscribe = () => {};
    addMentionTapListener((data) => {
      if (data.boardId) router.push(`/board/${data.boardId}`);
    }).then((fn) => {
      unsubscribe = fn;
    });
    return () => unsubscribe();
  }, [router]);

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === "(auth)";

    if (!user && !inAuthGroup) {
      router.replace("/(auth)/login");
    } else if (user && inAuthGroup) {
      router.replace("/(tabs)");
    }
  }, [user, loading, segments]);

  if (loading) {
    return <LoadingScreen />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      {/* Universal/App Link landing: https://<domain>/b/{inviteCode} (Phase 4). */}
      <Stack.Screen name="b/[code]" />
      <Stack.Screen name="board/[id]" options={{ presentation: "modal" }} />
      {/* Share-target board picker for an inbound image share (Phase 4). */}
      <Stack.Screen name="share" options={{ presentation: "modal" }} />
      <Stack.Screen name="session/create" options={{ presentation: "modal" }} />
      <Stack.Screen name="session/[id]" options={{ presentation: "modal" }} />
      {/* In-app notifications inbox (Phase 10). */}
      <Stack.Screen name="notifications" options={{ presentation: "modal" }} />
    </Stack>
  );
}

function RootLayout() {
  return (
    // ShareIntentProvider must sit above the navigator so a cold-start share (the
    // app was launched by the share sheet) is captured before the first render.
    <ShareIntentProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ErrorBoundary>
          <AuthProvider>
            {/* WorkspaceProvider sits under AuthProvider (it reads the signed-in
                user) and above the navigator so the active-workspace switcher and
                workspace-scoped reads are available everywhere (Phase 3). */}
            <WorkspaceProvider>
              <RootNavigator />
              {/* Web-only PWA install banner; renders null on native (Phase 5). */}
              <PWAInstallPrompt />
            </WorkspaceProvider>
          </AuthProvider>
        </ErrorBoundary>
      </GestureHandlerRootView>
    </ShareIntentProvider>
  );
}

// Sentry.wrap adds touch/navigation breadcrumbs and a native crash handler. It is
// a no-op when Sentry is not initialized (no DSN), so dev/Expo Go is unaffected.
export default Sentry.wrap(RootLayout);
