/**
 * Central error-reporting seam.
 *
 * Every place that used to swallow errors silently (`.catch(() => {})`) now routes
 * through here, and the top-level ErrorBoundary reports render crashes here too.
 *
 * Today this logs to the console. It is intentionally the *single* place where a
 * real backend (Sentry) gets wired in. Sentry's native SDK can't be fully
 * initialized until EAS Build exists (Month 2), so the swap is deferred — but the
 * call sites do not change when it lands:
 *
 *   import * as Sentry from "@sentry/react-native";
 *   Sentry.init({ dsn: ... });                    // in initErrorReporting()
 *   Sentry.captureException(error, { extra });     // in captureException()
 */

type Extra = Record<string, unknown>;

let initialized = false;

/** Call once at app startup. No-op today; Sentry.init() lands here in Month 2. */
export function initErrorReporting(): void {
  if (initialized) return;
  initialized = true;
  // TODO(M2): Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN, ... })
}

/** Report a caught exception. Use instead of swallowing errors silently. */
export function captureException(error: unknown, extra?: Extra): void {
  if (extra) {
    console.warn("[errorReporting] captureException:", error, extra);
  } else {
    console.warn("[errorReporting] captureException:", error);
  }
  // TODO(M2): Sentry.captureException(error, { extra });
}

/** Report a noteworthy non-exception event. */
export function captureMessage(message: string, extra?: Extra): void {
  if (extra) {
    console.warn("[errorReporting] captureMessage:", message, extra);
  } else {
    console.warn("[errorReporting] captureMessage:", message);
  }
  // TODO(M2): Sentry.captureMessage(message, { extra });
}
