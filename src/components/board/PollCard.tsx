import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PollElement } from "../../types";
import type { PollResults } from "../../hooks/useBoardPolls";

// Month 6 — polls, quiz sequencing and dot voting. Renders at the poll's own
// persisted board-space (x, y) — UNLIKE ReactionBadge/AudioAffordance, there
// is no live-element-geometry join here (a poll isn't anchored to anything;
// see PollElement's type comment), so the caller (BoardOverlayLayer) can
// place this directly with plain `left`/`top`, same counter-scale technique
// as every other overlay badge.

const BASE_WIDTH = 220;

export interface PollCardProps {
  poll: PollElement;
  /** From useBoardPolls.resultsFor — null before any result is available
   *  (an anonymous poll with no tally written yet). */
  results: PollResults | null;
  /** The viewer's own current selection (useBoardPolls.myVoteFor). */
  myVote: number[];
  /** Commenter+ — mirrors firestore.rules' votes boundary. A viewer sees the
   *  poll but cannot tap an option. */
  canVote: boolean;
  /** Effective editor — mirrors firestore.rules' polls boundary. Gates
   *  delete and (for a quiz question) advancing to the next question. */
  canManage: boolean;
  onVote: (optionIndex: number) => void;
  onToggleDot: (optionIndex: number) => void;
  onDelete: () => void;
  /** Present only for a quiz question with more questions after it; omit to
   *  hide the "Next question" control entirely (mirrors ReactionBadge's
   *  optional-affordance convention). */
  onAdvanceQuiz?: () => void;
  /** Counter-scale factor (`1 / viewport.scale`), same technique every other
   *  overlay badge in this app uses so the card holds a constant on-screen
   *  size through zoom. Defaults to 1. */
  scale?: number;
}

export default function PollCard({
  poll,
  results,
  myVote,
  canVote,
  canManage,
  onVote,
  onToggleDot,
  onDelete,
  onAdvanceQuiz,
  scale = 1,
}: PollCardProps) {
  const isDots = poll.mode === "dots";
  const totalVotes = results?.totalVotes ?? 0;

  return (
    <View
      testID={`poll-card-${poll.id}`}
      style={[styles.card, { width: BASE_WIDTH * scale, transform: [{ scale }], transformOrigin: "0 0" }]}
    >
      <View style={styles.headerRow}>
        <Text style={styles.question} numberOfLines={3}>
          {poll.question}
        </Text>
        {canManage && (
          <TouchableOpacity
            testID={`poll-delete-${poll.id}`}
            accessibilityRole="button"
            accessibilityLabel="Delete poll"
            onPress={onDelete}
            hitSlop={8}
          >
            <Ionicons name="trash-outline" size={16} color="#9ca3af" />
          </TouchableOpacity>
        )}
      </View>

      {poll.anonymous && (
        <Text style={styles.anonymousNote}>
          Anonymous to other members — your identity is still stored so you
          can only vote once
        </Text>
      )}

      {poll.options.map((label, index) => {
        const count = results?.counts[index] ?? 0;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        const selected = myVote.includes(index);
        return (
          <TouchableOpacity
            key={index}
            testID={`poll-option-${poll.id}-${index}`}
            accessibilityRole="button"
            accessibilityLabel={`${label}${results ? `, ${count} vote${count === 1 ? "" : "s"}` : ""}`}
            disabled={!canVote}
            onPress={() => (isDots ? onToggleDot(index) : onVote(index))}
            style={[styles.option, selected && styles.optionSelected]}
          >
            <View style={styles.optionBarTrack}>
              {results && <View style={[styles.optionBarFill, { width: `${pct}%` }]} />}
              <View style={styles.optionContentRow}>
                <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]} numberOfLines={2}>
                  {selected ? (isDots ? "● " : "✓ ") : ""}
                  {label}
                </Text>
                {results && <Text style={styles.optionCount}>{count}</Text>}
              </View>
            </View>
          </TouchableOpacity>
        );
      })}

      <View style={styles.footerRow}>
        <Text style={styles.totalText}>
          {results
            ? `${totalVotes} vote${totalVotes === 1 ? "" : "s"}`
            : poll.anonymous
              ? "No votes yet — results appear after the first is counted"
              : "No votes yet"}
        </Text>
        {onAdvanceQuiz && canManage && (
          <TouchableOpacity
            testID={`poll-next-question-${poll.id}`}
            accessibilityRole="button"
            accessibilityLabel="Next question"
            onPress={onAdvanceQuiz}
            style={styles.nextBtn}
          >
            <Text style={styles.nextBtnText}>Next</Text>
            <Ionicons name="arrow-forward" size={13} color="#fff" />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 10,
    gap: 6,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 6,
  },
  question: {
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    color: "#111827",
  },
  anonymousNote: {
    fontSize: 10,
    color: "#6b7280",
    fontStyle: "italic",
  },
  option: {
    borderRadius: 8,
    overflow: "hidden",
  },
  optionSelected: {
    borderWidth: 1,
    borderColor: "#2563eb",
    borderRadius: 8,
  },
  optionBarTrack: {
    backgroundColor: "#f3f4f6",
    borderRadius: 8,
  },
  optionBarFill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "#dbeafe",
    borderRadius: 8,
  },
  optionContentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  optionLabel: {
    flex: 1,
    fontSize: 12,
    color: "#111827",
  },
  optionLabelSelected: {
    fontWeight: "700",
    color: "#1d4ed8",
  },
  optionCount: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4b5563",
    marginLeft: 6,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  totalText: {
    fontSize: 10,
    color: "#9ca3af",
    flexShrink: 1,
  },
  nextBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#2563eb",
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  nextBtnText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },
});
