import React from "react";
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { buildCheatSheet } from "../lib/shortcuts";

interface Props {
  visible: boolean;
  onClose: () => void;
}

/**
 * Phase 11: the `?` cheat sheet. Lists every binding, sourced from the same
 * `buildCheatSheet` table the resolver is built around, so the displayed keys
 * can't drift from what's actually wired.
 */
export default function ShortcutsCheatSheet({ visible, onClose }: Props) {
  const sections = buildCheatSheet();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Stop propagation so taps inside the card don't dismiss it. */}
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>Keyboard Shortcuts</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color="#6b7280" />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {sections.map((section) => (
              <View key={section.title} style={styles.section}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {section.items.map((item) => (
                  <View key={item.label} style={styles.row}>
                    <Text style={styles.rowLabel}>{item.label}</Text>
                    <View style={styles.keys}>
                      {item.keys.map((k, i) => (
                        <View key={`${item.label}-${i}`} style={styles.keyCap}>
                          <Text style={styles.keyCapText}>{k}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    maxHeight: "80%",
    backgroundColor: "#fff",
    borderRadius: 16,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  body: {
    paddingHorizontal: 20,
  },
  bodyContent: {
    paddingVertical: 12,
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#2563eb",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 5,
  },
  rowLabel: {
    fontSize: 14,
    color: "#374151",
    flex: 1,
  },
  keys: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  keyCap: {
    minWidth: 24,
    paddingHorizontal: 7,
    paddingVertical: 3,
    backgroundColor: "#F3F4F6",
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 6,
    alignItems: "center",
  },
  keyCapText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#374151",
  },
});
