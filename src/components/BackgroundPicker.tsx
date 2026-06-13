import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BackgroundTemplate } from "../types";
import { BACKGROUND_TEMPLATES } from "../lib/backgrounds";

interface BackgroundPickerProps {
  visible: boolean;
  active: BackgroundTemplate;
  onSelect: (template: BackgroundTemplate) => void;
  onClose: () => void;
}

const META: Record<
  BackgroundTemplate,
  { label: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  blank: { label: "Blank", icon: "document-outline" },
  grid: { label: "Grid", icon: "grid-outline" },
  dots: { label: "Dot grid", icon: "ellipsis-horizontal-outline" },
  lined: { label: "Lined", icon: "reorder-four-outline" },
  isometric: { label: "Isometric", icon: "cube-outline" },
  coordinate: { label: "Coordinate", icon: "stats-chart-outline" },
};

/**
 * Phase 12: per-board background-template chooser. A lightweight modal sheet of
 * the six templates; selecting one persists immediately and closes.
 */
export default function BackgroundPicker({
  visible,
  active,
  onSelect,
  onClose,
}: BackgroundPickerProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.heading}>Background</Text>
          <View style={styles.grid}>
            {BACKGROUND_TEMPLATES.map((t) => {
              const { label, icon } = META[t];
              const isActive = t === active;
              return (
                <TouchableOpacity
                  key={t}
                  style={[styles.cell, isActive && styles.cellActive]}
                  onPress={() => {
                    onSelect(t);
                    onClose();
                  }}
                >
                  <Ionicons name={icon} size={24} color={isActive ? "#2563eb" : "#444"} />
                  <Text style={[styles.cellLabel, isActive && styles.cellLabelActive]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  sheet: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 6,
  },
  heading: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111",
    marginBottom: 12,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  cell: {
    width: "30%",
    flexGrow: 1,
    minWidth: 96,
    aspectRatio: 1.4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#FAFAFA",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
  },
  cellActive: {
    borderColor: "#2563eb",
    backgroundColor: "#EFF6FF",
  },
  cellLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#444",
  },
  cellLabelActive: {
    color: "#2563eb",
  },
});
