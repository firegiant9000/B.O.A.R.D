import type { EmbedScope } from "../types";

/**
 * Month 5 — resolves the scope an embed session should render with, from
 * whatever `exchangeEmbedToken` returned (see src/services/embedService.ts).
 * The exchange is a server-verified Cloud Function response, but it still
 * crosses the network as untyped JSON, so this is the one place that turns it
 * into a value the embed route (app/embed/b/[id].tsx) trusts enough to decide
 * whether to show editing chrome.
 *
 * SAFE DEFAULT: anything other than the exact literal "edit" resolves to
 * "view" — an unknown, missing or malformed value must never be treated as
 * "edit". Getting this backwards would show write tools (and, via
 * `BoardScreen`'s `embedScope` prop, enable the canvas-write affordances) for
 * a session the exchange never actually granted edit scope to.
 *
 * This function decides UI only, never write permission. Even if it were
 * wrong in the dangerous direction, `firestore.rules`' `isEmbedEditor` (Month
 * 5, functions/src/embed/token.ts) is the actual enforcement boundary and
 * reads the signed token's own scope claim independently — a bug here would
 * be a confusing/broken UI, not a write it didn't already have to grant.
 * Still: default closed, not open.
 */
export function parseEmbedScope(rawScope: unknown): EmbedScope {
  return rawScope === "edit" ? "edit" : "view";
}
