import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { resolveBoardAccess } from "../lib/board";
import { mintEmbedToken, type EmbedScope } from "../embed/token";
import { EMBED_JWT_SECRET } from "../config";

// Mint a signed embed token for a board (Month 4, Phase 8). Authed; only a board
// member may mint a link to it — minting is "share this board", a member-only act.
// The token is signed server-side (secret never reaches the client) and is short-
// lived. Phase 8 mints read-only ('view') tokens only; the 'edit' scope is
// reserved for M5/M6 integrations (the request can't ask for it yet).

export interface MintEmbedTokenRequest {
  boardId: string;
  scope?: EmbedScope;
}

export interface MintEmbedTokenResponse {
  token: string;
  scope: EmbedScope;
  /** Token expiry, seconds since epoch — lets the client schedule a re-mint. */
  expiresAt: number;
}

export async function handleMintEmbedToken(
  req: CallableRequest<MintEmbedTokenRequest>,
  secret: string,
  nowMs: number
): Promise<MintEmbedTokenResponse> {
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to create an embed link.");
  }

  const { boardId } = req.data ?? ({} as MintEmbedTokenRequest);
  if (!boardId) {
    throw new HttpsError("invalid-argument", "boardId is required.");
  }

  // Phase 8 ships read-only embeds only. Reject an edit-scope request rather than
  // silently downgrade, so a future editable integration fails loudly until the
  // edit path is actually wired.
  const requested = req.data?.scope ?? "view";
  if (requested !== "view") {
    throw new HttpsError("invalid-argument", "Only read-only embed links are supported.");
  }

  const db = getFirestore();
  const access = await resolveBoardAccess(db, boardId, uid);
  if (!access) {
    throw new HttpsError("not-found", "Board not found.");
  }
  if (!access.isMember) {
    throw new HttpsError("permission-denied", "You are not a member of this board.");
  }

  const { token, expSeconds } = mintEmbedToken({ boardId, scope: "view", secret, nowMs });
  return { token, scope: "view", expiresAt: expSeconds };
}

export const mintEmbedToken_fn = onCall(
  { secrets: [EMBED_JWT_SECRET] },
  (req: CallableRequest<MintEmbedTokenRequest>) =>
    handleMintEmbedToken(req, EMBED_JWT_SECRET.value(), Date.now())
);
