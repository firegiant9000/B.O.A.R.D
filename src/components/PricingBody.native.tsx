import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

// Native (iOS/Android) body of the pricing page — the platform-extension
// OVERRIDE Metro's real module resolution picks for a native build, ahead
// of the bare PricingBody.tsx (see that file's header, and app/pricing.tsx's
// header, for the convention and why it lives at the component layer rather
// than the route layer: expo-router's own route discovery is NOT
// platform-filtered, so a `.web` ROUTE file ships in a native bundle
// regardless of whether it's ever navigated to — this file's sibling
// avoids that because it is IMPORTED, and Metro's module resolution for an
// import genuinely excludes the non-matching platform file).
//
// COMPLIANCE INVARIANT, guarded by this component's test file (which scans
// this source text, not only its rendered output — mirrors
// UpsellModal.native.tsx's own guard): this file may never name a cost
// figure, a currency amount, an off-app link, or any affordance that could
// lead one off-app to complete a purchase — that is App Store / Play policy
// on external payment for a native app. It offers only a way back. Its own
// imports are react-native's UI primitives, expo-router's `useRouter` (for
// the back affordance — no navigation state carries a cost figure), and
// `@expo/vector-icons` — no billing seam of any kind, and no import of the
// shared module (in src/lib) that holds the placeholder figure.
export default function PricingBody() {
  const router = useRouter();
  return (
    <View style={styles.container}>
      <TouchableOpacity
        testID="pricing-native-back-button"
        accessibilityRole="button"
        onPress={() => router.back()}
        style={styles.backBtn}
      >
        <Ionicons name="chevron-back" size={24} color="#111827" />
      </TouchableOpacity>
      <View style={styles.body}>
        <Text style={styles.text}>Pricing isn't available in the app.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  backBtn: { paddingTop: 52, paddingHorizontal: 12, paddingBottom: 12, width: 40 },
  body: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  text: {
    fontSize: 15,
    color: "#374151",
    textAlign: "center",
  },
});
