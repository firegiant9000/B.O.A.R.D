import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

/**
 * Install-to-home-screen banner (Month 2, Phase 5 — PWA).
 *
 * Web-only. Chromium fires `beforeinstallprompt` when the PWA is installable; we
 * stash that event (instead of letting the browser show its mini-infobar) and
 * surface our own "Install" affordance, calling `prompt()` on tap. Renders
 * nothing on native, on browsers that never fire the event (iOS Safari — users
 * install via the Share → Add to Home Screen menu), or once already installed.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function PWAInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    const onBeforeInstall = (e: Event) => {
      // Suppress the default mini-infobar; we drive install from our own button.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!deferred) return null;

  const install = async () => {
    const event = deferred;
    setDeferred(null);
    await event.prompt();
    await event.userChoice;
  };

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.label}>Install B.O.A.R.D for a full-screen, offline-ready app.</Text>
      <View style={styles.actions}>
        <Pressable
          onPress={install}
          accessibilityRole="button"
          accessibilityLabel="Install app"
          style={styles.installBtn}
        >
          <Text style={styles.installText}>Install</Text>
        </Pressable>
        <Pressable
          onPress={() => setDeferred(null)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss install prompt"
          style={styles.dismissBtn}
        >
          <Text style={styles.dismissText}>Not now</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    bottom: 16,
    left: 16,
    right: 16,
    maxWidth: 480,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "#1e293b",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  label: { flex: 1, color: "#fff", fontSize: 14 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8 },
  installBtn: {
    backgroundColor: "#2563eb",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  installText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  dismissBtn: { paddingVertical: 8, paddingHorizontal: 8 },
  dismissText: { color: "#94a3b8", fontSize: 14 },
});
