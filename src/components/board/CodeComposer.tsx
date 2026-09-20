import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
// From `lib/codeRender`, not `services/codeService`: this is a presentational
// component and must not pull the Firestore SDK in through the service just
// to read the language list.
import { CODE_LANGUAGES, CODE_DEFAULT_LANGUAGE } from "../../lib/codeRender";
import type { CodeLanguage } from "../../types";

// Month 6 — the code composer. BOTH entry points for a code element live
// here: the toolbar's "insert code" button opens it empty (language defaults
// to CODE_DEFAULT_LANGUAGE), and tapping an existing code element opens it
// seeded with that element's `code`/`language`. There is no second edit
// surface — `code`/`language` are the only source of truth (tokenizing is
// synchronous and local — see `lib/codeRender.ts`'s header) — so "edit" is
// always "retype the source", mirroring MathComposer's own framing.
//
// UNLIKE MathComposer, submitting never calls a Cloud Function and cannot
// fail on the CONTENT itself (`codeService`'s header: there is no "invalid
// code", only text). The sheet still stays open on a rejection rather than
// closing — the only realistic one is the write-path guard for an element a
// collaborator deleted while this was open, and closing would discard what
// was typed at the exact moment it needs to be moved somewhere before
// resubmitting.

const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  ts: "TypeScript",
  js: "JavaScript",
  py: "Python",
  java: "Java",
  c: "C",
  cpp: "C++",
  sql: "SQL",
  json: "JSON",
  bash: "Bash",
};

export interface CodeComposerProps {
  visible: boolean;
  /** The id of the element being edited, or null/undefined when inserting a
   *  new one. This — NOT `initialCode` — is what drives the title and the
   *  submit label: an existing element can legitimately have empty `code`
   *  (see `CodeElement`'s type comment), and deriving "am I editing" from
   *  the seeded text would mislabel a real edit as an insert, the same trap
   *  MathComposer's own `editingId` avoids. */
  editingId?: string | null;
  /** The edited element's current source, or null when inserting. */
  initialCode?: string | null;
  /** The edited element's current language, or null when inserting. */
  initialLanguage?: CodeLanguage | null;
  /** Set while the write is in flight; the sheet stays open and disabled. */
  busy?: boolean;
  /** A failure to show inline. */
  error?: string | null;
  onCancel: () => void;
  onSubmit: (code: string, language: CodeLanguage) => void;
}

export default function CodeComposer({
  visible,
  editingId,
  initialCode,
  initialLanguage,
  busy = false,
  error,
  onCancel,
  onSubmit,
}: CodeComposerProps) {
  const [code, setCode] = useState(initialCode ?? "");
  const [language, setLanguage] = useState<CodeLanguage>(initialLanguage ?? CODE_DEFAULT_LANGUAGE);

  // Re-seed whenever the sheet opens, or the element being edited changes
  // underneath it — mirrors MathComposer's own effect exactly.
  useEffect(() => {
    if (visible) {
      setCode(initialCode ?? "");
      setLanguage(initialLanguage ?? CODE_DEFAULT_LANGUAGE);
    }
  }, [visible, initialCode, initialLanguage]);

  const editing = editingId != null;
  const trimmed = code.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const handleSubmit = () => {
    if (!canSubmit) return;
    // UNLIKE MathComposer's `trimmed`, the untrimmed source is what's
    // written: leading/trailing whitespace can be meaningful in source code
    // (a Python docstring's indentation, a trailing newline) in a way it
    // never is in a LaTeX expression.
    onSubmit(code, language);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="code-composer">
          <Text style={styles.title}>{editing ? "Edit code" : "New code block"}</Text>
          <Text style={styles.hint}>
            Paste or type source — it's syntax-highlighted on-device. Pick a language below.
          </Text>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.langRow}>
            {CODE_LANGUAGES.map((lang) => (
              <TouchableOpacity
                key={lang}
                testID={`code-composer-lang-${lang}`}
                accessibilityRole="button"
                accessibilityState={{ selected: language === lang }}
                disabled={busy}
                onPress={() => setLanguage(lang)}
                style={[styles.langChip, language === lang && styles.langChipActive]}
              >
                <Text style={[styles.langChipText, language === lang && styles.langChipTextActive]}>
                  {LANGUAGE_LABELS[lang]}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <TextInput
            testID="code-composer-source"
            style={styles.input}
            placeholder="e.g. const x = 1;"
            value={code}
            onChangeText={setCode}
            editable={!busy}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />

          {!!error && (
            <Text testID="code-composer-error" style={styles.error}>
              {error}
            </Text>
          )}

          <View style={styles.footerRow}>
            <TouchableOpacity
              testID="code-composer-cancel"
              onPress={onCancel}
              disabled={busy}
              style={styles.cancelBtn}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="code-composer-submit"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit }}
              onPress={handleSubmit}
              disabled={!canSubmit}
              style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
            >
              {busy ? (
                <ActivityIndicator testID="code-composer-busy" size="small" color="#fff" />
              ) : (
                <Text style={styles.submitBtnText}>{editing ? "Update" : "Add code block"}</Text>
              )}
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
    width: 360,
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
  hint: {
    fontSize: 11,
    color: "#6b7280",
  },
  langRow: {
    flexGrow: 0,
  },
  langChip: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 6,
  },
  langChipActive: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  langChipText: {
    fontSize: 12,
    color: "#374151",
    fontWeight: "600",
  },
  langChipTextActive: {
    color: "#fff",
  },
  input: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    minHeight: 120,
    textAlignVertical: "top",
  },
  error: {
    fontSize: 12,
    color: "#b91c1c",
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
    minWidth: 130,
    alignItems: "center",
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
