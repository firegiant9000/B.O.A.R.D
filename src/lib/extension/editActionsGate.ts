/**
 * Month 6 — browser extension write actions (drag-an-image-onto-the-board,
 * send-this-page-to-a-board).
 *
 * ⛔ OFF BY DESIGN — DO NOT FLIP WITHOUT READING THIS.
 *
 * Both actions this gates would create board content through the extension's
 * own embed session, and an exchanged embed session outlives every control
 * that appears to bound it: `signInWithCustomToken` establishes a Firebase
 * Auth session whose refresh token outlives the embed token's own expiry, is
 * not invalidated by re-minting a new token, and is not revoked by rotating
 * the signing secret. So a leaked *editable* embed link is board write access
 * with **no revocation path anywhere in this codebase** — see
 * `EMBED_EDIT_TOKEN_TTL_SECONDS`'s doc comment in functions/src/embed/token.ts
 * and the embed sections of docs/functions-deploy-runbook.md for the full
 * detail, and web/meet-addon/README.md's BLOCKER section for the same ruling
 * applied to that integration.
 *
 * The side panel here only ever redeems a **view**-scope link (the one
 * ShareBoardModal's "Embed (read-only)" action produces; see
 * src/lib/extension/tokenScopeGuard.ts for the second check that refuses to
 * even load anything else), so this flag stays `false` and nothing downstream
 * of it runs — dropped images and "send this page" both stop at a staged,
 * inert "pending item" card, never a write.
 *
 * Closing the underlying gap needs, at minimum: `auth.revokeRefreshTokens(uid)`
 * reachable from somewhere, an `auth_time` bound in firestore.rules'
 * `isEmbedEditor`, and a client that re-exchanges on expiry instead of holding
 * one Auth session indefinitely. None of that exists yet. And even once it
 * does, actually writing from the extension needs the Firebase JS SDK bundled
 * into it — a new dependency this task deliberately does not add (a
 * Manifest V3 extension here ships with none).
 *
 * Do not flip this to `true` until both are true.
 */
export const EDIT_ACTIONS_ENABLED = false as const;
