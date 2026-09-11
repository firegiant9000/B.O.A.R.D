import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

/**
 * Month 5 — the audience-facing presenter-mode banner.
 *
 * Props-only: this component owns no subscription and calls no service — the
 * hook (`useBoardCollab`'s `activePresenter`) owns the cursor subscription
 * and decides *whether* to render this at all. Passing `presenterName: null`
 * renders nothing, so the caller can wire it as
 * `<PresentingBanner presenterName={collab.activePresenter?.displayName ?? null}
 * paused={collab.activePresenter?.paused ?? false} />` without an extra
 * conditional.
 *
 * Deliberately has no dismiss affordance (unlike the "Following X" banner):
 * an active presenter overrides every individual follow choice (precedence
 * case 1 in `src/lib/presenter.ts`), so there is nothing for the audience to
 * opt out of here. A paused presentation (case 2) still renders — the
 * viewport is released, but the room should still see who's presenting.
 */

export interface PresentingBannerProps {
  /** The presenter's display name, or null when nobody is presenting. */
  presenterName: string | null;
  /** True while the presenter has paused (viewport released, banner stays). */
  paused: boolean;
}

export default function PresentingBanner({ presenterName, paused }: PresentingBannerProps) {
  if (!presenterName) return null;
  return (
    <View style={[styles.banner, paused && styles.paused]}>
      <Ionicons
        name={paused ? "pause-circle-outline" : "easel-outline"}
        size={15}
        color="#fff"
      />
      <Text style={styles.text} numberOfLines={1}>
        {paused ? `${presenterName} paused presenting` : `${presenterName} is presenting`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    top: 12,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 260,
    backgroundColor: "#2563eb",
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 20,
    zIndex: 120,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  paused: {
    backgroundColor: "#6b7280",
  },
  text: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
  },
});
