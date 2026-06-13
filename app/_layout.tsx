import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack, useRouter, useSegments } from "expo-router";
import * as Sentry from "@sentry/react-native";
import { AuthProvider } from "../src/contexts/AuthContext";
import { useAuth } from "../src/hooks/useAuth";
import LoadingScreen from "../src/components/LoadingScreen";
import ErrorBoundary from "../src/components/ErrorBoundary";
import PWAInstallPrompt from "../src/components/PWAInstallPrompt";
import { initErrorReporting } from "../src/lib/errorReporting";
import { initConnectivity } from "../src/lib/connectivity";
import {
  registerForPushNotifications,
  configureForegroundHandler,
  addSessionTapListener,
} from "../src/services/notificationService";
import { loadOpenAIKey } from "../src/services/aiService";

initErrorReporting();
initConnectivity();
configureForegroundHandler();

function RootNavigator() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

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
      <Stack.Screen name="session/create" options={{ presentation: "modal" }} />
      <Stack.Screen name="session/[id]" options={{ presentation: "modal" }} />
    </Stack>
  );
}

function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <AuthProvider>
          <RootNavigator />
          {/* Web-only PWA install banner; renders null on native (Phase 5). */}
          <PWAInstallPrompt />
        </AuthProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

// Sentry.wrap adds touch/navigation breadcrumbs and a native crash handler. It is
// a no-op when Sentry is not initialized (no DSN), so dev/Expo Go is unaffected.
export default Sentry.wrap(RootLayout);
