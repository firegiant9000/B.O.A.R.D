import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
// From `lib/mathInk`, not from mathService: this is a presentational
// component and must not pull the Firestore SDK in through the service just
// to read a number.
import { MAX_LATEX_LENGTH } from "../../lib/mathInk";

// Month 6 — the equation composer. BOTH entry points for a math element live
// here: the toolbar's "insert equation" button opens it empty, and tapping an
// existing math element opens it seeded with that element's `latex`. There is
// no second edit surface — `latex` is the editable source of truth and
// `svgPath` is cached output, so "edit" is always "retype the source and
// re-render", never "nudge the rendered glyphs".
//
// Submitting is asynchronous (it calls the `renderMath` Cloud Function via
// mathService) and can fail on a typo, so unlike PollComposer this form stays
// OPEN while the render is in flight and shows the failure inline. A TeX
// error is a sentence the user can act on — "Missing close brace" — and
// closing the sheet on it would throw away what they had typed.

/** A few starters, so the first thing someone sees is not an empty box with
 *  the word "LaTeX" over it. Insert-at-cursor is deliberately not attempted;
 *  these append, which is predictable. */
const SNIPPETS: { label: string; latex: string }[] = [
  { label: "a/b", latex: "\\frac{a}{b}" },
  { label: "√", latex: "\\sqrt{x}" },
  { label: "xⁿ", latex: "x^{n}" },
  { label: "Σ", latex: "\\sum_{i=1}^{n} " },
  { label: "∫", latex: "\\int_{0}^{1} " },
  { label: "π", latex: "\\pi" },
  { label: "≤", latex: "\\leq" },
  { label: "→", latex: "\\to" },
];

export interface MathComposerProps {
  visible: boolean;
  /** The id of the element being edited, or null/undefined when inserting a
   *  new one. This — NOT `initialLatex` — is what drives the title and the
   *  submit label: an existing element can legitimately have empty `latex`
   *  (see `latexOfMathElement`), and deriving "am I editing" from the seeded
   *  text would then mislabel a real edit as an insert. */
  editingId?: string | null;
  /** The element being edited, or null when inserting a new one. What the
   *  field starts with. */
  initialLatex?: string | null;
  /** Set while the render is in flight; the sheet stays open and disabled. */
  busy?: boolean;
  /** A failure to show inline — a TeX message, or a service error. */
  error?: string | null;
  onCancel: () => void;
  onSubmit: (latex: string) => void;
}

export default function MathComposer({
  visible,
  editingId,
  initialLatex,
  busy = false,
  error,
  onCancel,
  onSubmit,
}: MathComposerProps) {
  const [latex, setLatex] = useState(initialLatex ?? "");

  // Re-seed whenever the sheet opens, or the element being edited changes
  // underneath it. Keyed on `visible` too so reopening for a NEW element
  // never shows the previous one's source.
  useEffect(() => {
    if (visible) setLatex(initialLatex ?? "");
  }, [visible, initialLatex]);

  const editing = editingId != null;
  const trimmed = latex.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(trimmed);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="math-composer">
          <Text style={styles.title}>{editing ? "Edit equation" : "New equation"}</Text>
          <Text style={styles.hint}>
            Write LaTeX. It is typeset to vector paths, so the equation behaves like any
            other element — select it, move it, resize it, export it.
          </Text>

          <TextInput
            testID="math-composer-latex"
            style={styles.input}
            placeholder="e.g. \frac{-b \pm \sqrt{b^2-4ac}}{2a}"
            value={latex}
            onChangeText={setLatex}
            editable={!busy}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            // Advisory only — the real cap is enforced inside the callable
            // (see MAX_LATEX_LENGTH's own comment in lib/mathInk). This just
            // stops the field accepting characters the server would refuse.
            maxLength={MAX_LATEX_LENGTH}
          />

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.snippetRow}>
            {SNIPPETS.map((s) => (
              <TouchableOpacity
                key={s.label}
                testID={`math-composer-snippet-${s.latex}`}
                accessibilityRole="button"
                accessibilityLabel={`Insert ${s.label}`}
                disabled={busy}
                onPress={() => setLatex((prev) => prev + s.latex)}
                style={styles.snippet}
              >
                <Text style={styles.snippetText}>{s.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {!!error && (
            <Text testID="math-composer-error" style={styles.error}>
              {error}
            </Text>
          )}

          <View style={styles.footerRow}>
            <TouchableOpacity
              testID="math-composer-cancel"
              onPress={onCancel}
              disabled={busy}
              style={styles.cancelBtn}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="math-composer-submit"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit }}
              onPress={handleSubmit}
              disabled={!canSubmit}
              style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
            >
              {busy ? (
                <ActivityIndicator testID="math-composer-busy" size="small" color="#fff" />
              ) : (
                <Text style={styles.submitBtnText}>{editing ? "Update" : "Add equation"}</Text>
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
    width: 340,
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
  input: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    minHeight: 72,
    textAlignVertical: "top",
  },
  snippetRow: {
    flexGrow: 0,
  },
  snippet: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 6,
  },
  snippetText: {
    fontSize: 13,
    color: "#374151",
    fontWeight: "600",
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
    minWidth: 110,
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
