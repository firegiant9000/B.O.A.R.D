import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useConnectivity } from "../hooks/useConnectivity";

/**
 * Phase 6 connectivity banner.
 *
 *  - Offline  → amber "you're offline, changes will sync" notice.
 *  - Online but writes still flushing → subtle "Syncing…" notice.
 *  - Online and settled → renders nothing.
 *
 * Reads the connectivity store directly, so the host screen only has to mount it.
 */
export default function OfflineBanner() {
  const { online, pendingWrites } = useConnectivity();

  if (!online) {
    return (
      <View style={[styles.banner, styles.offline]}>
        <Ionicons name="cloud-offline-outline" size={15} color="#92400e" />
        <Text style={[styles.text, styles.offlineText]}>
          You&apos;re offline. Changes will sync when you reconnect.
        </Text>
      </View>
    );
  }

  if (pendingWrites) {
    return (
      <View style={[styles.banner, styles.syncing]}>
        <Ionicons name="sync-outline" size={15} color="#1d4ed8" />
        <Text style={[styles.text, styles.syncingText]}>Syncing changes…</Text>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  offline: {
    backgroundColor: "#fffbeb",
    borderBottomColor: "#fde68a",
  },
  syncing: {
    backgroundColor: "#eff6ff",
    borderBottomColor: "#bfdbfe",
  },
  text: {
    flex: 1,
    fontSize: 13,
  },
  offlineText: {
    color: "#92400e",
  },
  syncingText: {
    color: "#1d4ed8",
  },
});
