import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { getClass, getClassBoards, type AssignmentBoardSummary } from "../../services/classroomService";
import { useAuth } from "../../hooks/useAuth";
import type { ClassRoom } from "../../types";

// Month 6 — instructor cohort grid (ROADMAP.md Appendix E.2 "Cohort
// views... see all student boards for an assignment in one grid"). All
// data-fetching and every access gate live HERE (or in classroomService),
// never in the bare `app/class/[id].tsx` route that renders this component
// — this task's R80 ruling: screens under app/ can't be render/import-
// tested in this Jest setup (expo-font is unresolvable via
// @expo/vector-icons, and @firebase/util ships ESM the transform doesn't
// handle), so logic belongs in this testable component layer instead.
//
// The REAL access gate is firestore.rules' `isInstructorOfClass` predicate
// on the board `read` rule (see that file) — a non-instructor calling
// `getClassBoards` simply gets back only the boards they already have
// access to (never the whole cohort), so the `isInstructor` check below is
// an advisory "not your class" affordance, not enforcement.

export interface InstructorCohortGridProps {
  classId: string;
}

export default function InstructorCohortGrid({ classId }: InstructorCohortGridProps) {
  const { user } = useAuth();
  const router = useRouter();
  const [klass, setKlass] = useState<ClassRoom | null>(null);
  const [boards, setBoards] = useState<AssignmentBoardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, b] = await Promise.all([getClass(classId), getClassBoards(classId)]);
      setKlass(c);
      setBoards(b);
    } catch {
      setError("Couldn't load this class's boards.");
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center} testID="cohort-grid-loading">
        <ActivityIndicator color="#2563eb" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center} testID="cohort-grid-error">
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  // Advisory-only affordance — see the module header above for why
  // firestore.rules, not this check, is the real gate. A non-instructor
  // viewing this component either gets `klass === null` (no read access to
  // the class doc at all) or a mismatched instructorId; either way, show
  // an explicit "not yours" state instead of a half-empty grid.
  const isInstructor = !!user && !!klass && klass.instructorId === user.uid;
  if (!klass || !isInstructor) {
    return (
      <View style={styles.center} testID="cohort-grid-forbidden">
        <Text style={styles.emptyTitle}>Not available</Text>
        <Text style={styles.emptyText}>
          This cohort view is only visible to the class&apos;s instructor.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="cohort-grid">
      <Text style={styles.title}>{klass.name}</Text>
      <Text style={styles.subtitle}>
        {boards.length} {boards.length === 1 ? "submission" : "submissions"}
      </Text>
      <FlatList
        testID="cohort-grid-list"
        data={boards}
        keyExtractor={(b) => b.id}
        numColumns={2}
        contentContainerStyle={styles.grid}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No student boards submitted yet.</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            testID={`cohort-board-${item.id}`}
            style={styles.card}
            onPress={() => router.push(`/board/${item.id}`)}
          >
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.cardMeta}>{item.updatedAt.toLocaleDateString()}</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", padding: 16 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  title: { fontSize: 20, fontWeight: "700", color: "#111827" },
  subtitle: { fontSize: 13, color: "#6b7280", marginTop: 4, marginBottom: 16 },
  grid: { gap: 12 },
  card: {
    flex: 1,
    margin: 6,
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 14,
    minHeight: 80,
  },
  cardTitle: { fontSize: 14, fontWeight: "600", color: "#111827" },
  cardMeta: { fontSize: 11, color: "#9ca3af", marginTop: 6 },
  errorText: { fontSize: 13, color: "#b91c1c" },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: "#374151" },
  emptyText: { fontSize: 13, color: "#9ca3af", textAlign: "center" },
});
