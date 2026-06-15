import React from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

// Month 4, Phase 12 — the "text → diagram" prompt sheet. Presentational: it
// collects a natural-language description and hands it back; the board screen owns
// the actual generate call (it needs viewport/selection context to place the
// result). Mirrors StartSessionModal's page-sheet layout + styling.

interface DiagramPromptModalProps {
  visible: boolean;
  prompt: string;
  busy: boolean;
  onChangePrompt: (text: string) => void;
  onGenerate: () => void;
  onClose: () => void;
}

// A few starter prompts spanning the supported families (flowchart, sequence,
// class, mindmap) so a first-time user sees what kinds of asks work.
const EXAMPLES = [
  "Flowchart for the HTTPS handshake",
  "Sequence diagram of a user logging in",
  "Mind map of photosynthesis",
  "Class diagram for a blog with posts and comments",
];

export default function DiagramPromptModal({
  visible,
  prompt,
  busy,
  onChangePrompt,
  onGenerate,
  onClose,
}: DiagramPromptModalProps) {
  const canGenerate = prompt.trim().length > 0 && !busy;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.cancelBtn} disabled={busy}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Generate Diagram</Text>
          <TouchableOpacity
            style={[styles.createBtn, !canGenerate && styles.createBtnDisabled]}
            onPress={onGenerate}
            disabled={!canGenerate}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.createText}>Draw</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.badge}>
            <Ionicons name="git-network-outline" size={14} color="#2563eb" />
            <Text style={styles.badgeText}>AI · editable native shapes</Text>
          </View>

          <Text style={styles.fieldLabel}>Describe the diagram</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Flowchart for the HTTPS handshake"
            value={prompt}
            onChangeText={onChangePrompt}
            multiline
            numberOfLines={3}
            maxLength={500}
            editable={!busy}
            autoFocus
          />

          <Text style={styles.examplesLabel}>Try one of these</Text>
          <View style={styles.examples}>
            {EXAMPLES.map((ex) => (
              <TouchableOpacity
                key={ex}
                style={styles.exampleChip}
                onPress={() => onChangePrompt(ex)}
                disabled={busy}
                activeOpacity={0.7}
              >
                <Text style={styles.exampleText}>{ex}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.noticeBox}>
            <Ionicons name="sparkles-outline" size={16} color="#6b7280" />
            <Text style={styles.noticeText}>
              The diagram drops onto your board as regular shapes and text you can move, edit,
              and restyle. Works best for flowcharts, sequences, class diagrams, and mind maps.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#fff",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "ios" ? 16 : 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  cancelBtn: {
    paddingVertical: 4,
    paddingHorizontal: 2,
    minWidth: 60,
  },
  cancelText: {
    color: "#6b7280",
    fontSize: 16,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
  },
  createBtn: {
    backgroundColor: "#2563eb",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 10,
    minWidth: 72,
    alignItems: "center",
  },
  createBtnDisabled: {
    opacity: 0.6,
  },
  createText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#eff6ff",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignSelf: "flex-start",
    marginBottom: 20,
  },
  badgeText: {
    color: "#2563eb",
    fontSize: 13,
    fontWeight: "600",
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: "#f9fafb",
    marginBottom: 20,
    minHeight: 88,
    textAlignVertical: "top",
  },
  examplesLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  examples: {
    gap: 8,
    marginBottom: 24,
  },
  exampleChip: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
  },
  exampleText: {
    fontSize: 14,
    color: "#374151",
    fontWeight: "500",
  },
  noticeBox: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    alignItems: "flex-start",
  },
  noticeText: {
    flex: 1,
    fontSize: 13,
    color: "#6b7280",
    lineHeight: 18,
  },
});
