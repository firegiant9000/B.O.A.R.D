import {
  collection,
  addDoc,
  getDocs,
  getDoc,
  deleteDoc,
  updateDoc,
  doc,
  query,
  where,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  deleteField,
  writeBatch,
} from "firebase/firestore";
import { db, auth } from "../config/firebase";
import { Board, BoardRole, Workspace, WorkspaceRole } from "../types";
import { randomCode } from "../lib/secureRandom";
import { isBackgroundTemplate } from "../lib/backgrounds";
import { assertQuota } from "./quotaService";

const boardsRef = collection(db, "boards");

const INVITE_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function mapBoard(id: string, data: Record<string, any>): Board {
  return {
    id,
    // "" marks a legacy/unmigrated board (see Board.workspaceId); readers below
    // treat it as belonging to the active workspace during the migration window.
    workspaceId: data.workspaceId ?? "",
    title: data.title ?? "Untitled",
    ownerId: data.ownerId ?? "",
    adminId: data.adminId ?? data.ownerId ?? "",
    collaboratorIds: data.collaboratorIds ?? [],
    inviteCode: data.inviteCode ?? "",
    members: data.members ?? [],
    roles: data.roles ?? {},
    backgroundTemplate: isBackgroundTemplate(data.backgroundTemplate)
      ? data.backgroundTemplate
      : "blank",
    createdAt: data.createdAt?.toDate() ?? new Date(),
    updatedAt: data.updatedAt?.toDate() ?? new Date(),
  };
}

function generateInviteCode(): string {
  return `BORD-${randomCode(6, INVITE_CODE_CHARS)}`;
}

// ── per-board role resolution (Phase 6) ──────────────────────────────────────
// One role-resolution function, reused by the UI (toolbar gating, the Share &
// permissions modal) and mirrored by `isBoardEditor` in firestore.rules. Keep the
// two in lockstep — drift here is a cross-tenant authorization bug.

const BOARD_ROLE_RANK: Record<BoardRole, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
};

/**
 * The effective per-board role for `uid`, or `undefined` if they have no access.
 *
 * Precedence (highest first):
 *  - not a board member ⇒ undefined.
 *  - board owner ⇒ always `editor`.
 *  - legacy board (no workspaceId) ⇒ `editor` for any member (pre-Phase-6 behavior,
 *    preserved during the migration window).
 *  - otherwise: an explicit `board.roles[uid]` override, else a default derived from
 *    the workspace role (owner/admin/member ⇒ editor, viewer ⇒ viewer) — then the
 *    floor is applied: a workspace `viewer` can never exceed `commenter`.
 */
export function effectiveBoardRole(
  board: Pick<Board, "workspaceId" | "ownerId" | "members" | "roles">,
  workspace: Pick<Workspace, "members"> | null,
  uid: string
): BoardRole | undefined {
  if (!board.members.includes(uid)) return undefined;
  if (uid === board.ownerId) return "editor";
  if (!board.workspaceId) return "editor";

  const wsRole: WorkspaceRole | undefined = workspace?.members?.[uid];
  const cap: BoardRole = wsRole === "viewer" ? "commenter" : "editor";
  const fallback: BoardRole = wsRole && wsRole !== "viewer" ? "editor" : "viewer";
  const base = board.roles?.[uid] ?? fallback;
  return BOARD_ROLE_RANK[base] <= BOARD_ROLE_RANK[cap] ? base : cap;
}

export function canEditBoardRole(role: BoardRole | undefined): boolean {
  return role === "editor";
}

// Used by Phase 7 comments; the role exists now so the rule and UI can read it.
export function canCommentBoardRole(role: BoardRole | undefined): boolean {
  return role === "editor" || role === "commenter";
}

/** Deletes all documents in a subcollection in 500-doc batches. */
async function deleteSubcollection(boardId: string, subcollection: string): Promise<void> {
  const snap = await getDocs(collection(db, "boards", boardId, subcollection));
  for (let i = 0; i < snap.docs.length; i += 500) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 500).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

export async function createBoard(
  title: string,
  ownerId: string,
  workspaceId: string
): Promise<string> {
  await assertQuota(workspaceId, "board");
  const inviteCode = generateInviteCode();
  const docRef = await addDoc(boardsRef, {
    workspaceId,
    title,
    ownerId,
    adminId: ownerId,
    collaboratorIds: [],
    inviteCode,
    members: [ownerId],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

// Migration-tolerant workspace scoping (Phase 2). We deliberately keep the
// membership/owner query as-is and filter the workspace client-side rather than
// issuing a compound `where('workspaceId','==',ws)` query: an equality filter
// silently drops legacy boards that predate the field (they'd vanish from a
// tester's list before the Phase 9 backfill runs), and it would force a new
// composite index mid-migration. A board matches when it's in the active
// workspace OR is still unscoped (legacy). Access itself is enforced by the
// security rules; this filter is list scoping only.
// TODO(phase-9-cutover): drop the `!b.workspaceId` legacy clause once the
// migration has backfilled every board and the soak window closes.
function inWorkspace(workspaceId: string | undefined) {
  return (b: Board) => !workspaceId || b.workspaceId === workspaceId || !b.workspaceId;
}

export async function getUserBoards(
  userId: string,
  workspaceId?: string
): Promise<Board[]> {
  const q = query(boardsRef, where("ownerId", "==", userId));
  const snapshot = await getDocs(q);
  return snapshot.docs
    .map((d) => mapBoard(d.id, d.data()))
    .filter(inWorkspace(workspaceId));
}

export async function getMemberBoards(
  userId: string,
  workspaceId?: string
): Promise<Board[]> {
  const q = query(boardsRef, where("members", "array-contains", userId));
  const snapshot = await getDocs(q);
  return snapshot.docs
    .map((d) => mapBoard(d.id, d.data()))
    .filter(inWorkspace(workspaceId))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function getBoard(boardId: string): Promise<Board | null> {
  const docSnap = await getDoc(doc(db, "boards", boardId));
  if (!docSnap.exists()) return null;
  return mapBoard(docSnap.id, docSnap.data());
}

export async function updateBoard(
  boardId: string,
  data: Partial<Pick<Board, "title" | "adminId" | "backgroundTemplate">>
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function assignBoardAdmin(
  boardId: string,
  newAdminId: string
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), { adminId: newAdminId });
}

/** Deletes a board and all its subcollection documents (paths, notes, presence, textElements). */
export async function deleteBoard(boardId: string): Promise<void> {
  await Promise.all([
    deleteSubcollection(boardId, "paths"),
    deleteSubcollection(boardId, "notes"),
    deleteSubcollection(boardId, "presence"),
    deleteSubcollection(boardId, "textElements"),
    deleteSubcollection(boardId, "comments"),
  ]);
  await deleteDoc(doc(db, "boards", boardId));
}

/** Removes the current user from a board's members array without deleting the board. */
export async function leaveBoard(boardId: string): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("You must be signed in.");
  await updateDoc(doc(db, "boards", boardId), {
    members: arrayRemove(currentUser.uid),
    updatedAt: serverTimestamp(),
  });
}

export type JoinBoardResult = { boardId: string; alreadyMember: boolean };

/** Adds a user directly to a board by UID (no lookup needed). */
export async function addMemberById(boardId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), {
    members: arrayUnion(uid),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Sets an explicit per-board role override for `uid` (Phase 6). Gated by the board
 * `update` rule to the board admin/owner. The effective role is still floor-capped
 * by workspace membership at read time (see `effectiveBoardRole`); this only writes
 * the override the resolver consults.
 */
export async function setBoardRole(
  boardId: string,
  uid: string,
  role: BoardRole
): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), {
    [`roles.${uid}`]: role,
    updatedAt: serverTimestamp(),
  });
}

/** Clears a per-board role override so `uid` falls back to their workspace default. */
export async function removeBoardRole(boardId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), {
    [`roles.${uid}`]: deleteField(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Revokes a member's access to a board (Share & permissions modal). Removes them
 * from `members` and clears any per-board role override in one write.
 */
export async function removeMemberById(boardId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, "boards", boardId), {
    members: arrayRemove(uid),
    [`roles.${uid}`]: deleteField(),
    updatedAt: serverTimestamp(),
  });
}

export type AddByEmailResult = "added" | "not_found" | "already_member";

/** Looks up a user by email and adds them to the board. Returns the outcome. */
export async function addMemberByEmail(
  boardId: string,
  email: string
): Promise<{ result: AddByEmailResult; uid?: string }> {
  const q = query(collection(db, "users"), where("email", "==", email.toLowerCase().trim()));
  const snap = await getDocs(q);
  if (snap.empty) return { result: "not_found" };

  const uid = snap.docs[0].id;
  const boardSnap = await getDoc(doc(db, "boards", boardId));
  if (!boardSnap.exists()) throw new Error("Board not found");

  const members: string[] = boardSnap.data().members ?? [];
  if (members.includes(uid)) return { result: "already_member", uid };

  await updateDoc(doc(db, "boards", boardId), {
    members: arrayUnion(uid),
    updatedAt: serverTimestamp(),
  });
  return { result: "added", uid };
}

/**
 * Read-only lookup of a board by its invite code. Used by the `/b/{code}`
 * Universal/App Link landing route to resolve a code → board before routing the
 * viewer into the existing membership/join gate. Returns null when no board
 * matches, so the route can show a clean "invalid link" state.
 */
export async function getBoardByInviteCode(inputCode: string): Promise<Board | null> {
  const normalized = inputCode.trim().toUpperCase();
  const q = query(boardsRef, where("inviteCode", "==", normalized));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  return mapBoard(snapshot.docs[0].id, snapshot.docs[0].data());
}

export async function joinBoardByCode(inputCode: string): Promise<JoinBoardResult> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("You must be signed in to join a board.");
  }

  const normalized = inputCode.trim().toUpperCase();
  const q = query(boardsRef, where("inviteCode", "==", normalized));
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    throw new Error("No board found with that invite code. Please check and try again.");
  }

  const boardDoc = snapshot.docs[0];
  const members: string[] = boardDoc.data().members ?? [];

  if (members.includes(currentUser.uid)) {
    return { boardId: boardDoc.id, alreadyMember: true };
  }

  await updateDoc(boardDoc.ref, {
    members: arrayUnion(currentUser.uid),
    updatedAt: serverTimestamp(),
  });

  return { boardId: boardDoc.id, alreadyMember: false };
}
