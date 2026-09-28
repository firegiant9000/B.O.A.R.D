import { useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../hooks/useAuth";
import { useWorkspace } from "../hooks/useWorkspace";
import { track } from "../services/analyticsService";
import {
  createWorkspace,
  getWorkspaceRole,
  canManageMembers,
} from "../services/workspaceService";
import CreateWorkspaceModal from "./CreateWorkspaceModal";
import InviteMemberModal from "./InviteMemberModal";
import UpsellModal from "./UpsellModal";
import { useUpsellCadence } from "../hooks/useUpsellCadence";
import type { Plan } from "../types";

/**
 * Phase 3 workspace switcher. Sits in the Boards header as the title. The active
 * workspace is reachable-to-switch in two taps (tap to open the dropdown, tap a
 * row to switch) per the mobile-parity gate.
 */
export default function WorkspaceSwitcher() {
  const { user } = useAuth();
  const {
    workspaces,
    activeWorkspace,
    setActiveWorkspace,
    refreshWorkspaces,
  } = useWorkspace();

  const [open, setOpen] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [inviteVisible, setInviteVisible] = useState(false);

  // The workspace cap's upsell. Routed through `useUpsellCadence` — not a bare
  // `useState` — because the cadence is the whole point of the change: this was
  // the only one of the five enforced gates whose denial never reached
  // `UpsellModal`, so it was also the only one that gave a user's first
  // encounter the full sell (ROADMAP.md:608, item 14 requires restraint there).
  // Every screen that can surface a plan denial now calls this hook; nothing
  // about it is board-specific, and it takes the uid rather than reading auth
  // itself.
  const upsell = useUpsellCadence(user?.uid);

  // THE WORKSPACE CAP IS RESOLVED OVER OWNED WORKSPACES, NOT THE ACTIVE ONE.
  //
  // This modal used to be handed `activeWorkspace`'s plan and id, and both were
  // the wrong workspace. The server decides this cap from the workspaces the
  // caller OWNS — `countOwnedWorkspaces` then `resolveOwnerPlan`, in
  // functions/src/callable/createWorkspace.ts — while `useWorkspace().
  // workspaces` is every workspace the user is a MEMBER of (see
  // `workspaceService.getUserWorkspaces`, and `quotaService.ts`'s own note on
  // the distinction). Those differ in practice, and both failures were live:
  //
  //  - A user who owns one free workspace while a colleague's Pro workspace is
  //    active is denied by the server, then asked `isPlanCapped("pro",
  //    "workspace")` — false — and shown the TRANSIENT-THROTTLE copy ("You're
  //    sending requests a little fast") for a permanent cap, with no upgrade
  //    path at all.
  //  - If the active workspace is one they do not own, `workspaceId` points
  //    checkout at a workspace they have no authority to upgrade.
  //
  // Derived here the same way the server derives it, rather than omitted (the
  // other defensible option: "free" is correct for every denial that can
  // actually occur, since a denial implies the owned plan is free). Deriving is
  // chosen because it keeps the client and the server agreeing BY
  // CONSTRUCTION — if `workspaces` ever becomes finite on a paid plan, the
  // hardcoded "free" would start lying and this will not.
  //
  // Not shared with `resolveOwnerPlan` itself: that lives in the functions
  // package, which the app does not import. It is mirrored, like
  // `lib/planLimits.ts` mirrors `functions/src/billing/limits.ts`, with the
  // same pro-before-edu ordering so a future finite `workspaces` number
  // resolves deterministically instead of by array order.
  const ownedWorkspaces = useMemo(
    () => (user ? workspaces.filter((w) => w.ownerId === user.uid) : []),
    [workspaces, user]
  );
  const ownedPlan: Plan = useMemo(() => {
    const plans = ownedWorkspaces.map((w) => w.plan);
    if (plans.includes("pro")) return "pro";
    if (plans.includes("edu")) return "edu";
    return "free";
  }, [ownedWorkspaces]);
  // Oldest-first (`getUserWorkspaces` sorts that way, personal workspace
  // leading), so this is deterministic. Any owned workspace is a valid checkout
  // target for this gate: a workspace-cap denial can only happen when every
  // workspace the user owns is free, because pro/edu are UNLIMITED on this row.
  const ownedWorkspaceId = ownedWorkspaces[0]?.id;

  const canInvite =
    !!user &&
    !!activeWorkspace &&
    canManageMembers(getWorkspaceRole(activeWorkspace, user.uid));

  const handleSelect = (id: string) => {
    setActiveWorkspace(id);
    setOpen(false);
  };

  const handleCreate = async (name: string) => {
    if (!user) throw new Error("You must be signed in.");
    const id = await createWorkspace(name, user.uid);
    // Month 6 — ROADMAP.md:685's `workspace_created`. Emitted HERE, at the
    // "Create workspace" action a person actually pressed, and deliberately
    // NOT inside `workspaceService.createWorkspace`: signup auto-creates a
    // personal workspace through `authService.ensureUserProvisioned` ->
    // `ensurePersonalWorkspace` -> `createWorkspace`, and
    // `WorkspaceContext.load` calls `ensurePersonalWorkspace` again as a lazy
    // repair when that write lagged. A workspace the system made for you is
    // not a workspace you created, so an emit in the service would make this
    // metric report signups a second time under a different name. The
    // boundary is enforced, not just described — see
    // src/services/__tests__/analyticsBoundary.test.ts.
    //
    // After the await, so a workspace that failed to be created is never
    // reported as one. No name, no id, no uid: the name is free text the user
    // just typed and the ids are exactly what analyticsService's Global
    // Constraint forbids, which leaves nothing worth sending — the event is
    // the whole signal.
    track("workspace_created");
    return id;
  };

  const handleCreated = async (id: string) => {
    setCreateVisible(false);
    await refreshWorkspaces();
    setActiveWorkspace(id);
    setOpen(false);
  };

  return (
    <>
      <TouchableOpacity
        style={styles.trigger}
        onPress={() => setOpen(true)}
        hitSlop={8}
        activeOpacity={0.7}
      >
        <Ionicons name="people-circle-outline" size={20} color="#2563eb" />
        <Text style={styles.triggerText} numberOfLines={1}>
          {activeWorkspace?.name ?? "Boards"}
        </Text>
        <Ionicons name="chevron-down" size={16} color="#2563eb" />
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
        <View style={styles.dropdownWrap} pointerEvents="box-none">
          <View style={styles.dropdown}>
            <Text style={styles.dropdownHeading}>Workspaces</Text>
            <ScrollView style={styles.list} bounces={false}>
              {workspaces.map((ws) => {
                const active = ws.id === activeWorkspace?.id;
                return (
                  <TouchableOpacity
                    key={ws.id}
                    style={styles.row}
                    onPress={() => handleSelect(ws.id)}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={active ? "checkmark-circle" : "ellipse-outline"}
                      size={20}
                      color={active ? "#2563eb" : "#cbd5e1"}
                    />
                    <Text
                      style={[styles.rowText, active && styles.rowTextActive]}
                      numberOfLines={1}
                    >
                      {ws.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={styles.divider} />

            {canInvite && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => {
                  setOpen(false);
                  setInviteVisible(true);
                }}
                activeOpacity={0.7}
              >
                <Ionicons name="person-add-outline" size={18} color="#2563eb" />
                <Text style={styles.actionText}>Invite members</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => {
                setOpen(false);
                setCreateVisible(true);
              }}
              activeOpacity={0.7}
            >
              <Ionicons name="add-circle-outline" size={18} color="#2563eb" />
              <Text style={styles.actionText}>Create workspace</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <CreateWorkspaceModal
        visible={createVisible}
        onClose={() => setCreateVisible(false)}
        onCreate={handleCreate}
        onCreated={handleCreated}
        onQuotaDenied={() => {
          // Close the composer before showing the upsell, the same ordering
          // `app/(tabs)/index.tsx` uses for the board cap: two stacked RN
          // `<Modal>`s would leave the user dismissing the sell only to find
          // the form they were just denied on still open behind it.
          setCreateVisible(false);
          upsell.show("workspace");
        }}
      />

      {upsell.resource && (
        <UpsellModal
          visible
          resource={upsell.resource}
          variant={upsell.variant}
          plan={ownedPlan}
          workspaceId={ownedWorkspaceId}
          onDismiss={upsell.dismiss}
        />
      )}

      {activeWorkspace && (
        <InviteMemberModal
          visible={inviteVisible}
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
          onClose={() => setInviteVisible(false)}
          onInvited={refreshWorkspaces}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 220,
  },
  triggerText: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111",
    flexShrink: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  dropdownWrap: {
    flex: 1,
    alignItems: "center",
    paddingTop: 8,
  },
  dropdown: {
    width: "92%",
    maxWidth: 420,
    backgroundColor: "#fff",
    borderRadius: 14,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 10,
  },
  dropdownHeading: {
    fontSize: 12,
    fontWeight: "700",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  list: { maxHeight: 280 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowText: { fontSize: 15, color: "#334155", flex: 1 },
  rowTextActive: { color: "#111", fontWeight: "700" },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#e5e7eb",
    marginVertical: 4,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  actionText: { fontSize: 15, fontWeight: "600", color: "#2563eb" },
});
