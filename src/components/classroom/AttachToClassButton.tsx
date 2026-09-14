import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { useAuth } from "../../hooks/useAuth";
import * as boardService from "../../services/boardService";
import * as classroomService from "../../services/classroomService";
import type { ClassRoom } from "../../types";

// Month 6 — education pilot (Appendix E.2 "Cohort views"). Fix round 1, I1
// — the reachable UI for `classroomService.attachBoardToClass`/
// `clearBoardClass`; before this fix round nothing in the app called
// either one, so a board could never actually be submitted to a class.
// Mounted inside ShareBoardModal (already the board's "who can see this /
// get this out of the app" surface) rather than threaded through the
// board screen/header as a new modal of its own — it needs nothing that
// modal doesn't already receive as props.
//
// All logic lives here, never in a screen. Every gate below is advisory —
// firestore.rules' `classIdTransitionValid` is the real enforcement (see
// classroomService.attachBoardToClass/clearBoardClass's own headers).

export interface AttachToClassButtonProps {
  boardId: string;
  /** Only the board admin decides to submit/detach a board — mirrors the
   *  board `update` rule's admin arm, the only one `classIdTransitionValid`
   *  composes with for a first-time attach. */
  isAdmin: boolean;
}

export default function AttachToClassButton({ boardId, isAdmin }: AttachToClassButtonProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [classId, setClassId] = useState<string | undefined>(undefined);
  const [attachedClass, setAttachedClass] = useState<ClassRoom | null>(null);
  // True when the board carries a classId whose class doc no longer
  // exists (the instructor deleted it) — the one case
  // classIdTransitionValid lets a board admin clear.
  const [classDeleted, setClassDeleted] = useState(false);
  const [enrolledClasses, setEnrolledClasses] = useState<ClassRoom[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Non-admins render nothing (see the bottom of this component) — skip
    // the fetch entirely rather than doing work whose result is never shown.
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const board = await boardService.getBoard(boardId);
      const currentClassId = board?.classId;
      setClassId(currentClassId);

      if (currentClassId) {
        const klass = await classroomService.getClass(currentClassId);
        setAttachedClass(klass);
        setClassDeleted(!klass);
        setEnrolledClasses([]);
      } else {
        setAttachedClass(null);
        setClassDeleted(false);
        setEnrolledClasses(user ? await classroomService.getEnrolledClasses(user.uid) : []);
      }
    } catch {
      setError("Couldn't load class info for this board.");
    } finally {
      setLoading(false);
    }
  }, [boardId, user, isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAttach = async (targetClassId: string) => {
    setBusy(true);
    setError(null);
    try {
      await classroomService.attachBoardToClass(boardId, targetClassId);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Couldn't submit this board to that class.");
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    setError(null);
    try {
      await classroomService.clearBoardClass(boardId);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Couldn't clear this board's class link.");
    } finally {
      setBusy(false);
    }
  };

  if (!isAdmin) return null;

  if (loading) {
    return (
      <View testID="attach-to-class-loading" style={styles.row}>
        <ActivityIndicator size="small" color="#2563eb" />
      </View>
    );
  }

  return (
    <View testID="attach-to-class" style={styles.container}>
      <Text style={styles.label}>Class Assignment</Text>

      {error && <Text style={styles.errorText}>{error}</Text>}

      {classId && attachedClass && (
        <View testID="attach-to-class-attached" style={styles.badge}>
          <Text style={styles.badgeText}>Submitted to {attachedClass.name}</Text>
          <Text style={styles.hint}>This can't be changed once submitted.</Text>
        </View>
      )}

      {classId && classDeleted && (
        <View testID="attach-to-class-deleted" style={styles.badge}>
          <Text style={styles.badgeText}>This class was deleted.</Text>
          <TouchableOpacity
            testID="attach-to-class-clear"
            style={styles.clearBtn}
            onPress={handleClear}
            disabled={busy}
          >
            {busy ? <ActivityIndicator size="small" color="#2563eb" /> : <Text style={styles.clearBtnText}>Clear</Text>}
          </TouchableOpacity>
        </View>
      )}

      {!classId &&
        (enrolledClasses.length === 0 ? (
          <Text testID="attach-to-class-none" style={styles.hint}>
            Join a class from the Classes tab to submit this board as an assignment.
          </Text>
        ) : (
          enrolledClasses.map((klass) => (
            <TouchableOpacity
              key={klass.id}
              testID={`attach-to-class-option-${klass.id}`}
              style={styles.option}
              onPress={() => handleAttach(klass.id)}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#2563eb" />
              ) : (
                <Text style={styles.optionText}>Submit to {klass.name}</Text>
              )}
            </TouchableOpacity>
          ))
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 16 },
  row: { paddingVertical: 8 },
  label: { fontSize: 13, fontWeight: "600", color: "#444", marginBottom: 6 },
  badge: {
    backgroundColor: "#eff6ff",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#bfdbfe",
  },
  badgeText: { fontSize: 13, fontWeight: "600", color: "#1d4ed8" },
  hint: { fontSize: 12, color: "#9ca3af", marginTop: 4 },
  clearBtn: { marginTop: 8, alignSelf: "flex-start" },
  clearBtnText: { fontSize: 13, fontWeight: "600", color: "#2563eb" },
  option: {
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    marginBottom: 6,
  },
  optionText: { fontSize: 13, fontWeight: "600", color: "#111827" },
  errorText: { fontSize: 12, color: "#ef4444", marginBottom: 6 },
});
