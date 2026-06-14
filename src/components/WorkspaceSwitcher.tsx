import { useState } from "react";
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
import {
  createWorkspace,
  getWorkspaceRole,
  canManageMembers,
} from "../services/workspaceService";
import CreateWorkspaceModal from "./CreateWorkspaceModal";
import InviteMemberModal from "./InviteMemberModal";

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
    return createWorkspace(name, user.uid);
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
      />

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
