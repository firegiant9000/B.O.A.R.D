import PostHog from "posthog-react-native";
import type { AnalyticsClient } from "./analyticsService";

// Native (iOS/Android) body of the PostHog vendor split — the
// platform-extension OVERRIDE Metro's real module resolution picks for a
// native build, ahead of the bare posthogClient.ts (see that file's header
// for the convention: src/components/PricingBody.tsx / PricingBody.native.tsx
// already relies on the same mechanism). analyticsService.ts imports
// `./posthogClient` (no extension) so this file — not posthog-js — is the
// one bundled into a native build.
//
// This file owns ONLY the vendor construction; see posthogClient.ts's
// header for why the taxonomy/scrub/hash discipline is not duplicated here.
export function createAnalyticsClient(
  apiKey: string,
  host: string | undefined
): AnalyticsClient {
  const client = new PostHog(apiKey, {
    host: host || "https://us.i.posthog.com",
    // Every event this SDK ever sends should be one analyticsService.ts
    // explicitly validated against the taxonomy. These three default ON and
    // would otherwise emit events (app open/background, push
    // subscribe/open) this seam never validated, so they're turned off
    // rather than left at their defaults. Session replay and native crash
    // capture already default off and are left untouched.
    captureAppLifecycleEvents: false,
    capturePushNotificationSubscriptions: false,
    capturePushNotificationOpened: false,
  });
  return {
    capture: (event, properties) => {
      // posthog-react-native's own types require JSON-safe values
      // (PostHogEventProperties); AnalyticsClient's contract is the broader
      // Record<string, unknown> every caller of this seam gets. The scrub in
      // analyticsService.ts only ever produces JSON-safe output, so this is a
      // type-level widening, not a behavior change.
      client.capture(event, properties as never);
    },
    identify: (distinctId, properties) => {
      client.identify(distinctId, properties as never);
    },
  };
}
