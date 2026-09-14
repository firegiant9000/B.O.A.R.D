/**
 * Central analytics seam.
 *
 * Every place that reports a product event goes through here — `track()` and
 * `identifyWorkspace()` — the same discipline as `src/lib/errorReporting.ts`:
 * one file owns the vendor (PostHog). The vendor SDK itself differs by
 * platform (`posthog-js` on web, `posthog-react-native` on native), so its
 * construction is split beside this file — see posthogClient.ts /
 * posthogClient.native.ts — but the taxonomy, the PII scrub, and the
 * hashed-identifier rule below live once, here. Every emitter in the app
 * imports `track`/`identifyWorkspace` from this module, and nothing anywhere
 * imports posthog-js / posthog-react-native directly. As of ROADMAP.md:685's
 * funnel instrumentation those emitters span app screens (app/(tabs)/index,
 * app/(tabs)/schedule, app/session/create, app/session/[id]), components
 * (WorkspaceSwitcher, StartSessionModal, UpsellModal), a hook
 * (useBoardDocument) and four services (authService, templateService,
 * sessionAnalytics, planObservation), plus one `identifyWorkspace` call in
 * app/_layout.tsx.
 *
 * WHERE EMITTERS MAY LIVE. The funnel is instrumented at the point of USER
 * INTENT — the screen or component where a person pressed the button — and
 * never inside a shared service primitive. `boardService.createBoard`,
 * `sessionService.createSession`/`endSession`/`updateSessionSummary` and
 * `workspaceService.createWorkspace` are all called directly by
 * `onboardingService.seedSampleWorkspace`, which hands every brand-new
 * account a demo board and a finished demo session nobody asked for; an emit
 * pushed down into any of them would report that demo as a real
 * board/session for every signup and corrupt the pre-launch baseline
 * ROADMAP.md:750 makes a launch gate. That negative is enforced, not merely
 * documented — see src/services/__tests__/analyticsBoundary.test.ts.
 *
 * The PostHog key comes from `EXPO_PUBLIC_POSTHOG_KEY`, a PostHog *project*
 * key — publishable by design (it identifies a project, not a person; the
 * ingestion endpoint is the real boundary), unlike a PostHog *personal/API*
 * key, which must never go in client code. `EXPO_PUBLIC_POSTHOG_HOST` is the
 * matching ingestion host; unset falls back to PostHog's US cloud default.
 *
 * Month 6 — G5 (a provisioned PostHog project) is not met yet, so
 * `EXPO_PUBLIC_POSTHOG_KEY` is unset in every environment today and
 * `track()`/`identifyWorkspace()` take the no-op branch below on every real
 * call. That branch is not a stand-in for this gap — an unconfigured key is
 * an ordinary, permanent deployment state (a self-hosted fork, local dev
 * with no PostHog account), never an error, which is why it no-ops instead
 * of throwing; an event outside the documented taxonomy is the opposite
 * case — a programmer error — and always throws, independent of whether a
 * key is configured.
 *
 * Global Constraint: never log or transmit a raw user/workspace identifier
 * into analytics — hashed workspace id + role only, and any email-shaped
 * value is stripped from event properties. Both are enforced once, here,
 * not re-implemented at each call site.
 */
import { sha256Hex } from "../lib/sha256";
import type { WorkspaceRole } from "../types";
import { createAnalyticsClient } from "./posthogClient";

/** Minimal shape either vendor wrapper (posthogClient.ts /
 *  posthogClient.native.ts) must expose. Deliberately narrower than either
 *  vendor SDK's real client — this seam only ever calls these two methods. */
export interface AnalyticsClient {
  capture(event: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties?: Record<string, unknown>): void;
}

/** Event names this app is allowed to emit. This array is the single source
 *  of truth for both the compile-time `AnalyticsEvent` union below and the
 *  runtime check in `track()` — a caller who bypasses the type system (a
 *  dynamic string, or an explicit cast) still can't reach the vendor with an
 *  undocumented event. */
const CORE_EVENTS = [
  "signup",
  "workspace_created",
  "board_created",
  "session_scheduled",
  "session_completed",
  "ai_summary_generated",
  "upgrade_viewed",
  "upgrade_completed",
] as const;

/** One `"<surface>_installed"` event per integration surface that actually
 *  ships in this repo today — not one per surface that is merely planned.
 *  ROADMAP.md:685 requires "an install event per integration surface", and
 *  both surfaces below exist in this repo.
 *
 *  ⚠ NEITHER OF THESE HAS AN EMITTER. Both entries are taxonomy ahead of
 *  instrumentation, and saying so here is the point — a name in this list is
 *  not evidence that anything sends it. The reason is the same for both, and
 *  it is structural rather than an oversight:
 *
 *  `web/extension/` and `web/meet-addon/` are separate surfaces with no build
 *  step of their own — hand-written plain JS in the extension, inline script
 *  in the add-on's panel.html. Neither can import this module, or anything
 *  else under `src/`; that is why `web/extension/shared.js` exists at all as a
 *  hand-maintained twin of `src/lib/extension/`, kept honest by
 *  `src/lib/extension/__tests__/sharedMirror.test.ts`. The genuine install
 *  signal — the extension's `chrome.runtime.onInstalled` in background.js —
 *  is therefore only reachable from code that cannot call `track()`.
 *
 *  The two ways to close that, and why neither is taken here:
 *   - Post to PostHog's HTTP capture endpoint directly from background.js.
 *     That means a project key baked into an unbundled extension, a new host
 *     in `manifest.json`, and a third-party network call from a surface whose
 *     README states it "sends tab title/URL/og:image to the side panel only —
 *     never to a third party". That is a privacy-posture change for a
 *     to-be-submitted Web Store listing, not an instrumentation detail, and
 *     it is not mine to make unilaterally.
 *   - Have the app infer the extension from the embed page it iframes. That
 *     observes a PANEL OPEN, not an install: it would fire on every open, for
 *     every reopen, from an anonymous view-scope embed identity with no
 *     workspace — the same over-count `upgrade_completed` exists to avoid
 *     (see src/services/planObservation.ts), under a name that claims
 *     otherwise.
 *
 *  So the names are reserved and the gap is stated. The runtime guard below
 *  still accepts them, which is what lets an emitter be added later without
 *  touching this file; until one is, read the absence of these events as "not
 *  instrumented", never as "nobody installed it". */
const INSTALL_EVENTS = [
  "meet_addon_installed", // web/meet-addon/ (Month 6 — Google Meet add-on shell)
  "extension_installed", // web/extension/ (Month 6 — Chrome/Edge MV3 side panel)
] as const;

const ALL_EVENTS = [...CORE_EVENTS, ...INSTALL_EVENTS] as const;
const EVENT_SET: ReadonlySet<string> = new Set(ALL_EVENTS);

export type AnalyticsEvent = (typeof ALL_EVENTS)[number];

const REDACTED = "[redacted]";
// Deliberately loose: matches an email-shaped substring anywhere in a
// string, not only a value that IS one — a note that merely mentions an
// address ("invited student@university.edu") must not leak it either. The
// cost of that looseness: a non-email `x@y.ext`-shaped string also matches
// (a retina asset filename like "icon@2x.png" would be redacted). Accepted —
// over-redaction is the safe direction under a no-identifiers constraint,
// and no property in today's taxonomy has that shape.
const EMAIL_PATTERN = /[^\s"'<>]+@[^\s"'<>]+\.[^\s"'<>]+/;
// Analytics event properties are flat metadata, never app-state graphs —
// this bounds pathological/circular input; it is not a depth this app's real
// event properties approach.
const MAX_SCRUB_DEPTH = 8;

/** True when `key`, split on camelCase/snake_case/kebab-case boundaries, has
 *  a token exactly equal to "email" — "userEmail", "contact_email", and
 *  "email" itself all match; "voicemail" (this app ships voice notes — Month
 *  5) does not, because it has no case or separator boundary splitting
 *  "voice" from "mail". A plain substring test (`/email/i`) would have
 *  flagged "voicemail" and any future field like it. */
function isEmailKey(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .some((token) => token.toLowerCase() === "email");
}

/** Recursively redacts — replaces the whole value, never merely masks part
 *  of it — anything email-shaped from event properties: strings, and strings
 *  nested inside objects/arrays at any depth, plus any value under a key
 *  that IS an "email" token (see isEmailKey) regardless of that value's own
 *  shape. Also drops (see below) any entry whose KEY ITSELF is email-shaped
 *  content, e.g. `{ "student@university.edu": true }` — a roster keyed by
 *  email is an ordinary shape, and a scrub that only ever looks at values
 *  and key *names* would let that through `JSON.stringify` verbatim.
 *
 *  Note: `value` is presumed JSON-plain data (string/number/boolean/null,
 *  plus plain objects/arrays of the same) — the shape `track()`'s `props`
 *  bag is documented to carry and the only shape any vendor SDK accepts. A
 *  `Date`, `RegExp`, or other class instance isn't scrubbed specially; it
 *  simply isn't itself a string or array, so it falls to the object branch,
 *  and `Object.entries` on it yields no own enumerable properties — it
 *  silently arrives at the vendor as `{}` rather than throwing. */
function scrub(value: unknown, depth: number): unknown {
  if (depth > MAX_SCRUB_DEPTH) return REDACTED;
  if (typeof value === "string") {
    return EMAIL_PATTERN.test(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // An email-shaped KEY is dropped entirely rather than kept under a
      // constant redacted key: two email keys in the same object would
      // otherwise collide onto one entry and silently drop data. The value
      // under an email-shaped key is suspect anyway, so dropping it loses
      // nothing worth keeping.
      if (EMAIL_PATTERN.test(key)) continue;
      out[key] = isEmailKey(key) ? REDACTED : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** First 16 hex chars of a sha256 of `workspaceId` — the same shape as
 *  functions/src/ai/usage.ts's `hashWorkspaceId` (sha256, hex, sliced to 16),
 *  so the two are recognisably the same discipline even though a client
 *  package can't import a Functions-only module. The two are NOT expected to
 *  produce matching values for the same id — each hashes for its own log
 *  stream — only the shape matches. */
function hashWorkspaceId(workspaceId: string): string {
  return sha256Hex(workspaceId).slice(0, 16);
}

const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
const apiHost = process.env.EXPO_PUBLIC_POSTHOG_HOST;

let client: AnalyticsClient | null | undefined; // undefined = not yet attempted

function getClient(): AnalyticsClient | null {
  if (client !== undefined) return client;
  if (!apiKey) {
    client = null;
    return client;
  }
  try {
    client = createAnalyticsClient(apiKey, apiHost);
  } catch (error) {
    console.warn(
      "[analyticsService] createAnalyticsClient failed; analytics disabled:",
      error
    );
    client = null;
  }
  return client;
}

/** Swallows a vendor-side throw so a reporting failure can never break the
 *  user action that reported it.
 *
 *  Added with ROADMAP.md:685's funnel instrumentation, which took this seam
 *  from a single call site to a dozen — and put them on paths where a throw
 *  is genuinely destructive: `authService.ensureUserProvisioned` (a thrown
 *  emit there fails a signup), the board/session create handlers, and the
 *  three end-session handlers. `getClient()` already degrades a construction
 *  failure to a permanent no-op, but `capture`/`identify` themselves were
 *  unguarded, so "analytics never breaks a user action" was true only for an
 *  unconfigured key — the state every environment happens to be in today
 *  (Gate G5), and therefore the state in which nobody would ever have
 *  noticed. Guarding once here beats every call site remembering its own
 *  try/catch, and beats every one of them having to know whether the vendor
 *  SDK throws synchronously.
 *
 *  Deliberately NOT wrapped around the taxonomy check in `track()` below: an
 *  undocumented event is a programmer error and must keep throwing loudly at
 *  the developer who wrote it, which is a different failure from the vendor
 *  misbehaving in a user's hands. */
function emitSafely(emit: () => void): void {
  try {
    emit();
  } catch (error) {
    console.warn("[analyticsService] vendor call failed; event dropped:", error);
  }
}

/**
 * Emit a product event. Throws for any event outside the documented
 * taxonomy (a programmer error) and no-ops — never throws — when no
 * PostHog key is configured (an expected deployment state) or when the
 * vendor itself fails. `props` is scrubbed of anything email-shaped,
 * recursively, before it reaches the vendor.
 *
 * Synchronous and fire-and-forget by design: a caller on a user's critical
 * path calls this without `await`ing anything (there is nothing to await) and
 * without wrapping it.
 */
export function track(
  event: AnalyticsEvent,
  props?: Record<string, unknown>
): void {
  if (!EVENT_SET.has(event)) {
    throw new Error(
      `analyticsService.track: "${event}" is not in the documented event taxonomy`
    );
  }
  const posthogClient = getClient();
  if (!posthogClient) return;
  emitSafely(() =>
    posthogClient.capture(
      event,
      props ? (scrub(props, 0) as Record<string, unknown>) : undefined
    )
  );
}

/**
 * Associate subsequent events with a workspace. Per the Global Constraint,
 * PostHog only ever sees a hashed workspace id and a role — never the raw
 * workspace id or any other user identifier. No-ops when no PostHog key is
 * configured, same as `track()`.
 */
export function identifyWorkspace(
  workspaceId: string,
  role: WorkspaceRole
): void {
  const posthogClient = getClient();
  if (!posthogClient) return;
  // `{ role }` can't actually carry PII today — WorkspaceRole is a closed
  // union — but routing it through the same scrub() as track() costs nothing
  // and removes any "why does this one path skip the guard?" question.
  emitSafely(() =>
    posthogClient.identify(
      hashWorkspaceId(workspaceId),
      scrub({ role }, 0) as Record<string, unknown>
    )
  );
}
