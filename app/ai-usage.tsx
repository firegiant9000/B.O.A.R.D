import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  Platform,
  Linking,
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
import {
  getWorkspaceUsage,
  type WorkspaceUsage,
  type Headroom,
} from "../src/services/usageService";
import {
  getSubscription,
  openBillingPortal,
  hasKnownRenewalDate,
} from "../src/services/billingService";
import { limitFor, UNLIMITED } from "../src/lib/planLimits";
import type { Subscription } from "../src/types";

// Read-only usage dashboard (Month 4 Phase 2 AI meter, extended Month 5/6
// with boards, sessions and overall plan headroom). Surfaces this
// period's AI calls / tokens / $ estimate + a per-feature breakdown + recent
// calls, plus used/limit for every metered plan resource. Owner/admin only —
// mirrors the aiUsage/aiLog/usage/billing read rules in firestore.rules.
//
// Every number on this screen is DISPLAY, not enforcement — the real gates
// are the Cloud Functions and firestore.rules (see usageService.ts). Nothing
// here denies a create; a plan can still be exceeded between page loads.

const FEATURE_LABELS: Record<string, string> = {
  summary: "Session summaries",
  ocr: "Handwriting OCR",
  explain: "Explain selection",
  diagram: "Text → diagram",
  unknown: "Other",
};

/** "3 of 5" for a capped resource, "3 · Unlimited" for an unlimited one — never
 *  a raw `Infinity` on screen. */
function headroomValueText(h: Headroom): string {
  return h.unlimited ? `${h.used} · Unlimited` : `${h.used} of ${h.limit}`;
}

/** Plain-language text for the (unenforced) `workspaces` plan limit — never
 *  a raw `Infinity`. `limitFor` is a pure function, safe to call directly
 *  from the UI; it isn't a Firestore/network call. */
function workspacesLimitText(plan: Parameters<typeof limitFor>[0]): string {
  const n = limitFor(plan, "workspaces");
  return n === UNLIMITED ? "unlimited workspaces" : `${n} workspace${n === 1 ? "" : "s"}`;
}

function HeadroomRow({ label, headroom, note }: { label: string; headroom: Headroom; note?: string }) {
  return (
    <View style={styles.usageRow}>
      <View style={styles.usageRowHeader}>
        <Text style={styles.usageLabel}>{label}</Text>
        <Text style={styles.usageValue}>{headroomValueText(headroom)}</Text>
      </View>
      {!headroom.unlimited && (
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${Math.round(headroom.fraction * 100)}%` }]} />
        </View>
      )}
      {note && <Text style={styles.usageNote}>{note}</Text>}
    </View>
  );
}

export default function AiUsageScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { activeWorkspace, activeWorkspaceId, loading: wsLoading } = useWorkspace();

  const [usage, setUsage] = useState<AiUsagePeriod | null>(null);
  const [log, setLog] = useState<AiLogEntry[]>([]);
  const [workspaceUsage, setWorkspaceUsage] = useState<WorkspaceUsage | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);

  const role =
    activeWorkspace && user
      ? getWorkspaceRole(activeWorkspace, user.uid)
      : undefined;
  const allowed = canViewUsage(role);
  const plan = activeWorkspace?.plan ?? "free";

  const fetchUsage = useCallback(async () => {
    if (!activeWorkspaceId || !allowed) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const [u, l, wsUsage, sub] = await Promise.all([
        getAiUsage(activeWorkspaceId),
        getRecentAiLog(activeWorkspaceId),
        getWorkspaceUsage(activeWorkspaceId, plan),
        getSubscription(activeWorkspaceId),
      ]);
      setUsage(u);
      setLog(l);
      setWorkspaceUsage(wsUsage);
      setSubscription(sub);
      setError(null);
    } catch {
      setError("Failed to load usage. Pull down to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeWorkspaceId, allowed, plan]);

  useFocusEffect(
    useCallback(() => {
      if (!wsLoading) fetchUsage();
    }, [wsLoading, fetchUsage])
  );

  const onRefresh = () => {
    setRefreshing(true);
    fetchUsage();
  };

  // Web only (brief): the native Stripe Customer Portal redirect has never
  // been exercised (no live Stripe account — see billingService.ts's module
  // header) and this app builds no cancellation UI of its own, so the portal
  // link is offered only where a redirect is unremarkable.
  const handleManageBilling = async () => {
    if (!activeWorkspaceId || billingBusy) return;
    setBillingBusy(true);
    setBillingError(null);
    try {
      const url = await openBillingPortal(activeWorkspaceId);
      await Linking.openURL(url);
    } catch (e) {
      // BillingCallableError extends Error, so this also catches it.
      setBillingError(e instanceof Error ? e.message : "Couldn't open the billing portal.");
    } finally {
      setBillingBusy(false);
    }
  };

  const header = (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
        <Ionicons name="chevron-back" size={24} color="#111827" />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Usage</Text>
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
            Usage for a workspace is visible to its owner and admins.
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

        <Text style={styles.note}>Estimates only.</Text>

        {/* Plan usage (Month 5/6). "boards" mirrors the server's enforcement
            query as closely as firestore.rules allows a client to get (see
            usageService.ts) — everything else here is a straight read of the
            same counter the relevant Cloud Function gates on. Nothing on
            this screen enforces anything; a create can still be denied
            between page loads. */}
        {workspaceUsage && (
          <>
            <Text style={styles.sectionTitle}>Plan usage</Text>
            <HeadroomRow
              label="Boards"
              headroom={workspaceUsage.boards}
              note="Counts boards in this workspace that also have a join code — the same number a new board is checked against. A legacy board moved into this workspace without ever getting a join code still counts toward your limit but won't show up in this number, even though it's still in your board list."
            />
            <HeadroomRow label="Sessions this period" headroom={workspaceUsage.sessions} />
            <HeadroomRow label="AI calls this period" headroom={workspaceUsage.aiCalls} />

            {/* Collaborators is a PER-BOARD cap (collaboratorsPerBoard), but
                this page has no active board to measure it against — it's a
                workspace-wide dashboard reached with no boardId. Rendering
                the workspace's total member count as a HeadroomRow's "X of
                Y" + filled bar would look exactly like a real breach (e.g.
                10 workspace members against a free plan's 4-per-board cap
                shows "10 of 4" at a 100% bar) even when no single board is
                actually over — nothing is enforced against that number.
                Plain text instead, same choice already made for the
                `workspaces` row below: real information, no false breach
                signal. */}
            <View style={styles.usageRow}>
              <Text style={styles.usageLabel}>Collaborators</Text>
              <Text style={styles.usageNote}>
                Each board allows up to{" "}
                {workspaceUsage.collaborators.unlimited ? "unlimited" : workspaceUsage.collaborators.limit}{" "}
                collaborators. This workspace has {workspaceUsage.collaborators.used}{" "}
                {workspaceUsage.collaborators.used === 1 ? "person" : "people"} total across all boards.
              </Text>
            </View>

            {/* Workspaces (brief requirement): PLAN_LIMITS lists a number for
                this, but nothing enforces it — firestore.rules lets a client
                create workspaces with no count check, and rules have no way
                to add one. This is deliberately NOT a HeadroomRow: a bar
                would visually claim a cap that does not exist. */}
            <Text style={styles.workspacesNote}>
              Workspaces: the {plan} plan lists{" "}
              {workspacesLimitText(plan)}. Not enforced — creating another workspace isn't
              currently blocked.
            </Text>
          </>
        )}

        {subscription && (
          <Text style={styles.note}>
            {hasKnownRenewalDate(subscription)
              ? `Renews ${new Date(subscription.currentPeriodEndMs).toLocaleDateString()}.`
              : "Renewal date unknown."}
          </Text>
        )}

        {Platform.OS === "web" && (
          <>
            {billingError && <Text style={styles.errorText}>{billingError}</Text>}
            <TouchableOpacity
              testID="manage-billing-button"
              accessibilityRole="button"
              style={styles.manageBillingButton}
              onPress={handleManageBilling}
              disabled={billingBusy}
            >
              {billingBusy ? (
                <ActivityIndicator color="#2563eb" />
              ) : (
                <Text style={styles.manageBillingText}>Manage billing</Text>
              )}
            </TouchableOpacity>
          </>
        )}

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
  usageRow: { marginTop: 14 },
  usageRowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 6,
  },
  usageLabel: { fontSize: 14, fontWeight: "600", color: "#111827" },
  usageValue: { fontSize: 13, color: "#6b7280" },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "#e5e7eb",
    overflow: "hidden",
  },
  barFill: { height: 6, borderRadius: 3, backgroundColor: "#2563eb" },
  usageNote: { fontSize: 11, color: "#9ca3af", marginTop: 4, lineHeight: 15 },
  workspacesNote: { fontSize: 11, color: "#9ca3af", marginTop: 16, lineHeight: 15 },
  manageBillingButton: {
    marginTop: 16,
    alignSelf: "flex-start",
    backgroundColor: "#eff6ff",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  manageBillingText: { color: "#2563eb", fontSize: 14, fontWeight: "700" },
});
