import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { randomInt } from "crypto";
import { countBoards } from "../billing/usage";
import { limitFor, type Plan } from "../billing/limits";

// Month 5 — board creation moves server-side so the free-tier board cap
// (functions/src/billing/limits.ts) can't be bypassed by a patched client or a
// raw REST call. firestore.rules still allows a direct client create with no
// count condition until a later task flips that to deny (Task 7); until then
// this callable and the direct client write are both live paths.

const INVITE_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const INVITE_CODE_LENGTH = 6;

/** Server-side invite codes: a client must not be able to choose its own code.
 *  Same 36-char alphabet and length as the client's prior generator
 *  (src/services/boardService.ts's `INVITE_CODE_CHARS` + `randomCode(6, ...)`);
 *  the decorative "BORD-" prefix that generator prepended is not reproduced —
 *  invite-code lookups match on the stored string verbatim, so the prefix was
 *  cosmetic, not part of the code's identity. */
export function generateInviteCode(): string {
  let out = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    out += INVITE_CODE_CHARS[randomInt(INVITE_CODE_CHARS.length)];
  }
  return out;
}

export interface CreateBoardRequest {
  workspaceId: string;
  title: string;
}

export interface CreateBoardResponse {
  boardId: string;
  inviteCode: string;
}

/** Injected so the handler unit-tests without Firestore, matching the
 *  handleGenerateSummary pattern. */
export interface CreateBoardDeps {
  getWorkspace(workspaceId: string): Promise<{ plan?: string; members?: Record<string, string> } | null>;
  countBoards(workspaceId: string): Promise<number>;
  writeBoard(doc: Record<string, unknown>): Promise<string>;
}

export async function handleCreateBoard(
  req: CallableRequest<CreateBoardRequest>,
  deps: CreateBoardDeps,
  now: number
): Promise<CreateBoardResponse> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to create a board.");

  const { workspaceId, title } = req.data ?? ({} as CreateBoardRequest);
  if (!workspaceId) throw new HttpsError("invalid-argument", "workspaceId is required.");
  if (!title || !title.trim()) throw new HttpsError("invalid-argument", "A board title is required.");

  const ws = await deps.getWorkspace(workspaceId);
  if (!ws) throw new HttpsError("not-found", "Workspace not found.");
  if (!ws.members || !(uid in ws.members)) {
    throw new HttpsError("permission-denied", "You are not a member of this workspace.");
  }

  const plan = (ws.plan ?? "free") as Plan;
  const used = await deps.countBoards(workspaceId);
  const limit = limitFor(plan, "boards");
  // Deny unless PROVABLY under the cap, rather than allow unless provably at
  // it. `limitFor` can return `undefined` for a prototype-shaped plan value
  // (e.g. "__proto__" — PLAN_LIMITS["__proto__"] is truthy, so the `?? free`
  // fallback never fires, and `["boards"]` off it is undefined) and `used`
  // could in principle be `NaN`; `used >= limit` evaluates `false` for both,
  // which would grant. The negated form denies on both instead, with no
  // extra branch needed for `UNLIMITED` (`Infinity`) — `used < Infinity` is
  // simply always true for a finite `used`.
  if (!(used < limit)) {
    throw new HttpsError(
      "resource-exhausted",
      `You've reached your plan's board limit (${limit}). Upgrade for more.`
    );
  }

  // Generated here, never taken from req.data: a client cannot choose its own
  // invite code (see generateInviteCode above).
  const inviteCode = generateInviteCode();
  const boardId = await deps.writeBoard({
    workspaceId,
    title: title.trim(),
    ownerId: uid,
    adminId: uid,
    collaboratorIds: [],
    inviteCode,
    members: [uid],
    roles: {},
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdAtMs: now,
  });

  return { boardId, inviteCode };
}

export const createBoard = onCall((req: CallableRequest<CreateBoardRequest>) => {
  const db = getFirestore();
  return handleCreateBoard(
    req,
    {
      getWorkspace: async (id) => {
        const s = await db.doc(`workspaces/${id}`).get();
        return s.exists ? (s.data() as { plan?: string; members?: Record<string, string> }) : null;
      },
      countBoards: (id) => countBoards(db, id),
      writeBoard: async (doc) => (await db.collection("boards").add(doc)).id,
    },
    Date.now()
  );
});
