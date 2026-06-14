import React from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ActivityEvent, ActivityVerb } from "../types";

/**
 * Phase 8. Reusable, presentational activity-feed list. Renders a list of
 * `ActivityEvent`s newest-first (the caller passes them already ordered — every
 * activityService read is `orderBy('createdAt','desc')`). Stateless and source-
 * agnostic so it backs both the per-board history sidebar (Phase 8) and the
 * workspace-home recent-activity panel (Phase 10) without change.
 */

interface ActivityFeedProps {
  events: ActivityEvent[];
  loading?: boolean;
  emptyText?: string;
}

const VERB_ICON: Record<ActivityVerb, keyof typeof Ionicons.glyphMap> = {
  "board.created": "duplicate-outline",
  "comment.created": "chatbubble-ellipses-outline",
  "session.ended": "stop-circle-outline",
};

function relativeTime(date: Date): string {
  const ms = date.getTime();
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return date.toLocaleDateString();
}

/** Human-readable sentence for an event. Kept here so every feed phrases verbs alike. */
export function describeActivity(e: ActivityEvent): string {
  switch (e.verb) {
    case "board.created":
      return `created board "${e.meta?.title ?? "Untitled"}"`;
    case "comment.created":
      return "added a comment";
    case "session.ended": {
      const n = e.meta?.participantCount ?? 0;
      const who = n === 1 ? "1 participant" : `${n} participants`;
      return `ended a session with ${who}`;
    }
    default:
      return "did something";
  }
}

function initial(name: string): string {
  return (name || "U").charAt(0).toUpperCase();
}

export default function ActivityFeed({ events, loading = false, emptyText }: ActivityFeedProps) {
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color="#2563eb" />
      </View>
    );
  }

  if (events.length === 0) {
    return (
      <View style={styles.centered}>
        <Ionicons name="time-outline" size={24} color="#cbd5e1" />
        <Text style={styles.emptyText}>{emptyText ?? "No activity yet."}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
      {events.map((e) => (
        <View key={e.id} style={styles.row}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initial(e.actorName)}</Text>
          </View>
          <View style={styles.body}>
            <Text style={styles.line}>
              <Text style={styles.actor}>{e.actorName}</Text>
              <Text style={styles.verb}> {describeActivity(e)}</Text>
            </Text>
            <Text style={styles.time}>{relativeTime(e.createdAt)}</Text>
          </View>
          <Ionicons
            name={VERB_ICON[e.verb] ?? "ellipse-outline"}
            size={16}
            color="#94a3b8"
            style={styles.verbIcon}
          />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  centered: { alignItems: "center", justifyContent: "center", paddingVertical: 28, gap: 8 },
  emptyText: { fontSize: 13, color: "#9ca3af" },
  row: { flexDirection: "row", alignItems: "flex-start", marginBottom: 14 },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#6b7280",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  avatarText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  body: { flex: 1 },
  line: { fontSize: 14, color: "#374151", lineHeight: 19 },
  actor: { fontWeight: "700", color: "#111827" },
  verb: { color: "#374151" },
  time: { fontSize: 11, color: "#9ca3af", marginTop: 2 },
  verbIcon: { marginLeft: 8, marginTop: 2 },
});
