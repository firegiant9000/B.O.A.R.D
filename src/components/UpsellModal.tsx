import React, { useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Linking,
  ActivityIndicator,
} from "react-native";
import { startCheckout, openBillingPortal, BillingCallableError } from "../services/billingService";
import { limitFor } from "../lib/planLimits";
import { RESOURCE_TO_LIMIT, type QuotaResource } from "../services/quotaService";

// Month 5/6 — the plan-limit upsell. Shown when a create/AI call site catches
// the server's `resource-exhausted` rejection (src/services/quotaService.ts
// #isResourceExhausted) instead of a generic error.
//
// TWO SEPARATE RENDERS, chosen by `Platform.OS` at render time, not one tree
// with a conditional price/link: Apple and Google both prohibit steering a
// native-app user to external payment. `WebUpsell` (web only) shows a price
// and a Stripe Checkout affordance; `NativeLimitNotice` (iOS/Android) states
// the limit and offers only Dismiss, and does not import billingService.
//
// This repo does have a platform-EXTENSION-FILE convention (`x.native.ts`
// beside a bare `x.ts`, e.g. src/lib/hardwareKeys.native.ts) — that mechanism
// is strictly stronger (the bundler excludes the other file outright, so the
// web strings couldn't exist in the native binary even as dead data) and was
// evaluated for this component first. It was not used here because file-
// extension resolution is static per test run (Jest's `react-native` preset
// pins `haste.defaultPlatform: 'ios'` with no `web` platform registered for
// this project's default config) — it cannot be toggled per test the way the
// store-compliance test in the sibling test file requires (asserting the web
// render in one `it`, the native render in the next, via `Platform.OS =`
// reassignment within one imported module). One module with two render
// components, switched at render time, is what makes both renders provably
// testable in this repo's existing Jest setup; see the Task 11 report for the
// full reasoning. The tradeoff (per the brief): `WebUpsell`'s strings remain
// present, unreachable, in the native bundle.
//
// G3 (no live Stripe account) and G4 (no decided price) are both unmet.
// Nothing here ever completes a real checkout, and PENDING_PRO_PRICE_LABEL
// below is a placeholder, not an approved price — see the module constant.

export interface UpsellModalProps {
  visible: boolean;
  resource: QuotaResource;
  onDismiss: () => void;
  /** Needed only by the web render, to actually call billingService when the
   *  user acts; the native render never reads it. Optional so callers that
   *  only need the display (and this component's own tests) don't have to
   *  supply one. */
  workspaceId?: string;
}

// PLACEHOLDER — Gate G4 (pricing) is unmet; no price has been approved. "$5/
// month" is the value Task 11's own brief specified for its web-variant test;
// it is not a business decision made here. A later, pricing-owning task must
// replace this single constant once a real price is approved — do not read
// its presence as that decision having been made.
const PENDING_PRO_PRICE_LABEL = "$5/month";

const RESOURCE_LABEL: Record<QuotaResource, string> = {
  board: "boards",
  session: "sessions",
  aiSummary: "AI calls",
  aiCall: "AI calls",
};

/** Shared between both renders: names the free-plan limit that was hit. Reads
 *  `limitFor` (Task 2) rather than hardcoding a number, so this tracks
 *  src/lib/planLimits.ts if it ever changes. */
function limitMessage(resource: QuotaResource): string {
  const limit = limitFor("free", RESOURCE_TO_LIMIT[resource]);
  return `You've reached the free plan's limit of ${limit} ${RESOURCE_LABEL[resource]}.`;
}

interface VariantProps {
  visible: boolean;
  resource: QuotaResource;
  onDismiss: () => void;
  workspaceId?: string;
}

/** The web render: names the limit, shows the (placeholder) price, and offers
 *  a real Stripe Checkout action plus, when the server says the remedy is the
 *  Customer Portal rather than a new checkout, a Manage Billing action. */
function WebUpsell({ visible, resource, onDismiss, workspaceId }: VariantProps) {
  const [busy, setBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<
    { message: string; canOpenPortal: boolean } | null
  >(null);

  const handleUpgrade = async () => {
    if (!workspaceId || busy) return;
    setBusy(true);
    setCheckoutError(null);
    try {
      const url = await startCheckout(workspaceId);
      await Linking.openURL(url);
    } catch (e) {
      // Route on the error's `details`, never on its `.message` text (Task 11
      // requirement): `canOpenPortal` says whether the Customer Portal is the
      // right remedy (e.g. a lapsed card on an existing subscription) or not
      // (e.g. an operator-paused subscription, where the remedy is operator-
      // side and offering the portal would be a dead end).
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
          <Text style={styles.title}>You've reached your plan's limit</Text>
          <Text style={styles.body}>{limitMessage(resource)}</Text>
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

/** The native render: states the limit reached and offers only Dismiss. No
 *  price, no checkout link, no billingService import — App Store / Play
 *  policy prohibits steering a native-app user to external payment, and
 *  there is no in-app purchase path in this app to offer as an alternative,
 *  so this states the fact and nothing more. */
function NativeLimitNotice({ visible, resource, onDismiss }: VariantProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Plan limit reached</Text>
          <Text style={styles.body}>{limitMessage(resource)}</Text>
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

export default function UpsellModal({ visible, resource, onDismiss, workspaceId }: UpsellModalProps) {
  // Two separate renders. Do NOT collapse these into one tree with conditional
  // children: a price or checkout link inside the mobile binary violates App
  // Store / Play policy on external payment.
  return Platform.OS === "web" ? (
    <WebUpsell resource={resource} visible={visible} onDismiss={onDismiss} workspaceId={workspaceId} />
  ) : (
    <NativeLimitNotice resource={resource} visible={visible} onDismiss={onDismiss} />
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
