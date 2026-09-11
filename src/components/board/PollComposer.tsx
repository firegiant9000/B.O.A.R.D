import React, { useState } from "react";
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Switch } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { MAX_POLL_OPTIONS, MIN_POLL_OPTIONS, PollMode } from "../../types";

// Month 6 — the poll-creation form. Editor-only entry point (Toolbar's
// "Insert poll" button, gated the same as image insert); a poll's board-space
// position is chosen by the caller (BoardCanvas centers it in the current
// viewport), not by this form.

export interface NewPollInput {
  question: string;
  options: string[];
  anonymous: boolean;
  mode: PollMode;
}

export interface PollComposerProps {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (input: NewPollInput) => void;
}

export default function PollComposer({ visible, onCancel, onSubmit }: PollComposerProps) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [anonymous, setAnonymous] = useState(false);
  const [mode, setMode] = useState<PollMode>("single");

  const reset = () => {
    setQuestion("");
    setOptions(["", ""]);
    setAnonymous(false);
    setMode("single");
  };

  const canSubmit =
    question.trim().length > 0 && options.filter((o) => o.trim().length > 0).length >= MIN_POLL_OPTIONS;

  const handleCancel = () => {
    reset();
    onCancel();
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({
      question: question.trim(),
      options: options.map((o) => o.trim()).filter((o) => o.length > 0),
      anonymous,
      mode,
    });
    reset();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="poll-composer">
          <Text style={styles.title}>New poll</Text>

          <TextInput
            testID="poll-composer-question"
            style={styles.questionInput}
            placeholder="Ask a question…"
            value={question}
            onChangeText={setQuestion}
            maxLength={200}
          />

          <ScrollView style={styles.optionsScroll}>
            {options.map((opt, index) => (
              <View key={index} style={styles.optionRow}>
                <TextInput
                  testID={`poll-composer-option-${index}`}
                  style={styles.optionInput}
                  placeholder={`Option ${index + 1}`}
                  value={opt}
                  onChangeText={(text) =>
                    setOptions((prev) => prev.map((o, i) => (i === index ? text : o)))
                  }
                  maxLength={80}
                />
                {options.length > MIN_POLL_OPTIONS && (
                  <TouchableOpacity
                    testID={`poll-composer-remove-option-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove option ${index + 1}`}
                    onPress={() => setOptions((prev) => prev.filter((_, i) => i !== index))}
                    hitSlop={8}
                  >
                    <Ionicons name="close-circle-outline" size={18} color="#9ca3af" />
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </ScrollView>

          {options.length < MAX_POLL_OPTIONS && (
            <TouchableOpacity
              testID="poll-composer-add-option"
              accessibilityRole="button"
              accessibilityLabel="Add another option"
              onPress={() => setOptions((prev) => [...prev, ""])}
              style={styles.addOptionBtn}
            >
              <Ionicons name="add" size={16} color="#2563eb" />
              <Text style={styles.addOptionText}>Add option</Text>
            </TouchableOpacity>
          )}

          <View style={styles.row}>
            <TouchableOpacity
              testID="poll-composer-mode-single"
              onPress={() => setMode("single")}
              style={[styles.modeBtn, mode === "single" && styles.modeBtnActive]}
            >
              <Text style={[styles.modeBtnText, mode === "single" && styles.modeBtnTextActive]}>Single choice</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="poll-composer-mode-dots"
              onPress={() => setMode("dots")}
              style={[styles.modeBtn, mode === "dots" && styles.modeBtnActive]}
            >
              <Text style={[styles.modeBtnText, mode === "dots" && styles.modeBtnTextActive]}>Dot voting</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Anonymous</Text>
              <Text style={styles.switchHint}>Hides who voted from other members — still one vote per person</Text>
            </View>
            <Switch testID="poll-composer-anonymous" value={anonymous} onValueChange={setAnonymous} />
          </View>

          <View style={styles.footerRow}>
            <TouchableOpacity testID="poll-composer-cancel" onPress={handleCancel} style={styles.cancelBtn}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="poll-composer-submit"
              onPress={handleSubmit}
              disabled={!canSubmit}
              style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
            >
              <Text style={styles.submitBtnText}>Create poll</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
  },
  sheet: {
    width: 320,
    maxHeight: 480,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111827",
  },
  questionInput: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  optionsScroll: {
    maxHeight: 180,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  optionInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
  },
  addOptionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
  },
  addOptionText: {
    color: "#2563eb",
    fontSize: 13,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  modeBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center",
  },
  modeBtnActive: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  modeBtnText: {
    fontSize: 12,
    color: "#374151",
    fontWeight: "600",
  },
  modeBtnTextActive: {
    color: "#fff",
  },
  switchLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#111827",
  },
  switchHint: {
    fontSize: 10,
    color: "#6b7280",
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  cancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  cancelBtnText: {
    color: "#6b7280",
    fontWeight: "600",
    fontSize: 13,
  },
  submitBtn: {
    backgroundColor: "#2563eb",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  submitBtnDisabled: {
    backgroundColor: "#93c5fd",
  },
  submitBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
  },
});
