import React from "react";
import { View, Text, StyleSheet } from "react-native";

// Platform-extension FALLBACK, required by expo-router's own route-tree
// resolution — NOT a design choice made here. expo-router (getRoutesCore.js
// in this project's installed version) requires every route that has a
// platform-suffixed sibling (the web-only variant of this route) to also
// have a file with no platform extension; the web-only file with no bare
// sibling throws "does not have a fallback sibling file without a platform
// extension" at route-tree build time — verified empirically against this
// exact package version (see the task report), not assumed from the
// framework's naming convention alone. This file IS what a native build
// resolves for this route: the web-only variant overrides it only on web.
//
// Because this file IS reachable from a native build, it must carry the
// same store-compliance invariant as src/components/UpsellModal.native.tsx
// (see that file's header comment): no cost figure, no currency amount, no
// external-purchase affordance, no billing-service import, nothing that
// could read as facilitating a purchase from outside the native binary. The
// route it stands in for is never linked to from anywhere in this app's
// native navigation — there is no button, tab, or menu item that pushes it
// on iOS/Android — so this only renders if something opens the matching URL
// directly (e.g. a stray deep link).
export default function PricingNotAvailable() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Pricing isn't available in the app.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#fff",
  },
  text: {
    fontSize: 15,
    color: "#374151",
    textAlign: "center",
  },
});
