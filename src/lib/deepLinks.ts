/**
 * Deep-link contract (Month 2, Phase 4).
 *
 * This module is the SINGLE SOURCE OF TRUTH for B.O.A.R.D's link schema. Every
 * place that builds a shareable link or interprets an inbound one routes through
 * here so the contract stays stable across the app, the share sheet, and the
 * hosted Universal / App Link association files.
 *
 * Locked contract:
 *   - Custom scheme (in-app / notifications):  boardapp://board/{boardId}?session={sessionId}
 *   - Universal Link (iOS) / App Link (Android): https://<domain>/b/{inviteCode}
 *
 * The custom scheme works today via expo-router's `scheme` ("boardapp" in
 * app.json) with zero native config. The https form additionally requires the
 * hosted association files in `public/.well-known/` plus the native
 * associatedDomains / intentFilters config (see README → "Deep linking").
 */

export const APP_SCHEME = "boardapp";

/**
 * Apex host used to build https invite links. Sourced from the build-time env so
 * production can point at the real domain; falls back to a documented placeholder
 * until the domain + hosting are provisioned (Phase 4 ships scheme-first).
 */
export const LINK_DOMAIN_PLACEHOLDER = "boardapp.example.com";

export function getLinkDomain(): string {
  const fromEnv =
    typeof process !== "undefined" ? process.env?.EXPO_PUBLIC_LINK_DOMAIN : undefined;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : LINK_DOMAIN_PLACEHOLDER;
}

/** Whether a real link domain has been configured (vs. the placeholder). */
export function hasLinkDomain(): boolean {
  return getLinkDomain() !== LINK_DOMAIN_PLACEHOLDER;
}

export type ParsedDeepLink =
  | { type: "board"; boardId: string; sessionId?: string }
  | { type: "invite"; inviteCode: string }
  | { type: "unknown" };

/** Build the canonical in-app deep link for a board (optionally a session). */
export function buildBoardUri(boardId: string, sessionId?: string): string {
  const base = `${APP_SCHEME}://board/${encodeURIComponent(boardId)}`;
  return sessionId ? `${base}?session=${encodeURIComponent(sessionId)}` : base;
}

/** Build the public https invite link that opens the app via Universal/App Links. */
export function buildInviteUrl(inviteCode: string): string {
  return `https://${getLinkDomain()}/b/${encodeURIComponent(inviteCode)}`;
}

/**
 * Parse any inbound URL into a route intent. Tolerant of the forms expo-linking
 * hands us: the production `boardapp://` and `https://<domain>/...` shapes, plus
 * the dev `exp://host:port/--/...` prefix. Unknown shapes return `{type:"unknown"}`
 * so callers never throw on garbage input.
 */
export function parseDeepLink(url: string | null | undefined): ParsedDeepLink {
  if (!url) return { type: "unknown" };

  // Split off the query string, then isolate the path segments regardless of
  // scheme/host. The `--/` marker is expo-go's dev-deep-link separator.
  const [withoutHash] = url.split("#");
  const [pathPart, queryPart = ""] = withoutHash.split("?");

  const afterDevMarker = pathPart.includes("/--/")
    ? pathPart.slice(pathPart.indexOf("/--/") + 4)
    : pathPart;

  // Drop only the scheme prefix ("boardapp://", "https://"), keeping the authority
  // as a segment. This matters for the custom scheme: in `boardapp://board/{id}`,
  // "board" is the URL *authority*, not a path segment, so it must survive here.
  // For https the domain becomes segments[0], which is harmless — we match the
  // "b" / "board" segments by exact name, never by position.
  const pathOnly = afterDevMarker.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");

  const segments = pathOnly
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  const query = parseQuery(queryPart);

  // https://<domain>/b/{inviteCode}
  const bIndex = segments.indexOf("b");
  if (bIndex !== -1 && segments[bIndex + 1]) {
    return { type: "invite", inviteCode: segments[bIndex + 1].toUpperCase() };
  }

  // boardapp://board/{id}?session={id}
  const boardIndex = segments.indexOf("board");
  if (boardIndex !== -1 && segments[boardIndex + 1]) {
    const sessionId = query.session || undefined;
    return { type: "board", boardId: segments[boardIndex + 1], sessionId };
  }

  return { type: "unknown" };
}

function parseQuery(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    if (!k) continue;
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}
