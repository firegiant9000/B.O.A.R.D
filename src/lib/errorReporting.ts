/**
 * Central error-reporting seam.
 *
 * Every place that used to swallow errors silently (`.catch(() => {})`) now routes
 * through here, and the top-level ErrorBoundary reports render crashes here too.
 *
 * Month 2, Phase 2 wired the real backend in behind this seam: when a Sentry DSN
 * is present we forward to `@sentry/react-native`; otherwise (local dev / Expo Go,
 * where the native SDK can't run anyway) we keep the original console fallback so
 * developer output is unchanged. Call sites never changed when this landed.
 *
 * DSN comes from `EXPO_PUBLIC_SENTRY_DSN`, injected at build time by EAS (see
 * .env.example). Source-map upload is handled by the Sentry Expo config plugin
 * using `SENTRY_AUTH_TOKEN` at build time, not at runtime.
 */
import * as Sentry from "@sentry/react-native";

type Extra = Record<string, unknown>;

let initialized = false;
/** True once Sentry is initialized AND actively forwarding events. */
let sentryEnabled = false;

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

/** Call once at app startup. Initializes Sentry when a DSN is configured. */
export function initErrorReporting(): void {
  if (initialized) return;
  initialized = true;

  if (!dsn) {
    // No DSN (local dev, Expo Go, or unconfigured). Stay on the console fallback.
    return;
  }

  try {
    Sentry.init({
      dsn,
      // Suppress noisy dev-reload events; standalone (preview/production) builds
      // report. The dogfood-exception exit criterion is verified on a real build.
      enabled: !__DEV__,
      tracesSampleRate: __DEV__ ? 1.0 : 0.2,
    });
    sentryEnabled = !__DEV__;
  } catch (error) {
    console.warn(
      "[errorReporting] Sentry.init failed; falling back to console:",
      error
    );
  }
}

/** Report a caught exception. Use instead of swallowing errors silently. */
export function captureException(error: unknown, extra?: Extra): void {
  if (sentryEnabled) {
    Sentry.captureException(error, extra ? { extra } : undefined);
    return;
  }
  if (extra) {
    console.warn("[errorReporting] captureException:", error, extra);
  } else {
    console.warn("[errorReporting] captureException:", error);
  }
}

/** Report a noteworthy non-exception event. */
export function captureMessage(message: string, extra?: Extra): void {
  if (sentryEnabled) {
    Sentry.captureMessage(message, extra ? { extra } : undefined);
    return;
  }
  if (extra) {
    console.warn("[errorReporting] captureMessage:", message, extra);
  } else {
    console.warn("[errorReporting] captureMessage:", message);
  }
}
