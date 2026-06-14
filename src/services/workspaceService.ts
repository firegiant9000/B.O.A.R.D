import {
  collection,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  doc,
  query,
  where,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  deleteField,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { Plan, Workspace, WorkspaceRole } from "../types";

const workspacesRef = collection(db, "workspaces");

// Roles that may manage membership (add/remove members, change roles). Mirrored by
// the workspace update rule in firestore.rules — keep the two in sync.
const MANAGER_ROLES: WorkspaceRole[] = ["owner", "admin"];

function mapWorkspace(id: string, data: Record<string, any>): Workspace {
  return {
    id,
    name: data.name ?? "Untitled",
    ownerId: data.ownerId ?? "",
    members: data.members ?? {},
    plan: data.plan ?? "free",
    createdAt: data.createdAt?.toDate() ?? new Date(),
  };
}

// ── role helpers ────────────────────────────────────────────────────────────

/** The caller's role in the workspace, or undefined if they are not a member. */
export function getWorkspaceRole(
  workspace: Pick<Workspace, "members">,
  uid: string
): WorkspaceRole | undefined {
  return workspace.members[uid];
}

export function isWorkspaceMember(
  workspace: Pick<Workspace, "members">,
  uid: string
): boolean {
  return uid in workspace.members;
}

/** Whether `role` may add/remove members and change other members' roles. */
export function canManageMembers(role: WorkspaceRole | undefined): boolean {
  return role !== undefined && MANAGER_ROLES.includes(role);
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function createWorkspace(
  name: string,
  ownerId: string,
  plan: Plan = "free"
): Promise<string> {
  const docRef = await addDoc(workspacesRef, {
    name,
    ownerId,
    members: { [ownerId]: "owner" satisfies WorkspaceRole },
    // Parallel array for `array-contains` membership queries (see Workspace type).
    memberIds: [ownerId],
    plan,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function getWorkspace(workspaceId: string): Promise<Workspace | null> {
  const snap = await getDoc(doc(db, "workspaces", workspaceId));
  if (!snap.exists()) return null;
  return mapWorkspace(snap.id, snap.data());
}

/** All workspaces the user belongs to, oldest-first (personal workspace leads). */
export async function getUserWorkspaces(userId: string): Promise<Workspace[]> {
  const q = query(workspacesRef, where("memberIds", "array-contains", userId));
  const snapshot = await getDocs(q);
  return snapshot.docs
    .map((d) => mapWorkspace(d.id, d.data()))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * Resolves the user's personal (default) workspace id, creating one if the
 * signup auto-create lagged or failed — `authService.signUp` swallows that write
 * by design and defers reconciliation to first load. Returns the oldest
 * workspace (the personal one leads, per `getUserWorkspaces`).
 *
 * Phase 2 bridge: until the Phase 3 workspace switcher/context lands, board
 * reads/writes scope to this single personal workspace.
 */
export async function ensurePersonalWorkspace(uid: string): Promise<string> {
  const existing = await getUserWorkspaces(uid);
  if (existing.length > 0) return existing[0].id;
  return createWorkspace("Personal", uid);
}

export async function addMember(
  workspaceId: string,
  uid: string,
  role: WorkspaceRole = "member"
): Promise<void> {
  await updateDoc(doc(db, "workspaces", workspaceId), {
    [`members.${uid}`]: role,
    memberIds: arrayUnion(uid),
  });
}

export async function updateMemberRole(
  workspaceId: string,
  uid: string,
  role: WorkspaceRole
): Promise<void> {
  await updateDoc(doc(db, "workspaces", workspaceId), {
    [`members.${uid}`]: role,
  });
}

export async function removeMember(
  workspaceId: string,
  uid: string
): Promise<void> {
  await updateDoc(doc(db, "workspaces", workspaceId), {
    [`members.${uid}`]: deleteField(),
    memberIds: arrayRemove(uid),
  });
}

export type AddByEmailResult = "added" | "not_found" | "already_member";

/**
 * Invites a member by email (Phase 3). Looks up the user by email and adds them
 * to the workspace at `role`. Mirrors `boardService.addMemberByEmail`. The write
 * is gated by the workspace `update` rule to owner/admin, so call sites must
 * restrict the action to managers (see `canManageMembers`).
 */
export async function addMemberByEmail(
  workspaceId: string,
  email: string,
  role: WorkspaceRole = "member"
): Promise<{ result: AddByEmailResult; uid?: string }> {
  const q = query(
    collection(db, "users"),
    where("email", "==", email.toLowerCase().trim())
  );
  const snap = await getDocs(q);
  if (snap.empty) return { result: "not_found" };

  const uid = snap.docs[0].id;
  const wsSnap = await getDoc(doc(db, "workspaces", workspaceId));
  if (!wsSnap.exists()) throw new Error("Workspace not found");

  const members: Record<string, WorkspaceRole> = wsSnap.data().members ?? {};
  if (uid in members) return { result: "already_member", uid };

  await updateDoc(doc(db, "workspaces", workspaceId), {
    [`members.${uid}`]: role,
    memberIds: arrayUnion(uid),
  });
  return { result: "added", uid };
}
