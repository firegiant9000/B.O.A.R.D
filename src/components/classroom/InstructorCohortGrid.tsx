import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { getClass, getClassBoards, type AssignmentBoardSummary } from "../../services/classroomService";
import { useAuth } from "../../hooks/useAuth";
import type { ClassRoom } from "../../types";

// Month 6 — instructor cohort grid (ROADMAP.md Appendix E.2 "Cohort
// views... see all student boards for an assignment in one grid"). All
// data-fetching and every access gate live HERE (or in classroomService),
// never in the bare `app/class/[id].tsx` route that renders this component:
// screens under app/ can't be render/import-tested in this Jest setup
// (expo-font is unresolvable via @expo/vector-icons, and @firebase/util
// ships ESM the transform doesn't handle), so logic belongs in this
// testable component layer instead.
//
// The REAL access gate is firestore.rules' `isInstructorOfClass` predicate
// on the board `read` rule (see that file). Fix round 1, I2 — an earlier
// version of this comment (and of `classroomService.getClassBoards`'s own
// header) claimed a non-instructor's `getClassBoards` query "gets back only
// the boards they already have access to." Verified on the emulator: that's
// wrong. A `classId==` list query is a get()-gated predicate, not a bare
// field comparison Firestore can prove safe from the query's own filter, so
// firestore.rules REJECTS the entire query outright (permission-denied) for
// anyone who isn't that class's instructor — it does not silently filter to
// a subset. So `getClassBoards` below is called ONLY after `getClass` has
// already established (via a read firestore.rules DID allow) that the
// signed-in caller is this class's instructor; a non-instructor never
// reaches that call at all, and `error` is reserved for a genuine failure
// (e.g. a network blip) hitting the instructor's own request.

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

    let c: ClassRoom | null;
    try {
      c = await getClass(classId);
    } catch {
      // Denied by firestore.rules (not this class's instructor or an
      // enrolled student) — treated as "not accessible", the same as a
      // class that doesn't exist, never as a hard error.
      c = null;
    }
    setKlass(c);

    const isInstructor = !!user && !!c && c.instructorId === user.uid;
    if (!isInstructor) {
      setBoards([]);
      setLoading(false);
      return;
    }

    try {
      setBoards(await getClassBoards(classId));
    } catch {
      setError("Couldn't load this class's boards.");
    } finally {
      setLoading(false);
    }
  }, [classId, user]);

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

  // Recomputed from the same rules-confirmed read `load()` used to decide
  // whether to call `getClassBoards` at all (see the module header) — a
  // non-instructor viewing this component gets `klass === null` (the read
  // was denied) or a mismatched instructorId; either way, an explicit "not
  // yours" state instead of a half-empty grid.
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
