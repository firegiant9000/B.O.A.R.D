import posthog from "posthog-js";
import type { AnalyticsClient } from "./analyticsService";

// Web body of the PostHog vendor split — the platform-extension DEFAULT
// (bare filename). Metro's real per-platform MODULE resolution (not
// expo-router's route discovery — see app/pricing.tsx's header for why that
// distinction matters here too) resolves THIS file for any non-native
// build; the sibling posthogClient.native.ts overrides it for iOS/Android,
// the same convention src/components/PricingBody.tsx /
// PricingBody.native.tsx already uses. analyticsService.ts imports this
// module by its bare, extension-less path so each platform's bundle only
// ever contains the vendor package it actually needs — `posthog-js` here,
// `posthog-react-native` in the sibling.
//
// This file owns ONLY the vendor construction. The taxonomy check, the PII
// scrub, the hashed-identifier discipline, and the no-key no-op all live
// once in analyticsService.ts — this split exists so two different vendor
// SDKs can sit behind one seam, not so the compliance logic is duplicated.
export function createAnalyticsClient(
  apiKey: string,
  host: string | undefined
): AnalyticsClient {
  posthog.init(apiKey, {
    api_host: host || "https://us.i.posthog.com",
    // This is an app shell, not a marketing site: every event this SDK ever
    // sends is one analyticsService.ts explicitly validated against the
    // taxonomy. Autocapture, pageview, and session-recording are the SDK's
    // own automatic instrumentation and would bypass that validation, so
    // they're turned off here rather than left at their (enabled) defaults.
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
  });
  return {
    capture: (event, properties) => {
      posthog.capture(event, properties ?? null);
    },
    identify: (distinctId, properties) => {
      posthog.identify(distinctId, properties);
    },
  };
}
