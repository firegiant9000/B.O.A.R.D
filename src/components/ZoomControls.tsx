import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

interface ZoomControlsProps {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onFit: () => void;
}

export default function ZoomControls({
  scale,
  onZoomIn,
  onZoomOut,
  onReset,
  onFit,
}: ZoomControlsProps) {
  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.btn} onPress={onZoomIn} hitSlop={6}>
        <Ionicons name="add" size={20} color="#333" />
      </TouchableOpacity>
      <TouchableOpacity style={styles.percentBtn} onPress={onReset} hitSlop={6}>
        <Text style={styles.percentText}>{Math.round(scale * 100)}%</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.btn} onPress={onZoomOut} hitSlop={6}>
        <Ionicons name="remove" size={20} color="#333" />
      </TouchableOpacity>
      <View style={styles.divider} />
      <TouchableOpacity style={styles.btn} onPress={onFit} hitSlop={6}>
        <Ionicons name="scan-outline" size={18} color="#333" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    right: 12,
    top: 12,
    backgroundColor: "rgba(255,255,255,0.95)",
    borderRadius: 12,
    paddingVertical: 4,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  btn: {
    width: 36,
    height: 32,
    justifyContent: "center",
    alignItems: "center",
  },
  percentBtn: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    minWidth: 36,
    alignItems: "center",
  },
  percentText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#333",
  },
  divider: {
    height: 1,
    width: 24,
    backgroundColor: "#E5E7EB",
    marginVertical: 2,
  },
});
