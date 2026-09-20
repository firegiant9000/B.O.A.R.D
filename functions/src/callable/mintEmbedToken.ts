import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { resolveBoardAccess, type BoardAccess } from "../lib/board";
import {
  mintEmbedToken,
  isAllowedIssuer,
  normalizeIssuer,
  parseIssuerAllowlist,
  MAX_EMBED_SUBJECT_LENGTH,
  EMBED_EDIT_TOKEN_TTL_SECONDS,
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
// ⚠️ Why 'edit' ALSO requires live workspace membership. `resolveBoardAccess`
// reads the board document alone, but the rules' isBoardAdmin additionally
// requires inBoardWorkspace — and removing someone from the workspace is the
// product's revocation mechanism. Without the check below, an owner/admin who had
// been removed from the workspace would be denied every direct write by the rules
// yet could still mint an edit token, exchange it, and write the canvas as an
// embed identity (isEmbedEditor has no workspace predicate, and necessarily so —
// an embed identity is in no workspace). That would turn revocation into a
// write-bypass. The check is on the edit arm only, so the read-only path and the
// other callers of resolveBoardAccess are untouched.
//
// A LEGACY board (no workspaceId) cannot satisfy that check and is refused an edit
// link outright: there is no workspace to verify against, and the null-workspace
// disjuncts elsewhere in the rules are exactly what make an unscoped identity
// dangerous on such a board. Read-only embeds on legacy boards are unaffected.
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
  /** Whether `uid` is still in the workspace's `members` map. Called ONLY on the
   *  edit arm, so the read-only mint path costs the same one board read it always
   *  did. Mirrors the rules' isMemberOfWorkspace. */
  isInWorkspace: (workspaceId: string, uid: string) => Promise<boolean>;
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
  if (scope === "edit") {
    if (!access.isAdmin) {
      throw new HttpsError(
        "permission-denied",
        "Only a board admin can create an editable embed link."
      );
    }
    if (!access.workspaceId) {
      throw new HttpsError(
        "failed-precondition",
        "This board predates workspaces and cannot have an editable embed link."
      );
    }
    // The revocation check — see the header. Admin on the board document is not
    // enough; the caller must still be in the board's workspace.
    if (!(await deps.isInWorkspace(access.workspaceId, uid))) {
      throw new HttpsError(
        "permission-denied",
        "You are no longer a member of this board's workspace."
      );
    }
  }

  const { token, expSeconds } = mintEmbedToken({
    boardId,
    scope,
    secret: deps.secret,
    nowMs,
    // An editable link gets a much shorter redemption window than a read-only one;
    // see EMBED_EDIT_TOKEN_TTL_SECONDS for what that does and does not bound.
    ...(scope === "edit"
      ? {
          // Canonicalise the issuer into the token so the identity it exchanges to
          // is the same however the caller cased the string.
          sub,
          iss: normalizeIssuer(iss as string),
          ttlSeconds: EMBED_EDIT_TOKEN_TTL_SECONDS,
        }
      : {}),
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
        isInWorkspace: async (workspaceId, uid) => {
          const snap = await getFirestore().doc(`workspaces/${workspaceId}`).get();
          if (!snap.exists) return false;
          const members = (snap.data() as { members?: Record<string, unknown> }).members;
          return !!members && Object.prototype.hasOwnProperty.call(members, uid);
        },
      },
      Date.now()
    )
);
