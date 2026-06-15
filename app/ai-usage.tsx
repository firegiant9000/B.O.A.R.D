import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { useFocusEffect, useRouter, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../src/hooks/useAuth";
import { useWorkspace } from "../src/hooks/useWorkspace";
import { getWorkspaceRole } from "../src/services/workspaceService";
import {
  getAiUsage,
  getRecentAiLog,
  canViewUsage,
  formatUsd,
  periodFor,
  type AiUsagePeriod,
  type AiLogEntry,
} from "../src/services/aiUsageService";

// Read-only AI usage settings page (Month 4, Phase 2). Surfaces this period's
// calls / tokens / $ estimate + a per-feature breakdown + recent calls. Owner/admin
// only — mirrors the aiUsage/aiLog read rule in firestore.rules. No enforcement
// this month (the gate stays soft); this is the meter, not the cap.

const FEATURE_LABELS: Record<string, string> = {
  summary: "Session summaries",
  ocr: "Handwriting OCR",
  explain: "Explain selection",
  diagram: "Text → diagram",
  unknown: "Other",
};

export default function AiUsageScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { activeWorkspace, activeWorkspaceId, loading: wsLoading } = useWorkspace();

  const [usage, setUsage] = useState<AiUsagePeriod | null>(null);
  const [log, setLog] = useState<AiLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const role =
    activeWorkspace && user
      ? getWorkspaceRole(activeWorkspace, user.uid)
      : undefined;
  const allowed = canViewUsage(role);

  const fetchUsage = useCallback(async () => {
    if (!activeWorkspaceId || !allowed) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const [u, l] = await Promise.all([
        getAiUsage(activeWorkspaceId),
        getRecentAiLog(activeWorkspaceId),
      ]);
      setUsage(u);
      setLog(l);
      setError(null);
    } catch {
      setError("Failed to load AI usage. Pull down to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeWorkspaceId, allowed]);

  useFocusEffect(
    useCallback(() => {
      if (!wsLoading) fetchUsage();
    }, [wsLoading, fetchUsage])
  );

  const onRefresh = () => {
    setRefreshing(true);
    fetchUsage();
  };

  const header = (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
        <Ionicons name="chevron-back" size={24} color="#111827" />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>AI Usage</Text>
      <View style={styles.backBtn} />
    </View>
  );

  if (wsLoading || loading) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        {header}
        <ActivityIndicator color="#2563eb" style={{ marginTop: 40 }} />
      </View>
    );
  }

  // Members/viewers can't read the telemetry docs (rules deny it) — show a clear
  // gate rather than letting the read fail with a permission error.
  if (!allowed) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        {header}
        <View style={styles.empty}>
          <Ionicons name="lock-closed-outline" size={40} color="#d1d5db" />
          <Text style={styles.emptyTitle}>Owner/admin only</Text>
          <Text style={styles.emptyText}>
            AI usage for a workspace is visible to its owner and admins.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      {header}
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Text style={styles.period}>
          {activeWorkspace?.name ?? "Workspace"} · {periodFor()}
        </Text>

        {error && <Text style={styles.errorText}>{error}</Text>}

        {/* Top-line meters */}
        <View style={styles.metricRow}>
          <View style={styles.metricCard}>
            <Text style={styles.metricValue}>{formatUsd(usage?.costUsd ?? 0)}</Text>
            <Text style={styles.metricLabel}>Est. cost</Text>
          </View>
          <View style={styles.metricCard}>
            <Text style={styles.metricValue}>{usage?.calls ?? 0}</Text>
            <Text style={styles.metricLabel}>AI calls</Text>
          </View>
          <View style={styles.metricCard}>
            <Text style={styles.metricValue}>
              {(usage?.tokens ?? 0).toLocaleString()}
            </Text>
            <Text style={styles.metricLabel}>Tokens</Text>
          </View>
        </View>

        <Text style={styles.note}>
          Estimates only — usage is metered but not yet capped on the free plan.
        </Text>

        {/* Per-feature breakdown */}
        <Text style={styles.sectionTitle}>By feature</Text>
        {usage && Object.keys(usage.byFeature).length > 0 ? (
          Object.entries(usage.byFeature).map(([feature, f]) => (
            <View key={feature} style={styles.row}>
              <Text style={styles.rowLabel}>
                {FEATURE_LABELS[feature] ?? feature}
              </Text>
              <Text style={styles.rowMeta}>
                {f.calls} · {formatUsd(f.costUsd)}
              </Text>
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>No AI calls this period.</Text>
        )}

        {/* Recent calls */}
        {log.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Recent calls</Text>
            {log.map((entry) => (
              <View key={entry.id} style={styles.row}>
                <Text style={styles.rowLabel}>
                  {FEATURE_LABELS[entry.feature] ?? entry.feature}
                </Text>
                <Text style={styles.rowMeta}>
                  {entry.totalTokens.toLocaleString()} tok · {formatUsd(entry.costUsd)}
                </Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 52,
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e7eb",
  },
  backBtn: { width: 40, alignItems: "center" },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#111827" },
  scroll: { padding: 20, paddingBottom: 40 },
  period: { fontSize: 14, color: "#6b7280", marginBottom: 16 },
  errorText: { fontSize: 13, color: "#b91c1c", marginBottom: 12 },
  metricRow: { flexDirection: "row", gap: 10 },
  metricCard: {
    flex: 1,
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  metricValue: { fontSize: 20, fontWeight: "700", color: "#111827" },
  metricLabel: { fontSize: 12, color: "#6b7280", marginTop: 4 },
  note: { fontSize: 12, color: "#9ca3af", marginTop: 10, lineHeight: 16 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f1f5f9",
  },
  rowLabel: { fontSize: 14, color: "#111827" },
  rowMeta: { fontSize: 13, color: "#6b7280" },
  empty: { alignItems: "center", paddingTop: 60, paddingHorizontal: 32, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: "#374151" },
  emptyText: { fontSize: 13, color: "#9ca3af", textAlign: "center", lineHeight: 18 },
});
