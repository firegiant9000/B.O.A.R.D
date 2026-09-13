import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../hooks/useAuth";
import * as classroomService from "../../services/classroomService";
import type { ClassRoom } from "../../types";

// Month 6 — education pilot entry point (ROADMAP.md "Education pilot —
// reshaped" + Appendix E.2). Fix round 1, I1 — this component (and its bare
// route, app/classes.tsx) is what makes `createClass`/`enrollInClass`
// actually reachable: before this fix round nothing in the app called
// either one. Every gate and every bit of data-fetching/business logic
// lives HERE, never in the screen that renders this — same reasoning as
// InstructorCohortGrid's own header.
//
// Two independent flows, since a signed-in user can be an instructor, a
// student, or both: "Teaching" (create a class, see the classes you teach,
// manage each roster) and "Enrolled" (redeem a join code, see the classes
// you're a student in). Nothing here enforces anything — firestore.rules
// and the `createClass` Cloud Function are the real gates, exactly as
// classroomService's own header says.

interface RosterState {
  classId: string;
  loading: boolean;
  removingUid: string | null;
}

export default function ClassroomHome() {
  const { user } = useAuth();
  const router = useRouter();

  const [teaching, setTeaching] = useState<ClassRoom[]>([]);
  const [enrolled, setEnrolled] = useState<ClassRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newClassName, setNewClassName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinSuccess, setJoinSuccess] = useState(false);

  const [openRosterClassId, setOpenRosterClassId] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterState | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [t, e] = await Promise.all([
        classroomService.getInstructorClasses(user.uid),
        classroomService.getEnrolledClasses(user.uid),
      ]);
      setTeaching(t);
      setEnrolled(e);
    } catch {
      setLoadError("Couldn't load your classes. Pull to refresh, or try again.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    const name = newClassName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    setCreatedCode(null);
    try {
      const { classId, joinCode: code } = await classroomService.createClass(name);
      setNewClassName("");
      setCreatedCode(code);
      setTeaching((prev) => [
        ...prev,
        { id: classId, name, instructorId: user?.uid ?? "", joinCode: code, studentIds: [], schemaVersion: 1, createdAt: new Date() },
      ]);
    } catch (e: any) {
      setCreateError(e?.message ?? "Couldn't create the class. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    const code = joinCode.trim();
    if (!code || joining) return;
    setJoining(true);
    setJoinError(null);
    setJoinSuccess(false);
    try {
      await classroomService.enrollInClass(code);
      setJoinCode("");
      setJoinSuccess(true);
      const list = await classroomService.getEnrolledClasses(user!.uid);
      setEnrolled(list);
    } catch (e: any) {
      setJoinError(e?.message ?? "Couldn't join that class. Please try again.");
    } finally {
      setJoining(false);
    }
  };

  // Fix round 3, B — rosterError previously reset only at the top of
  // handleRemoveStudent, so failing a removal on one class, closing its
  // roster, and opening a DIFFERENT class's roster showed that class the
  // first one's stale error. Cleared here too, on every toggle.
  const toggleRoster = (classId: string) => {
    setOpenRosterClassId((prev) => (prev === classId ? null : classId));
    setRosterError(null);
  };

  // Fix round 2, S2 — this was `try { … } finally { … }` with no `catch`,
  // called from a floating `onPress`: any rejection (e.g. a stale roster
  // racing another device's removal, or a genuine network failure) was an
  // unhandled promise rejection and a silent dead end — the student stayed
  // in the list with no explanation. A stale "already gone" removal DOES
  // still succeed as a no-op — not through any dedicated removal rule (there
  // isn't one in firestore.rules), but redundantly via two OTHER arms of
  // firestore.rules' `classes` update rule (see that file's own removal-arm
  // comment, and `classroomService.ts#removeStudentFromClass`'s comment, for
  // exactly which). But a `catch` is still needed for every genuine failure
  // this can hit (permission denial, network error).
  const handleRemoveStudent = async (classId: string, uid: string) => {
    setRoster({ classId, loading: false, removingUid: uid });
    setRosterError(null);
    try {
      await classroomService.removeStudentFromClass(classId, uid);
      setTeaching((prev) =>
        prev.map((c) => (c.id === classId ? { ...c, studentIds: c.studentIds.filter((s) => s !== uid) } : c))
      );
    } catch (e: any) {
      setRosterError(e?.message ?? "Couldn't remove that student. Please try again.");
    } finally {
      setRoster(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.center} testID="classroom-home-loading">
        <ActivityIndicator color="#2563eb" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} testID="classroom-home" contentContainerStyle={styles.content}>
      <Text style={styles.header}>Classes</Text>
      <Text style={styles.subheader}>Education pilot — university courses only.</Text>

      {loadError && <Text style={styles.errorText}>{loadError}</Text>}

      {/* ── Teaching ── */}
      <Text style={styles.sectionTitle}>Teaching</Text>
      {teaching.map((klass) => (
        <View key={klass.id} style={styles.classCard}>
          <TouchableOpacity
            testID={`teaching-class-${klass.id}`}
            onPress={() => router.push(`/class/${klass.id}`)}
          >
            <Text style={styles.className}>{klass.name}</Text>
            <Text style={styles.classMeta}>
              Join code: {klass.joinCode} · {klass.studentIds.length}{" "}
              {klass.studentIds.length === 1 ? "student" : "students"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`toggle-roster-${klass.id}`}
            style={styles.rosterToggle}
            onPress={() => toggleRoster(klass.id)}
          >
            <Text style={styles.rosterToggleText}>
              {openRosterClassId === klass.id ? "Hide roster" : "Manage roster"}
            </Text>
          </TouchableOpacity>
          {openRosterClassId === klass.id && (
            <View testID={`roster-${klass.id}`}>
              {rosterError && <Text style={styles.errorText}>{rosterError}</Text>}
              {klass.studentIds.length === 0 ? (
                <Text style={styles.emptyText}>No students enrolled yet.</Text>
              ) : (
                // Fix round 2, N3 — deliberately raw uids, not resolved
                // display names/emails. Resolving names means reading
                // other users' profile documents from this instructor-only
                // screen, which is more PII surface in the exact feature
                // this whole pilot was reshaped to minimize (see this
                // component's own header). The tradeoff is a harder-to-use
                // roster; accepted rather than grown.
                klass.studentIds.map((uid) => (
                  <View key={uid} style={styles.rosterRow}>
                    <Text style={styles.rosterUid} numberOfLines={1}>{uid}</Text>
                    {roster?.classId === klass.id && roster.removingUid === uid ? (
                      <ActivityIndicator size="small" color="#ef4444" />
                    ) : (
                      <TouchableOpacity
                        testID={`remove-student-${klass.id}-${uid}`}
                        onPress={() => handleRemoveStudent(klass.id, uid)}
                      >
                        <Text style={styles.removeText}>Remove</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))
              )}
            </View>
          )}
        </View>
      ))}

      <View style={styles.formRow}>
        <TextInput
          testID="create-class-input"
          style={styles.input}
          placeholder="New class name (e.g. CS 101)"
          value={newClassName}
          onChangeText={setNewClassName}
        />
        <TouchableOpacity
          testID="create-class-button"
          style={[styles.button, (!newClassName.trim() || creating) && styles.buttonDisabled]}
          onPress={handleCreate}
          disabled={!newClassName.trim() || creating}
        >
          {creating ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.buttonText}>Create</Text>}
        </TouchableOpacity>
      </View>
      {createError && <Text style={styles.errorText}>{createError}</Text>}
      {createdCode && (
        <Text testID="created-class-code" style={styles.successText}>
          Class created. Share this join code with your students: {createdCode}
        </Text>
      )}

      {/* ── Enrolled ── */}
      <Text style={styles.sectionTitle}>Enrolled</Text>
      {enrolled.length === 0 ? (
        <Text style={styles.emptyText}>You're not enrolled in any class yet.</Text>
      ) : (
        enrolled.map((klass) => (
          <View key={klass.id} style={styles.classCard} testID={`enrolled-class-${klass.id}`}>
            <Text style={styles.className}>{klass.name}</Text>
          </View>
        ))
      )}

      <View style={styles.formRow}>
        <TextInput
          testID="join-code-input"
          style={styles.input}
          placeholder="Join code"
          autoCapitalize="characters"
          value={joinCode}
          onChangeText={setJoinCode}
        />
        <TouchableOpacity
          testID="join-class-button"
          style={[styles.button, (!joinCode.trim() || joining) && styles.buttonDisabled]}
          onPress={handleJoin}
          disabled={!joinCode.trim() || joining}
        >
          {joining ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.buttonText}>Join</Text>}
        </TouchableOpacity>
      </View>
      {joinError && <Text style={styles.errorText}>{joinError}</Text>}
      {joinSuccess && <Text style={styles.successText}>Joined!</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 60 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { fontSize: 22, fontWeight: "700", color: "#111827" },
  subheader: { fontSize: 13, color: "#6b7280", marginTop: 4, marginBottom: 16 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
  },
  classCard: {
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  className: { fontSize: 15, fontWeight: "600", color: "#111827" },
  classMeta: { fontSize: 12, color: "#6b7280", marginTop: 4 },
  rosterToggle: { marginTop: 8 },
  rosterToggleText: { fontSize: 12, fontWeight: "600", color: "#2563eb" },
  rosterRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5e7eb",
  },
  rosterUid: { fontSize: 12, color: "#374151", flex: 1, marginRight: 8 },
  removeText: { fontSize: 12, fontWeight: "600", color: "#ef4444" },
  formRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  input: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
    backgroundColor: "#f9fafb",
    color: "#111",
  },
  button: {
    paddingHorizontal: 18,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 10,
    backgroundColor: "#2563eb",
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  errorText: { fontSize: 12, color: "#ef4444", marginTop: 6 },
  successText: { fontSize: 12, color: "#16a34a", marginTop: 6 },
  emptyText: { fontSize: 13, color: "#9ca3af", marginBottom: 8 },
});
