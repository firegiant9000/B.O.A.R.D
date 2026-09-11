import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { resolveBoardAccess, type BoardAccess } from "../lib/board";
import {
  mintEmbedToken,
  isAllowedIssuer,
  normalizeIssuer,
  parseIssuerAllowlist,
  MAX_EMBED_SUBJECT_LENGTH,
  type EmbedScope,
} from "../embed/token";
import { EMBED_JWT_SECRET, EMBED_ALLOWED_ISSUERS } from "../config";

// Mint a signed embed token for a board (Month 4 — read-only; Month 5 — editable).
// Authed; only a board member may mint a link, because minting is "share this
// board". The token is signed server-side (the secret never reaches the client)
// and is short-lived.
//
// Two scopes, two different gates:
//   'view' — any board member. Anonymous: no subject, one shared read-only
//            identity per board, exactly as Month 4.
//   'edit' — board OWNER/ADMIN only, and the request must name the host asserting
//            the user (`iss`, allowlisted) and that host's id for them (`sub`).
//
// ⚠️ Why 'edit' is admin-only. Board membership is not board write access: a
// workspace viewer, or a member demoted to 'viewer' by a per-board role override,
// is a member who cannot write the canvas (see isBoardEditor in firestore.rules).
// If minting an edit token needed only membership, such a member could mint one,
// exchange it, and write as the resulting embed identity — a straight privilege
// escalation around the role system. Gating on owner/admin is a STRICT SUBSET of
// the editors, so it cannot over-grant. Resolving the full effective-editor role
// server-side would duplicate the rules' role arithmetic in a second place; if
// that is ever needed, factor it out rather than re-deriving it here.
//
// The host asserting `sub` is trusted to assert it — see the trust-model note in
// ../embed/token.ts. This callable does not verify the subject, only that the
// issuer is one we accept and that the caller may hand that host write access.

export interface MintEmbedTokenRequest {
  boardId: string;
  scope?: EmbedScope;
  /** Host-asserted subject. Required for scope 'edit', rejected otherwise. */
  sub?: string;
  /** Issuing host. Required for scope 'edit' and must be on the allowlist. */
  iss?: string;
}

export interface MintEmbedTokenResponse {
  token: string;
  scope: EmbedScope;
  /** Token expiry, seconds since epoch — lets the client schedule a re-mint. */
  expiresAt: number;
}

export interface MintEmbedTokenDeps {
  /** HS256 signing secret. */
  secret: string;
  /** Hosts whose `iss` we accept, already parsed (see config.EMBED_ALLOWED_ISSUERS). */
  allowedIssuers: readonly string[];
  resolveAccess: (boardId: string, uid: string) => Promise<BoardAccess | null>;
}

export async function handleMintEmbedToken(
  req: CallableRequest<MintEmbedTokenRequest>,
  deps: MintEmbedTokenDeps,
  nowMs: number
): Promise<MintEmbedTokenResponse> {
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to create an embed link.");
  }

  const { boardId, scope: requestedScope, sub, iss } = req.data ?? ({} as MintEmbedTokenRequest);
  if (!boardId) {
    throw new HttpsError("invalid-argument", "boardId is required.");
  }

  const scope: EmbedScope = requestedScope ?? "view";
  if (scope !== "view" && scope !== "edit") {
    throw new HttpsError("invalid-argument", "Unknown embed scope.");
  }

  // Validate the request shape before spending a Firestore read on it.
  if (scope === "edit") {
    if (typeof sub !== "string" || sub === "" || sub.length > MAX_EMBED_SUBJECT_LENGTH) {
      throw new HttpsError(
        "invalid-argument",
        "An editable embed link requires a host-asserted subject."
      );
    }
    if (typeof iss !== "string" || !isAllowedIssuer(iss, deps.allowedIssuers)) {
      // The caller is an authenticated board admin, so naming the reason is fine —
      // this is a misconfigured integration, not an attacker probing.
      throw new HttpsError("invalid-argument", "Unknown embed host.");
    }
  } else if (sub !== undefined || iss !== undefined) {
    // A read-only embed is shared as a link: whoever opens it is not the person who
    // minted it, so pinning an identity to it would misattribute every viewer.
    throw new HttpsError(
      "invalid-argument",
      "A read-only embed link cannot carry a subject."
    );
  }

  const access = await deps.resolveAccess(boardId, uid);
  if (!access) {
    throw new HttpsError("not-found", "Board not found.");
  }
  if (!access.isMember) {
    throw new HttpsError("permission-denied", "You are not a member of this board.");
  }
  if (scope === "edit" && !access.isAdmin) {
    throw new HttpsError(
      "permission-denied",
      "Only a board admin can create an editable embed link."
    );
  }

  const { token, expSeconds } = mintEmbedToken({
    boardId,
    scope,
    secret: deps.secret,
    nowMs,
    // Canonicalise the issuer into the token so the identity it exchanges to is
    // the same however the caller cased the string.
    ...(scope === "edit" ? { sub, iss: normalizeIssuer(iss as string) } : {}),
  });
  return { token, scope, expiresAt: expSeconds };
}

export const mintEmbedToken_fn = onCall(
  { secrets: [EMBED_JWT_SECRET] },
  (req: CallableRequest<MintEmbedTokenRequest>) =>
    handleMintEmbedToken(
      req,
      {
        secret: EMBED_JWT_SECRET.value(),
        allowedIssuers: parseIssuerAllowlist(EMBED_ALLOWED_ISSUERS.value()),
        resolveAccess: (boardId, uid) => resolveBoardAccess(getFirestore(), boardId, uid),
      },
      Date.now()
    )
);
