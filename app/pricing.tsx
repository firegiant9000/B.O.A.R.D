import PricingBody from "../src/components/PricingBody";

// A SINGLE bare route — deliberately not split into pricing.tsx +
// pricing.web.tsx. That earlier layout was reviewed and found to leak the
// real, cost-figure-bearing page into the native bundle: expo-router discovers
// routes via a Metro `require.context` that is NOT platform-filtered (its
// generated context module emits a literal `require("./pricing.web.tsx")`
// regardless of target platform), unlike Metro's ordinary MODULE
// resolution, which genuinely excludes a `.native`/bare counterpart when
// something is imported by name. A `.web.tsx` ROUTE file is reachable code
// in every bundle even though expo-router only ever navigates to it on web —
// "unreachable" is not "absent", and the plan's compliance property is
// about the binary's contents, not just what a user can tap to.
//
// The fix: keep routing platform-agnostic (one route, no platform
// extension — so the mandatory-fallback-sibling requirement documented on
// the old pricing.tsx never applies either) and push the platform split
// down to a plain, IMPORTED component, where Metro's real per-platform
// module resolution takes over — the exact mechanism
// src/components/UpsellModal.tsx / UpsellModal.native.tsx already uses and
// that a native build genuinely cannot see the web sibling for. See
// src/components/PricingBody.tsx (web body, the bare/default file Metro
// resolves for any non-native platform) and
// src/components/PricingBody.native.tsx (native body — no cost figure or
// external-purchase affordance, same invariant as UpsellModal.native.tsx)
// for the actual content.
export default function Pricing() {
  return <PricingBody />;
}
