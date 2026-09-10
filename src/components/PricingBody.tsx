import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useWorkspace } from "../hooks/useWorkspace";
import { startCheckout } from "../services/billingService";
import {
  PLAN_CARDS,
  BILLING_LIVE,
  canCheckoutNow,
  checkoutCtaLabel,
  type PlanCardCopy,
} from "../lib/pricingCopy";

// Web body of the pricing page — the platform-extension DEFAULT (bare
// filename). Metro's real module resolution (not expo-router's route
// discovery — see app/pricing.tsx's header for why that distinction
// matters) resolves THIS file for any non-native build; the sibling
// PricingBody.native.tsx overrides it for iOS/Android, the same convention
// src/components/UpsellModal.tsx / UpsellModal.native.tsx already uses. This
// is the ONLY file in this app permitted to show a price or a checkout
// affordance; it must never be imported by, or have its logic duplicated
// into, PricingBody.native.tsx or any file reachable from a native build.
//
// G3 (no live Stripe account) and G4 (no approved price) are both unmet —
// see src/services/billingService.ts's module header. `startCheckout` below
// is a real call into that service, exercised in tests only against a
// mocked callable; nothing on this page has ever completed a live redirect
// to Stripe's hosted Checkout. `BILLING_LIVE` (src/lib/pricingCopy.ts) gates
// the Pro card's action for exactly this reason — it must flip to `true`
// only once an account genuinely exists behind it, not before. Every limit
// figure below comes from src/lib/pricingCopy.ts's `planFeatures`, which
// reads src/lib/planLimits.ts's PLAN_LIMITS — never a retyped literal (see
// src/lib/__tests__/pricingCopy.test.ts).

function PlanCard({
  card,
  busy,
  error,
  canCheckout,
  ctaLabel,
  onUpgrade,
}: {
  card: PlanCardCopy;
  busy: boolean;
  error: string | null;
  canCheckout: boolean;
  ctaLabel: string;
  onUpgrade?: () => void;
}) {
  return (
    <View testID="plan-card" accessibilityLabel={card.label} style={styles.card}>
      <Text style={styles.planLabel}>{card.label}</Text>
      <Text style={styles.price}>{card.priceLabel}</Text>
      {/* Gate G4 (pricing) is unmet — this figure is not final. A pricing
          page is exactly the surface where an unqualified number reads as a
          done deal, so this note is user-visible, not just a code comment. */}
      {card.priceNote && <Text style={styles.priceNote}>{card.priceNote}</Text>}
      <Text style={styles.tagline}>{card.tagline}</Text>

      {card.features.map((feature) => (
        <Text key={feature} style={styles.feature}>
          • {feature}
        </Text>
      ))}

      {card.ctaLabel && onUpgrade && (
        <>
          {error && <Text style={styles.errorText}>{error}</Text>}
          <TouchableOpacity
            testID={`plan-card-cta-${card.id}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || !canCheckout }}
            style={[styles.ctaButton, !canCheckout && styles.ctaButtonDisabled]}
            onPress={onUpgrade}
            disabled={busy || !canCheckout}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.ctaText}>{ctaLabel}</Text>
            )}
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

export default function PricingBody() {
  const router = useRouter();
  // Optional: this route is also the resolved destination of Stripe's
  // CHECKOUT_SUCCESS_URL / CHECKOUT_CANCEL_URL (functions/src/billing/
  // stripe.ts) — see that file's header for why those pointed nowhere
  // before this task and why they now point here.
  const params = useLocalSearchParams<{ checkout?: string }>();
  const { activeWorkspaceId } = useWorkspace();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deny-unless-provably-permitted, mirroring the Global Constraints'
  // enforcement discipline even though this is only a UI affordance (the
  // real gate is `handleCreateCheckoutSession` server-side either way):
  // the button must never present as clickable when it can't do anything —
  // either because there's no Stripe account behind it yet (`BILLING_LIVE`)
  // or because there's no workspace to charge (`activeWorkspaceId`). Both
  // pure functions from src/lib/pricingCopy.ts, unit-tested directly there.
  const canCheckout = canCheckoutNow(BILLING_LIVE, !!activeWorkspaceId);
  const ctaLabel = checkoutCtaLabel(BILLING_LIVE, !!activeWorkspaceId);

  const handleUpgrade = async () => {
    if (!canCheckout || busy || !activeWorkspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const url = await startCheckout(activeWorkspaceId);
      await Linking.openURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start checkout.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Same in-screen back affordance as app/ai-usage.tsx: the root
          navigator hides the default header (headerShown: false), so a
          user who lands here (including via a cold-start deep link) needs
          an explicit way back rather than a dead end. */}
      <View style={styles.header}>
        <TouchableOpacity
          testID="pricing-back-button"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Plans</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Stripe's redirect back to this page after a real checkout has
            never been exercised (no live Stripe account — G3 unmet), so this
            banner deliberately does not claim the plan already changed;
            `plan` is written asynchronously by the webhook, not by this
            redirect. */}
        {params.checkout === "success" && (
          <Text style={styles.banner} testID="checkout-success-banner">
            Checkout complete. It can take a moment for your plan to update.
          </Text>
        )}
        {params.checkout === "cancel" && (
          <Text style={styles.banner} testID="checkout-cancel-banner">
            Checkout canceled — nothing was charged.
          </Text>
        )}

        {PLAN_CARDS.map((card) => (
          <PlanCard
            key={card.id}
            card={card}
            busy={busy}
            error={card.id === "pro" ? error : null}
            canCheckout={canCheckout}
            ctaLabel={ctaLabel}
            onUpgrade={card.id === "pro" ? handleUpgrade : undefined}
          />
        ))}
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
  content: { padding: 20, paddingBottom: 40, gap: 16 },
  banner: {
    backgroundColor: "#eff6ff",
    color: "#1d4ed8",
    fontSize: 13,
    borderRadius: 10,
    padding: 12,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e7eb",
    borderRadius: 16,
    padding: 20,
    gap: 6,
  },
  planLabel: { fontSize: 18, fontWeight: "700", color: "#111827" },
  price: { fontSize: 15, fontWeight: "600", color: "#2563eb" },
  priceNote: { fontSize: 11, color: "#9ca3af", fontStyle: "italic" },
  tagline: { fontSize: 13, color: "#6b7280", marginBottom: 8 },
  feature: { fontSize: 14, color: "#374151" },
  errorText: { fontSize: 13, color: "#b91c1c", marginTop: 8 },
  ctaButton: {
    marginTop: 14,
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  ctaButtonDisabled: { backgroundColor: "#93c5fd" },
  ctaText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
