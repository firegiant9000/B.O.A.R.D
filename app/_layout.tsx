import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { AuthProvider } from "../src/contexts/AuthContext";
import { useAuth } from "../src/hooks/useAuth";
import LoadingScreen from "../src/components/LoadingScreen";
import ErrorBoundary from "../src/components/ErrorBoundary";
import { initErrorReporting } from "../src/lib/errorReporting";
import { registerForPushNotifications } from "../src/services/notificationService";
import { loadOpenAIKey } from "../src/services/aiService";

initErrorReporting();

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
      <Stack.Screen name="board/[id]" options={{ presentation: "modal" }} />
      <Stack.Screen name="session/create" options={{ presentation: "modal" }} />
      <Stack.Screen name="session/[id]" options={{ presentation: "modal" }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </ErrorBoundary>
  );
}
