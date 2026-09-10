import React, { useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
  ActivityIndicator,
} from "react-native";
import { startCheckout, openBillingPortal, BillingCallableError } from "../services/billingService";
import {
  limitMessage,
  isPlanCapped,
  THROTTLE_MESSAGE,
  RESOURCE_LABEL,
  type UpsellModalProps,
} from "./upsellCopy";
import type { Plan } from "../types";

// Web body of the plan-limit upsell — the platform-extension DEFAULT (bare
// filename). Metro/RN resolve this file for every non-native build; the
// sibling UpsellModal.native.tsx overrides it for iOS/Android — same
// convention as src/lib/hardwareKeys.ts / hardwareKeys.native.ts. The native
// variant must contain no price or checkout affordance, guarded by this
// component's test file (which scans that file's own source, not only its
// rendered output — a price or link the native handler never renders would
// otherwise be invisible to a render-only check).
//
// G3 (no live Stripe account) and G4 (no decided price) are both unmet as of
// this writing. `startCheckout`/`openBillingPortal` are real calls into
// billingService, but nothing in this app has ever exercised a live Stripe
// redirect. PENDING_PRO_PRICE_LABEL below is a placeholder, not an approved
// price — see its own comment.

export type { UpsellModalProps };

// PLACEHOLDER — Gate G4 (pricing) is unmet; no price has been approved. This
// value is not a business decision made here; a later, pricing-owning task
// must replace this single constant once a real price is approved.
const PENDING_PRO_PRICE_LABEL = "$5/month";

interface CheckoutError {
  message: string;
  canOpenPortal: boolean;
}

export default function UpsellModal({ visible, resource, onDismiss, plan, workspaceId }: UpsellModalProps) {
  const effectivePlan: Plan = plan ?? "free";
  const capped = isPlanCapped(effectivePlan, resource);

  const [busy, setBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<CheckoutError | null>(null);

  const handleUpgrade = async () => {
    if (!workspaceId || busy) return;
    setBusy(true);
    setCheckoutError(null);
    try {
      const url = await startCheckout(workspaceId);
      await Linking.openURL(url);
    } catch (e) {
      // Route on the error's `details`, never on its `.message` text:
      // `canOpenPortal` says whether the Customer Portal is the right remedy
      // (e.g. a lapsed card on an existing subscription) or not (e.g. an
      // operator-paused subscription, where the remedy is operator-side and
      // offering the portal would be a dead end).
      const details =
        e instanceof BillingCallableError
          ? (e.details as { canOpenPortal?: boolean } | undefined)
          : undefined;
      setCheckoutError({
        message: e instanceof Error ? e.message : "Couldn't start checkout.",
        canOpenPortal: !!details?.canOpenPortal,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleManageBilling = async () => {
    if (!workspaceId || busy) return;
    setBusy(true);
    try {
      const url = await openBillingPortal(workspaceId);
      await Linking.openURL(url);
    } catch (e) {
      setCheckoutError({
        message: e instanceof Error ? e.message : "Couldn't open the billing portal.",
        canOpenPortal: false,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {capped ? (
            <>
              <Text style={styles.title}>You've reached your plan's limit</Text>
              <Text style={styles.body}>{limitMessage(resource, effectivePlan)}</Text>
              <Text style={styles.price}>
                {PENDING_PRO_PRICE_LABEL} unlocks unlimited {RESOURCE_LABEL[resource]}
              </Text>

              {checkoutError && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{checkoutError.message}</Text>
                  {checkoutError.canOpenPortal && (
                    <TouchableOpacity
                      testID="upsell-web-portal-button"
                      accessibilityRole="button"
                      style={styles.secondaryButton}
                      onPress={handleManageBilling}
                      disabled={busy}
                    >
                      <Text style={styles.secondaryButtonText}>Manage billing</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}

              <TouchableOpacity
                testID="upsell-web-upgrade-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={handleUpgrade}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>Upgrade to Pro</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.title}>One moment</Text>
              <Text style={styles.body}>{THROTTLE_MESSAGE}</Text>
            </>
          )}

          <TouchableOpacity
            testID="upsell-web-dismiss-button"
            accessibilityRole="button"
            onPress={onDismiss}
            disabled={busy}
          >
            <Text style={styles.dismissText}>Not now</Text>
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
    marginBottom: 16,
  },
  price: {
    fontSize: 14,
    fontWeight: "600",
    color: "#2563eb",
    marginBottom: 20,
  },
  errorBox: {
    backgroundColor: "#fef2f2",
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    fontSize: 13,
    color: "#991b1b",
    marginBottom: 8,
  },
  primaryButton: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 12,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  secondaryButton: {
    alignSelf: "flex-start",
  },
  secondaryButtonText: {
    color: "#2563eb",
    fontSize: 13,
    fontWeight: "700",
  },
  dismissText: {
    textAlign: "center",
    color: "#6b7280",
    fontSize: 14,
  },
});
