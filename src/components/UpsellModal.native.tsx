import React from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { limitMessage, isPlanCapped, THROTTLE_MESSAGE } from "./upsellCopy";
import type { QuotaResource } from "../services/quotaService";
import type { Plan } from "../types";

// Native (iOS/Android) body of the plan-limit upsell — the platform-extension
// OVERRIDE Metro/RN resolve for a native build, ahead of the bare
// UpsellModal.tsx (see that file's header for the convention, matching
// src/lib/hardwareKeys.ts / hardwareKeys.native.ts).
//
// COMPLIANCE INVARIANT, guarded by this component's test file: this source
// file may never name a cost figure, a currency amount, an off-app link, or
// any affordance that could lead one off-app to complete a purchase — that
// is App Store / Play policy on external payment for a native app. It states
// the limit (or, when the denial can't be a plan cap, a transient note) and
// offers only a dismiss action. It imports nothing capable of constructing
// such a link — no billing seam of any kind, only the shared, figure-free
// copy in ./upsellCopy.

export interface UpsellModalProps {
  visible: boolean;
  resource: QuotaResource;
  onDismiss: () => void;
  /** The workspace's actual plan; falls back to "free" when omitted. */
  plan?: Plan;
  /** Unused on this variant — kept so every call site can pass the same
   *  props to either platform's file without branching. */
  workspaceId?: string;
}

export default function UpsellModal({ visible, resource, onDismiss, plan }: UpsellModalProps) {
  const effectivePlan: Plan = plan ?? "free";
  const capped = isPlanCapped(effectivePlan, resource);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{capped ? "Plan limit reached" : "One moment"}</Text>
          <Text style={styles.body}>
            {capped ? limitMessage(resource, effectivePlan) : THROTTLE_MESSAGE}
          </Text>
          <TouchableOpacity
            testID="upsell-native-dismiss-button"
            accessibilityRole="button"
            style={styles.primaryButton}
            onPress={onDismiss}
          >
            <Text style={styles.primaryButtonText}>OK</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(17, 24, 39, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 24,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 8,
  },
  body: {
    fontSize: 15,
    color: "#374151",
    lineHeight: 21,
    marginBottom: 20,
  },
  primaryButton: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
});
