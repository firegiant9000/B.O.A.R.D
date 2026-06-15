import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ShapeRecognitionMode } from "../types";

interface PenOptionsBarProps {
  mode: ShapeRecognitionMode;
  onCycleMode: () => void;
}

const MODE_LABEL: Record<ShapeRecognitionMode, string> = {
  always: "Always",
  ask: "Ask",
  never: "Off",
};

/**
 * Contextual style row for the pen tool (Phase 9). Only mounted while the pen
 * tool is active. Owns the single auto-perfect ("perfect shapes") control: a pill
 * that cycles the per-user mode Ask → Always → Off. The board screen persists the
 * choice to the user doc via shapeRecognitionService.
 */
export default function PenOptionsBar({ mode, onCycleMode }: PenOptionsBarProps) {
  const active = mode !== "never";
  return (
    <View style={styles.container}>
      <View style={styles.scrollContent}>
        <TouchableOpacity
          style={[styles.pill, active && styles.pillActive]}
          onPress={onCycleMode}
          accessibilityRole="button"
          accessibilityLabel={`Perfect shapes: ${MODE_LABEL[mode]}`}
        >
          <Ionicons
            name="shapes-outline"
            size={14}
            color={active ? "#fff" : "#333"}
          />
          <Text style={[styles.pillText, active && styles.pillTextActive]}>
            Perfect: {MODE_LABEL[mode]}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 92,
    left: 10,
    right: 10,
    backgroundColor: "#F2F2F7",
    borderRadius: 14,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 4,
  },
  scrollContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#D1D1D6",
  },
  pillActive: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  pillText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#333",
  },
  pillTextActive: {
    color: "#fff",
  },
});
