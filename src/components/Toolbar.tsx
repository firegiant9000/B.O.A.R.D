import React from "react";
import {
  View,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

type Tool = "pen" | "eraser" | "text" | "select";

interface ToolbarProps {
  activeTool: Tool;
  activeColor: string;
  activeStrokeWidth: number;
  isAdmin: boolean;
  onToolChange: (tool: Tool) => void;
  onColorChange: (color: string) => void;
  onStrokeWidthChange: (width: number) => void;
  onUndo: () => void;
  onRedo?: () => void;
  canRedo?: boolean;
  onClear: () => void;
  onSave: () => void;
}

const COLORS = [
  "#000000",
  "#FF3B30",
  "#FF9500",
  "#FFCC00",
  "#34C759",
  "#007AFF",
  "#5856D6",
  "#AF52DE",
];

const STROKE_WIDTHS = [
  { label: "S", value: 2 },
  { label: "M", value: 5 },
  { label: "L", value: 10 },
];

export default function Toolbar({
  activeTool,
  activeColor,
  activeStrokeWidth,
  isAdmin,
  onToolChange,
  onColorChange,
  onStrokeWidthChange,
  onUndo,
  onRedo,
  canRedo,
  onClear,
  onSave,
}: ToolbarProps) {
  const handleClear = () => {
    Alert.alert(
      "Clear Board",
      "This will permanently delete all drawings and notes on this board.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear All", style: "destructive", onPress: onClear },
      ]
    );
  };

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Tool Selectors */}
        <View style={styles.group}>
          <ToolButton
            icon="pencil"
            active={activeTool === "pen"}
            onPress={() => onToolChange("pen")}
          />
          <ToolButton
            icon="cut-outline"
            active={activeTool === "eraser"}
            onPress={() => onToolChange("eraser")}
          />
          <ToolButton
            icon="text"
            active={activeTool === "text"}
            onPress={() => onToolChange("text")}
          />
          <ToolButton
            icon="resize-outline"
            active={activeTool === "select"}
            onPress={() => onToolChange("select")}
          />
        </View>

        <View style={styles.divider} />

        {/* Color Picker */}
        <View style={styles.group}>
          {COLORS.map((c) => (
            <TouchableOpacity
              key={c}
              style={[
                styles.colorDot,
                { backgroundColor: c },
                activeColor === c && styles.colorDotActive,
              ]}
              onPress={() => onColorChange(c)}
            />
          ))}
        </View>

        <View style={styles.divider} />

        {/* Stroke Width */}
        <View style={styles.group}>
          {STROKE_WIDTHS.map((sw) => (
            <TouchableOpacity
              key={sw.value}
              style={[
                styles.strokeBtn,
                activeStrokeWidth === sw.value && styles.strokeBtnActive,
              ]}
              onPress={() => onStrokeWidthChange(sw.value)}
            >
              <View
                style={[
                  styles.strokePreview,
                  {
                    width: sw.value * 3 + 4,
                    height: sw.value * 3 + 4,
                    borderRadius: (sw.value * 3 + 4) / 2,
                    backgroundColor:
                      activeStrokeWidth === sw.value ? "#fff" : "#333",
                  },
                ]}
              />
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.divider} />

        {/* Actions */}
        <View style={styles.group}>
          <ToolButton icon="arrow-undo" active={false} onPress={onUndo} />
          <ToolButton icon="arrow-redo" active={false} onPress={onRedo ?? (() => {})} disabled={canRedo === false} />
          {isAdmin && (
            <ToolButton icon="trash-outline" active={false} onPress={handleClear} />
          )}
          <ToolButton icon="save-outline" active={false} onPress={onSave} />
        </View>
      </ScrollView>
    </View>
  );
}

function ToolButton({
  icon,
  active,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.toolBtn, active && styles.toolBtnActive, disabled && styles.toolBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Ionicons name={icon} size={20} color={active ? "#fff" : disabled ? "#c7c7cc" : "#333"} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 30,
    left: 10,
    right: 10,
    backgroundColor: "#F2F2F7",
    borderRadius: 16,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
  },
  scrollContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  divider: {
    width: 1,
    height: 28,
    backgroundColor: "#C7C7CC",
    marginHorizontal: 8,
  },
  toolBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  toolBtnActive: {
    backgroundColor: "#2563eb",
  },
  toolBtnDisabled: {
    opacity: 0.4,
  },
  colorDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorDotActive: {
    borderColor: "#2563eb",
    borderWidth: 3,
  },
  strokeBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  strokeBtnActive: {
    backgroundColor: "#2563eb",
  },
  strokePreview: {
    backgroundColor: "#333",
  },
});
