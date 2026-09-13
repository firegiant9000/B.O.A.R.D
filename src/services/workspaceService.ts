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
    swatches: data.swatches ?? [],
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

/**
 * Creates a workspace. `plan` is effectively "free" from the client: since M5,
 * firestore.rules rejects a create that stamps any other value, and rejects any
 * update that touches `plan` at all — the Stripe webhook (Admin SDK, bypasses
 * rules) is the only writer after signup. The parameter is kept for the tests
 * that exercise the mapper, but passing "pro"/"edu" here will be denied. A paid
 * or edu workspace has to be provisioned server-side.
 */
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

// ── custom swatch palette (Month 5, ROADMAP items 12 + 14) ─────────────────

/** Upper bound on how many swatches `ColorPickerModal` lets a member add —
 *  enforced only by disabling the "add" control client-side once a
 *  workspace's `swatches` array reaches this length; `addWorkspaceSwatch`
 *  itself does not check it (see that function's own comment). */
export const MAX_WORKSPACE_SWATCHES = 24;

/** Adds `hex` to the workspace's shared swatch row (deduped via `arrayUnion`
 *  — Firestore treats the field as a set on write). Advisory Pro gate only:
 *  see `canUseCustomPalette` below for what that means and does not mean.
 *  Does not itself enforce `MAX_WORKSPACE_SWATCHES` — a caller past the cap
 *  would still succeed here; `ColorPickerModal` is what stops offering the
 *  control once the workspace's current `swatches.length` reaches it. */
export async function addWorkspaceSwatch(workspaceId: string, hex: string): Promise<void> {
  await updateDoc(doc(db, "workspaces", workspaceId), {
    swatches: arrayUnion(hex),
  });
}

/** Removes `hex` from the workspace's shared swatch row. Fix Wave F7 — this
 *  was exported with no caller anywhere in `src/`: a workspace that filled
 *  all `MAX_WORKSPACE_SWATCHES` slots had no in-app way to free one. Now
 *  called from `ColorPickerModal`'s existing workspace-swatch row via a
 *  long-press (see that component's `onRemoveSwatch` prop) — the smaller fix
 *  chosen over designing a new swatch-management surface, since the row
 *  already renders exactly the affordance removal needs.
 *
 *  Deliberately carries the SAME role gate as `addWorkspaceSwatch` above
 *  (`canManageWorkspace`/`MANAGER_ROLES`, enforced by firestore.rules'
 *  `workspaces/{id}` update rule) but NOT `canUseCustomPalette`'s plan gate:
 *  removing frees capacity rather than spending it, so a workspace that has
 *  since downgraded to free must still be able to tidy its existing
 *  swatches down to fit under the cap — gating removal behind Pro would trap
 *  a downgraded workspace at whatever count it happened to have. */
export async function removeWorkspaceSwatch(workspaceId: string, hex: string): Promise<void> {
  await updateDoc(doc(db, "workspaces", workspaceId), {
    swatches: arrayRemove(hex),
  });
}

// ── advisory Pro entitlement check ──────────────────────────────────────────
// ⚠️ ADVISORY ONLY — NOT AN ENFORCEMENT POINT. See quotaService.ts's module
// header for the full rationale behind that framing; this is the same thing
// for a boolean feature-gate instead of a countable quota — mirrors
// audioService.ts#canRecordVoiceNotes exactly, for a different Pro
// affordance (ROADMAP item 14's "custom palette" badge instead of item 9's
// voice notes).
//
// The per-workspace custom swatch palette is billed as a Pro-tier feature
// (ROADMAP item 12 / item 14). Nothing server-side enforces THAT today:
// firestore.rules' `workspaces/{id}` update rule denies a client touching
// `plan` at all, but has no predicate on `plan` for `swatches` specifically
// — any workspace OWNER OR ADMIN (that rule's existing role check, same as
// every field but `name`; see `MANAGER_ROLES` above) can call
// `addWorkspaceSwatch`/`removeWorkspaceSwatch` on a FREE-plan workspace
// right now, the same way a patched bundle or a raw SDK `updateDoc` call
// bypassing this module entirely could. Do not read this as "any member" —
// a plain (non-owner/admin) member's update is already rejected by that
// same rule for any field but `name`, `swatches` included; that part IS
// enforced (see `ColorPickerModal`'s `canManageWorkspace` prop, which
// exists for exactly that reason). What's unenforced is narrower: PLAN. This
// function exists solely so `ColorPickerModal` can show a "Pro" badge and
// route a free user to the upsell instead of silently accepting the write;
// it denies nothing a server would enforce.
//
// Closing this gap needs the same kind of change quotaService.ts's header
// describes for boards/sessions: a rules predicate on `plan` (or a
// callable). That is tracked separately (owned by a later task that already
// touches firestore.rules) — do not add a plan predicate to firestore.rules
// here, and do not treat this function as enforcement anywhere it's called.
export function canUseCustomPalette(plan: Plan): boolean {
  return plan !== "free";
}

// Fix Wave F2 — ROADMAP.md:615 names three Pro-only feature affordances:
// presenter, voice notes, custom palette. The other two were both gated in
// UI and service layer (`audioService.ts#canRecordVoiceNotes`,
// `canUseCustomPalette` immediately above); this predicate did not exist at
// all before this fix, so `BoardHeader.tsx`'s presenter toggle was reachable
// by every plan. Same advisory-only shape as `canUseCustomPalette`: nothing
// server-side enforces this. Presenting is a `presenting: true` flag on the
// presenter's own cursor doc (`useBoardCollab.ts#startPresenting`, written
// via `cursorService.publishCursor`), gated in firestore.rules' `cursors`
// match only by board membership and `isOwner(userId)` — no `plan`
// predicate. Adding one is explicitly out of scope for this fix wave
// (client-side gate only, per its own scope limit) — do not add it to
// firestore.rules as part of wiring this predicate in.
export function canUsePresenter(plan: Plan): boolean {
  return plan !== "free";
}
