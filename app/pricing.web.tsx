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
import { useLocalSearchParams } from "expo-router";
import { useWorkspace } from "../src/hooks/useWorkspace";
import { startCheckout } from "../src/services/billingService";
import { PLAN_CARDS, type PlanCardCopy } from "../src/lib/pricingCopy";

// Web body of the pricing page — the platform-extension OVERRIDE Metro/
// expo-router resolve for a web build, ahead of the bare app/pricing.tsx
// fallback (see that file's header for why the fallback exists and why it
// is mandatory, not optional — verified against this project's installed
// expo-router version, not assumed). This is the ONLY file in this app
// permitted to show a price or a checkout affordance; it must never be
// imported by, or have its logic duplicated into, app/pricing.tsx or any
// file reachable from a native build.
//
// G3 (no live Stripe account) and G4 (no approved price) are both unmet —
// see src/services/billingService.ts's module header. `startCheckout` below
// is a real call into that service, exercised in tests only against a
// mocked callable; nothing on this page has ever completed a live redirect
// to Stripe's hosted Checkout. Every limit figure below comes from
// src/lib/pricingCopy.ts's `planFeatures`, which reads src/lib/
// planLimits.ts's PLAN_LIMITS — never a retyped literal (see
// src/lib/__tests__/pricingCopy.test.ts).

function PlanCard({
  card,
  busy,
  error,
  onUpgrade,
}: {
  card: PlanCardCopy;
  busy: boolean;
  error: string | null;
  onUpgrade?: () => void;
}) {
  return (
    <View testID="plan-card" accessibilityLabel={card.label} style={styles.card}>
      <Text style={styles.planLabel}>{card.label}</Text>
      <Text style={styles.price}>{card.priceLabel}</Text>
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
            style={styles.ctaButton}
            onPress={onUpgrade}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.ctaText}>{card.ctaLabel}</Text>
            )}
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

export default function Pricing() {
  // Optional: this route is also the resolved destination of Stripe's
  // CHECKOUT_SUCCESS_URL / CHECKOUT_CANCEL_URL (functions/src/billing/
  // stripe.ts) — see that file's header for why those pointed nowhere
  // before this task and why they now point here.
  const params = useLocalSearchParams<{ checkout?: string }>();
  const { activeWorkspaceId } = useWorkspace();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpgrade = async () => {
    if (!activeWorkspaceId || busy) return;
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Plans</Text>

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
          onUpgrade={card.id === "pro" ? handleUpgrade : undefined}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 40, gap: 16 },
  heading: { fontSize: 22, fontWeight: "700", color: "#111827" },
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
  ctaText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
