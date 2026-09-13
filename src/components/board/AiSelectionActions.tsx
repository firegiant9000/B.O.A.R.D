import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Bounds, Viewport, boardToScreen } from "../../lib/viewport";
import type { OcrCandidate } from "../../hooks/useBoardAI";

/**
 * The AI affordances anchored to the current selection (Month 5/6 Task 1 —
 * extracted verbatim from `app/board/[id].tsx`).
 *
 * Three flag-gated layers that all hang off the selection's union box:
 * - Phase 10 "Recognize text" (OCR),
 * - Phase 11 "Explain this",
 * - Phase 10's low-confidence OCR confirm prompt (Appendix B.7).
 *
 * Each is rendered only when its own feature flag is on, so with the default-OFF
 * flags this component renders nothing at all.
 */

interface AiSelectionActionsProps {
  viewport: Viewport;
  /** `isOcrConfigured()` — OCR_ENABLED && AI_GATEWAY_ENABLED. */
  ocrEnabled: boolean;
  /** `isExplainConfigured()` — EXPLAIN_ENABLED && AI_GATEWAY_ENABLED. */
  explainEnabled: boolean;
  /**
   * True while a selection is live under the select tool and nothing is in the
   * way (no transform, no drag, no open confirm prompt).
   */
  selectionActionable: boolean;
  selectionUnion: Bounds | null;
  ocrBusy: boolean;
  /** Undefined suppresses the "Recognize text" button (Month 5 presenter
   *  lock) — its high-confidence path writes a text element directly. */
  onRecognizeText?: () => void;
  explainBusy: boolean;
  /** Undefined suppresses the "Explain this" button (Month 5 presenter
   *  lock) — it always writes a text element. */
  onExplain?: () => void;
  /** A held-back low-confidence OCR result, or null. */
  ocrCandidate: OcrCandidate | null;
  /** Undefined suppresses the "Insert anyway" button (Month 5 presenter lock) —
   *  the prompt itself and "Discard" stay available either way. */
  onAcceptOcr?: () => void;
  onDismissOcr: () => void;
  /** `isFlashcardsConfigured()` — FLASHCARDS_ENABLED && AI_GATEWAY_ENABLED
   *  (Month 6). */
  flashcardsEnabled: boolean;
  flashcardsBusy: boolean;
  /** Undefined suppresses the "Make flashcards" button (Month 5 presenter
   *  lock) — it saves to the caller's own deck, never the canvas, but is
   *  still content creation the same way OCR/explain are. */
  onMakeFlashcards?: () => void;
}

export default function AiSelectionActions({
  viewport,
  ocrEnabled,
  explainEnabled,
  selectionActionable,
  selectionUnion,
  ocrBusy,
  onRecognizeText,
  explainBusy,
  onExplain,
  ocrCandidate,
  onAcceptOcr,
  onDismissOcr,
  flashcardsEnabled,
  flashcardsBusy,
  onMakeFlashcards,
}: AiSelectionActionsProps) {
  return (
    <>
      {/* Phase 10 — OCR affordance. A "Recognize text" button below the
          selection while strokes are selected; tapping it OCRs the region into
          a text element. Hidden during a transform/drag and while a low-
          confidence confirm prompt is open. */}
      {ocrEnabled &&
        onRecognizeText &&
        selectionActionable &&
        selectionUnion &&
        (() => {
          const u = selectionUnion;
          const anchor = boardToScreen(viewport, {
            x: (u.minX + u.maxX) / 2,
            y: u.maxY,
          });
          return (
            <View
              style={[styles.ocrButton, { left: anchor.x - 74, top: anchor.y + 10 }]}
              pointerEvents="box-none"
            >
              <TouchableOpacity
                style={styles.ocrButtonInner}
                onPress={onRecognizeText}
                disabled={ocrBusy}
                activeOpacity={0.85}
              >
                {ocrBusy ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="text-outline" size={15} color="#fff" />
                )}
                <Text style={styles.ocrButtonText}>
                  {ocrBusy ? "Reading…" : "Recognize text"}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })()}
      {/* Phase 11 — "Explain this" affordance. Shown below the selection for any
          selection (strokes / text / image / mix); tapping it sends the region to
          the AI and drops a concept/explanation/example block beside it. Stacks
          below the OCR button when that one is also visible. */}
      {explainEnabled &&
        onExplain &&
        selectionActionable &&
        selectionUnion &&
        (() => {
          const u = selectionUnion;
          const anchor = boardToScreen(viewport, {
            x: (u.minX + u.maxX) / 2,
            y: u.maxY,
          });
          // Stack below the OCR button only when it's ACTUALLY rendered —
          // `ocrEnabled` alone isn't enough: the button's own render
          // condition above also requires `onRecognizeText` (suppressed
          // during an active presentation), so keying this off the flag
          // alone left a 42px gap of dead space above "Explain this" while
          // presenting with OCR otherwise on (Fix Wave F6).
          const dy = ocrEnabled && onRecognizeText ? 52 : 10;
          return (
            <View
              style={[styles.explainButton, { left: anchor.x - 60, top: anchor.y + dy }]}
              pointerEvents="box-none"
            >
              <TouchableOpacity
                style={styles.explainButtonInner}
                onPress={onExplain}
                disabled={explainBusy}
                activeOpacity={0.85}
              >
                {explainBusy ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="bulb-outline" size={15} color="#fff" />
                )}
                <Text style={styles.explainButtonText}>
                  {explainBusy ? "Thinking…" : "Explain this"}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })()}
      {/* Month 6 — "Make flashcards" affordance. Stacks below OCR/Explain
          (whichever are visible) below the selection; tapping it generates
          front/back cards from the selection and saves them into the
          caller's own per-board deck — never the canvas. */}
      {flashcardsEnabled &&
        onMakeFlashcards &&
        selectionActionable &&
        selectionUnion &&
        (() => {
          const u = selectionUnion;
          const anchor = boardToScreen(viewport, {
            x: (u.minX + u.maxX) / 2,
            y: u.maxY,
          });
          // Same defect, second site (Fix Wave F6): key off whichever
          // buttons are ACTUALLY rendered above this one, not off the raw
          // feature flags — each of those buttons also requires its own
          // callback to render (suppressed during an active presentation).
          const dy =
            (ocrEnabled && onRecognizeText ? 52 : 0) +
            (explainEnabled && onExplain ? 52 : 0) +
            10;
          return (
            <View
              style={[styles.flashcardsButton, { left: anchor.x - 74, top: anchor.y + dy }]}
              pointerEvents="box-none"
            >
              <TouchableOpacity
                style={styles.flashcardsButtonInner}
                onPress={onMakeFlashcards}
                disabled={flashcardsBusy}
                activeOpacity={0.85}
              >
                {flashcardsBusy ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="albums-outline" size={15} color="#fff" />
                )}
                <Text style={styles.flashcardsButtonText}>
                  {flashcardsBusy ? "Generating…" : "Make flashcards"}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })()}
      {/* Phase 10 — low-confidence confirm prompt (Appendix B.7). The OCR was
          unsure, so the text is held back until the user accepts. */}
      {ocrCandidate && (() => {
        const anchor = boardToScreen(viewport, ocrCandidate.position);
        return (
          <View
            style={[styles.ocrPrompt, { left: anchor.x, top: anchor.y - 92 }]}
            pointerEvents="box-none"
          >
            <View style={styles.ocrPromptHeader}>
              <Ionicons name="alert-circle-outline" size={15} color="#b45309" />
              <Text style={styles.ocrPromptTitle}>
                Low confidence ({Math.round(ocrCandidate.confidence * 100)}%)
              </Text>
            </View>
            <Text style={styles.ocrPromptText} numberOfLines={3}>
              {ocrCandidate.text}
            </Text>
            <View style={styles.ocrPromptActions}>
              <TouchableOpacity style={styles.ocrPromptDismiss} onPress={onDismissOcr}>
                <Text style={styles.ocrPromptDismissText}>Discard</Text>
              </TouchableOpacity>
              {/* Month 5 — omitted (rather than wired to a no-op) while a
                  presentation locks content creation, so the audience isn't
                  shown a button that silently does nothing; "Discard" above
                  stays available so the prompt can still be dismissed. */}
              {onAcceptOcr && (
                <TouchableOpacity style={styles.ocrPromptAccept} onPress={onAcceptOcr}>
                  <Text style={styles.ocrPromptAcceptText}>Insert anyway</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        );
      })()}
    </>
  );
}

const styles = StyleSheet.create({
  ocrButton: {
    position: "absolute",
    zIndex: 130,
  },
  ocrButtonInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#2563eb",
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 5,
  },
  ocrButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
  },
  explainButton: {
    position: "absolute",
    zIndex: 130,
  },
  explainButtonInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#7c3aed",
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 5,
  },
  explainButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
  },
  flashcardsButton: {
    position: "absolute",
    zIndex: 130,
  },
  flashcardsButtonInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#0d9488",
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 5,
  },
  flashcardsButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
  },
  ocrPrompt: {
    position: "absolute",
    width: 220,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#fcd34d",
    padding: 10,
    borderRadius: 12,
    gap: 6,
    zIndex: 130,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 5,
  },
  ocrPromptHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  ocrPromptTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#b45309",
  },
  ocrPromptText: {
    fontSize: 13,
    color: "#374151",
  },
  ocrPromptActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 2,
  },
  ocrPromptDismiss: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#f3f4f6",
  },
  ocrPromptDismissText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6b7280",
  },
  ocrPromptAccept: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#2563eb",
  },
  ocrPromptAcceptText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#fff",
  },
});
