import React, { useEffect, useRef, useState } from "react";
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
import { track } from "../services/analyticsService";
import {
  limitMessage,
  isPlanCapped,
  THROTTLE_MESSAGE,
  unlockPhrase,
  type UpsellModalProps,
} from "./upsellCopy";
import {
  PENDING_PRO_PRICE_LABEL,
  BILLING_LIVE,
  canCheckoutNow,
  checkoutCtaLabel,
} from "../lib/pricingCopy";
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
// redirect. PENDING_PRO_PRICE_LABEL is a placeholder, not an approved price —
// imported from src/lib/pricingCopy.ts (also read by app/pricing.web.tsx) so
// this modal and the pricing page can never quote two different figures; see
// that constant's own comment.

export type { UpsellModalProps };

interface CheckoutError {
  message: string;
  canOpenPortal: boolean;
}

export default function UpsellModal({
  visible,
  resource,
  onDismiss,
  plan,
  workspaceId,
  // ROADMAP.md:608 (item 14) — "Skip on first attempt; harder push on second".
  // Defaults to "hard", the body this modal has always rendered, so every
  // caller and test that predates the cadence keeps exactly its behaviour and
  // only a deliberate opt-in gets the restrained one. That default is the
  // opposite of fail-soft on purpose: the ONE production caller
  // (app/board/[id].tsx via useUpsellCadence) always supplies a variant that
  // was itself resolved fail-soft, so the only thing this default can reach is
  // a caller that never asked for cadence at all — and silently stripping the
  // sell from such a caller would be a behaviour change nobody requested.
  variant = "hard",
}: UpsellModalProps) {
  const effectivePlan: Plan = plan ?? "free";
  const capped = isPlanCapped(effectivePlan, resource);
  // Only a plan-cap denial can ever carry the sell. The transient-throttle
  // body below is unaffected by the variant by design: a Pro customer who sent
  // requests too fast needs the same honest "wait a moment" on their first hit
  // as on their fifth, and there is nothing to be restrained ABOUT there.
  const selling = capped && variant === "hard";

  const [busy, setBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<CheckoutError | null>(null);

  // Month 6 — ROADMAP.md:685's `upgrade_viewed`.
  //
  // WHAT COUNTS AS AN UPGRADE VIEW, decided rather than defaulted. `selling`
  // (above) is exactly "this render makes an offer": a plan-cap denial AND the
  // hard variant. The two cases it excludes are excluded on purpose:
  //
  //  - The SOFT variant deliberately renders no price and no checkout
  //    affordance at all (see the comment around the `selling &&` block
  //    below). Counting it would fill the top of this funnel with impressions
  //    that made no offer — and since the cadence shows soft on a user's FIRST
  //    hit of each gate, those impressions would be the majority, making the
  //    view-to-conversion rate read far worse than the offer actually
  //    performs.
  //  - The transient-throttle body is not a paywall at all; it is shown to
  //    people whose plan already grants the resource (`isPlanCapped` false),
  //    i.e. mostly existing Pro customers. Counting it would put paying users
  //    into a metric about acquiring them.
  //
  // `variant` is sent as a property anyway, per the taxonomy's intent that the
  // two be separable downstream. It is constant ("hard") by construction
  // today, which is the point: the value is explicit in the stream, so if this
  // gate is ever widened to include soft impressions, the older and newer
  // events remain distinguishable without a taxonomy change or a guess about
  // when the behaviour shifted.
  //
  // WEB ONLY, and not a gap. UpsellModal.native.tsx never renders a price or
  // any purchase affordance under any variant — that is its store-compliance
  // invariant, not an omission — so on native there is no offer for an
  // "upgrade viewed" to refer to. Emitting there would report an offer the
  // build is forbidden to make.
  //
  // ONCE PER APPEARANCE. Keyed off the false -> true edge of `offered` via a
  // ref, not off render: this component re-renders on `busy` and
  // `checkoutError`, so a bare call in the body would emit again every time
  // the user pressed the CTA or a checkout error arrived — turning one offer
  // into several and biasing the count toward exactly the users who engaged
  // with it most.
  const offered = visible && selling;
  const wasOffered = useRef(false);
  useEffect(() => {
    if (offered && !wasOffered.current) {
      // Closed, developer-authored unions only — no workspace id (the modal
      // holds one, and it is deliberately not sent), no uid, no free text.
      track("upgrade_viewed", { resource, plan: effectivePlan, variant });
    }
    wasOffered.current = offered;
  }, [offered, resource, effectivePlan, variant]);

  // Fix Wave F3 — this button used to ignore BILLING_LIVE entirely: pressing
  // it while checkout genuinely isn't reachable (G3 — no live Stripe account
  // yet, see this file's own header) fell through to `startCheckout` ->
  // `assertStripeConfigured` -> a `failed-precondition` error, surfacing to
  // the user as though something had gone wrong rather than the honest "not
  // available yet" `PricingBody.tsx:117` already shows for the exact same
  // gate. `canCheckoutNow`/`checkoutCtaLabel` are REUSED from
  // `lib/pricingCopy.ts`, not re-derived, so the two checkout entry points
  // can never disagree about when checkout is actually reachable or what to
  // call the button while it isn't.
  const canCheckout = canCheckoutNow(BILLING_LIVE, !!workspaceId);
  const ctaLabel = checkoutCtaLabel(BILLING_LIVE, !!workspaceId);

  const handleUpgrade = async () => {
    if (!canCheckout || !workspaceId || busy) return;
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

              {/* Everything from here to the close of this block is the SELL,
                  and it is the whole of what "soft" withholds. The title and
                  the limit message above are deliberately outside the gate:
                  the first encounter with a gate still has to say what
                  happened, or the denial reads as a broken button rather than
                  as a limit. Written as one conditional around the existing
                  markup rather than as a second, parallel soft body — a copy
                  of the title/limit lines for the soft case would be free to
                  drift from these, and "the gentle notice quietly stopped
                  naming the real limit" is not a failure any test here would
                  catch. */}
              {selling && (
                <>
                  <Text style={styles.price}>
                    {PENDING_PRO_PRICE_LABEL} unlocks {unlockPhrase(resource)}
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
                    accessibilityState={{ disabled: busy || !canCheckout }}
                    style={[styles.primaryButton, !canCheckout && styles.primaryButtonDisabled]}
                    onPress={handleUpgrade}
                    disabled={busy || !canCheckout}
                  >
                    {busy ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.primaryButtonText}>{ctaLabel}</Text>
                    )}
                  </TouchableOpacity>
                </>
              )}
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
            {/* "Not now" answers an offer. The soft body deliberately makes
                none, so declining one there would be incoherent — that branch
                gets the neutral acknowledgement the native variant already
                uses. Scoped so that every branch which exists today keeps the
                exact text it ships with: the hard sell and the transient
                throttle note are both untouched. */}
            <Text style={styles.dismissText}>{capped && !selling ? "OK" : "Not now"}</Text>
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
  primaryButtonDisabled: {
    backgroundColor: "#93c5fd",
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
