import React, { useState } from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ONBOARDING_STEPS } from "./steps";

export interface OnboardingTutorialProps {
  visible: boolean;
  /** Fired when the tutorial is skipped at any step, or finished at the last
   *  step (Done) — either way `useOnboardingTutorial`'s caller should mark
   *  it complete so it doesn't show again for this uid. */
  onDismiss: () => void;
}

/**
 * Month 5 — the first-run onboarding tutorial (ROADMAP.md item 4): a
 * six-card walkthrough (draw → shape → invite → schedule session → end
 * session → see AI summary, `steps.ts`). `useOnboardingTutorial` decides
 * *when* this shows (per-uid, AsyncStorage-backed); this component only
 * renders the steps and reports back when the viewer is done with them.
 *
 * Presentational only: no service import, no navigation, no session/board
 * side effect. Steps 3–6 describe real, costed affordances (session create
 * is plan-gated, an AI summary spends metered quota) — the walkthrough
 * teaches and points at them, it never triggers them.
 */
export default function OnboardingTutorial({ visible, onDismiss }: OnboardingTutorialProps) {
  const [stepIndex, setStepIndex] = useState(0);

  if (!visible) return null;

  const step = ONBOARDING_STEPS[stepIndex];
  const isLast = stepIndex === ONBOARDING_STEPS.length - 1;

  const handleDismiss = () => {
    setStepIndex(0);
    onDismiss();
  };

  const handleNext = () => {
    if (isLast) {
      handleDismiss();
    } else {
      setStepIndex((i) => i + 1);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={handleDismiss}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleDismiss} />
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.stepCounter}>
              {stepIndex + 1} of {ONBOARDING_STEPS.length}
            </Text>
            {/* Present on every step — see the test's per-step walk. */}
            <TouchableOpacity onPress={handleDismiss} hitSlop={8}>
              <Text style={styles.skipText}>Skip</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.iconWrap}>
            <Ionicons name={step.icon as keyof typeof Ionicons.glyphMap} size={36} color="#2563eb" />
          </View>
          <Text style={styles.title}>{step.title}</Text>
          <Text style={styles.body}>{step.body}</Text>

          <View style={styles.dots}>
            {ONBOARDING_STEPS.map((s, i) => (
              <View key={s.key} style={[styles.dot, i === stepIndex && styles.dotActive]} />
            ))}
          </View>

          <TouchableOpacity style={styles.nextBtn} onPress={handleNext} activeOpacity={0.8}>
            <Text style={styles.nextText}>{isLast ? "Done" : "Next"}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 10,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    marginBottom: 20,
  },
  stepCounter: {
    fontSize: 12,
    fontWeight: "600",
    color: "#9ca3af",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  skipText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#6b7280",
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111827",
    textAlign: "center",
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: "#6b7280",
    textAlign: "center",
    lineHeight: 20,
  },
  dots: {
    flexDirection: "row",
    gap: 6,
    marginTop: 20,
    marginBottom: 20,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#e5e7eb",
  },
  dotActive: {
    backgroundColor: "#2563eb",
    width: 18,
  },
  nextBtn: {
    width: "100%",
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  nextText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
});
