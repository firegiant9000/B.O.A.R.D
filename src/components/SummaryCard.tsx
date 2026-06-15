import React, { useMemo, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { SessionSummary } from "../types";

// Phase 3: renders the structured AI summary as a card instead of a prose blob.
// Tolerates the legacy plain-string summary (schema-version tolerance) by
// treating it as a TL;DR-only summary. The two "modes" surface as a collapsed
// (short / TL;DR) vs expanded (detailed) view, so toggling costs no AI call.

/** Normalizes either summary form into the structured shape. */
function normalize(summary: string | SessionSummary): SessionSummary {
  if (typeof summary === "string") {
    return { tldr: summary, actionItems: [], decisions: [], openQuestions: [] };
  }
  return {
    tldr: summary.tldr ?? "",
    actionItems: summary.actionItems ?? [],
    decisions: summary.decisions ?? [],
    openQuestions: summary.openQuestions ?? [],
  };
}

function Section({
  icon,
  label,
  items,
  color,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  items: string[];
  color: string;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Ionicons name={icon} size={13} color={color} />
        <Text style={[styles.sectionLabel, { color }]}>{label}</Text>
      </View>
      {items.map((item, i) => (
        <View key={i} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

export default function SummaryCard({
  summary,
}: {
  summary: string | SessionSummary;
}) {
  const data = useMemo(() => normalize(summary), [summary]);
  const hasDetail =
    data.actionItems.length > 0 ||
    data.decisions.length > 0 ||
    data.openQuestions.length > 0;
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.box}>
      <View style={styles.header}>
        <Ionicons name="sparkles" size={14} color="#7c3aed" />
        <Text style={styles.label}>AI Summary</Text>
      </View>

      {data.tldr ? <Text style={styles.tldr}>{data.tldr}</Text> : null}

      {hasDetail && expanded && (
        <View style={styles.detail}>
          <Section
            icon="checkbox-outline"
            label="Action items"
            items={data.actionItems}
            color="#2563eb"
          />
          <Section
            icon="flag-outline"
            label="Decisions"
            items={data.decisions}
            color="#16a34a"
          />
          <Section
            icon="help-circle-outline"
            label="Open questions"
            items={data.openQuestions}
            color="#d97706"
          />
        </View>
      )}

      {hasDetail && (
        <TouchableOpacity
          style={styles.toggle}
          onPress={() => setExpanded((v) => !v)}
        >
          <Text style={styles.toggleText}>
            {expanded ? "Show less" : "Show details"}
          </Text>
          <Ionicons
            name={expanded ? "chevron-up" : "chevron-down"}
            size={14}
            color="#7c3aed"
          />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: "#f5f3ff",
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#ddd6fe",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: "700",
    color: "#7c3aed",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tldr: {
    fontSize: 14,
    color: "#374151",
    lineHeight: 20,
  },
  detail: {
    marginTop: 10,
    gap: 10,
  },
  section: {
    gap: 3,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 2,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  bulletRow: {
    flexDirection: "row",
    gap: 6,
    paddingLeft: 2,
  },
  bulletDot: {
    fontSize: 14,
    color: "#6b7280",
    lineHeight: 20,
  },
  bulletText: {
    flex: 1,
    fontSize: 13,
    color: "#374151",
    lineHeight: 19,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 8,
  },
  toggleText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#7c3aed",
  },
});
