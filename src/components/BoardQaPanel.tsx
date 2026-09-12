import React, { useCallback, useRef, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Platform,
  Pressable,
  KeyboardAvoidingView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  askBoard,
  citationKind,
  type BoardQaCitation,
  type BoardQaTurn,
} from "../services/boardQaService";
import { resourceExhaustedReason } from "../services/quotaService";

/**
 * Month 6 — board Q&A. A chat panel scoped to one board: ask a question, get an
 * answer drawn from the board's own content, with the elements it came from
 * offered as chips you can tap to go and look at them.
 *
 * THE CITATIONS ARE THE FEATURE, not an ornament. The roadmap's mitigation for
 * a model inventing board content is that every answer names the element ids it
 * used and the reader can click through and check. That only works if a chip
 * either lands on a real element or visibly says it cannot — see
 * `citationState` below.
 *
 * THE THREAD LIVES HERE, in component state, and is replayed to the server on
 * each turn so a follow-up resolves. It is deliberately NOT persisted to
 * Firestore: a per-board chat collection would be a new client-writable
 * surface, with its own rules and its own rules tests, and nothing in this
 * feature needs a question to outlive the panel. The cost is that closing the
 * panel forgets the conversation, which is the right trade for now and is
 * called out rather than hidden.
 *
 * Everything that actually enforces anything is server-side: membership, the
 * rate bucket and the plan cap are all the callable's, and this component only
 * renders what it is told. The one branch here that looks like a gate —
 * routing a `plan-quota` denial to the upsell — is reacting to a denial that
 * already happened, not preventing one.
 */

/** One rendered turn. `citations` is only ever set on an assistant turn. */
export interface BoardQaMessage {
  role: "user" | "assistant";
  text: string;
  citations?: BoardQaCitation[];
}

/** What a citation chip can be. `live` is tappable; the other two are not, and
 *  say why. */
export type CitationState = "live" | "deleted" | "unresolvable";

/**
 * Decides how one citation renders.
 *
 * The `deleted` case is real and has to be visible. The server drops a
 * candidate whose element is already gone, but deletion cleanup is eventually
 * consistent and the element can also be deleted in the seconds between the
 * answer arriving and someone tapping a chip. A chip that silently does nothing
 * in that window is exactly the failure the whole cleanup path exists to
 * prevent — to the person tapping it, an unresolvable citation and a fabricated
 * one look the same. So it says the element was deleted, which is true,
 * checkable, and tells them the answer was grounded in something that used to
 * be there.
 *
 * `unresolvable` covers an element kind this build cannot map to a canvas kind
 * (a newly-indexed type shipped ahead of the client). Also not tappable, for
 * the same reason: better a chip that admits it cannot navigate than one that
 * guesses and selects the wrong element.
 *
 * Exported for direct testing — it is the whole of the citation-liveness
 * decision, and it is small enough that burying it in JSX would make it
 * untestable for no gain.
 */
export function citationState(
  citation: BoardQaCitation,
  isCitationLive?: (elementId: string, canvasKind: string) => boolean
): CitationState {
  const kind = citationKind(citation.elementType);
  if (!kind) return "unresolvable";
  // No resolver supplied (the panel rendered outside a board screen): assume
  // live rather than marking every citation deleted, which would be a louder
  // and more misleading lie than the one it avoids.
  if (!isCitationLive) return "live";
  return isCitationLive(citation.elementId, kind) ? "live" : "deleted";
}

interface BoardQaPanelProps {
  visible: boolean;
  boardId: string;
  onClose: () => void;
  /**
   * Whether a cited element is still on the board. Supplied by the board
   * screen from its live element sets; receives the CANVAS kind (`text`, not
   * `textElement`) so the caller can hand it straight to its own element
   * lookup. Omitted outside a board screen — see `citationState`.
   */
  isCitationLive?: (elementId: string, canvasKind: string) => boolean;
  /** Tapping a live citation. Receives the canvas kind, like `isCitationLive`. */
  onSelectCitation?: (elementId: string, canvasKind: string) => void;
  /** The workspace is out of board questions for the period — the server said
   *  so via `details.reason`, this is not an inference. The screen routes this
   *  to the same upsell machinery as every other quota denial. */
  onQuotaExceeded: () => void;
}

const THROTTLED_MESSAGE =
  "You're asking a little fast. Wait a few seconds and try again.";

export default function BoardQaPanel({
  visible,
  boardId,
  onClose,
  isCitationLive,
  onSelectCitation,
  onQuotaExceeded,
}: BoardQaPanelProps) {
  const [messages, setMessages] = useState<BoardQaMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const handleAsk = useCallback(async () => {
    const question = draft.trim();
    if (!question || busy) return;

    // The thread as it stood BEFORE this question — the server gets the prior
    // turns, and the question itself arrives as its own field.
    const history: BoardQaTurn[] = messages.map((m) => ({ role: m.role, text: m.text }));

    setMessages((prev) => [...prev, { role: "user", text: question }]);
    setDraft("");
    setError(null);
    setBusy(true);

    try {
      const res = await askBoard(boardId, question, history);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: res.answer, citations: res.citations },
      ]);
    } catch (e: any) {
      // Route on the server's OWN reason, never on an inference from the
      // workspace's plan: a momentary throttle and an exhausted plan cap arrive
      // as the same RPC code, and showing a paywall for the first one is how a
      // free-tier user gets told to upgrade for clicking twice.
      const reason = resourceExhaustedReason(e);
      if (reason === "plan-quota") {
        onQuotaExceeded();
      } else if (reason === "rate-limit") {
        setError(THROTTLED_MESSAGE);
      } else {
        setError(e?.message ?? "Couldn't answer that question.");
      }
    } finally {
      setBusy(false);
    }
  }, [boardId, busy, draft, messages, onQuotaExceeded]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.backdrop} onPress={onClose} />

        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.iconWrap}>
              <Ionicons name="sparkles-outline" size={20} color="#2563eb" />
            </View>
            <Text style={styles.title}>Ask this board</Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={8}
              style={styles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID="board-qa-close"
            >
              <Ionicons name="close" size={22} color="#666" />
            </TouchableOpacity>
          </View>

          <ScrollView
            ref={scrollRef}
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {messages.length === 0 && (
              <Text style={styles.empty}>
                Ask a question about what's on this board. Answers cite the
                elements they came from, so you can check them.
              </Text>
            )}

            {messages.map((m, i) => (
              <View
                key={i}
                style={[styles.bubble, m.role === "user" ? styles.bubbleUser : styles.bubbleAi]}
              >
                <Text style={m.role === "user" ? styles.bubbleUserText : styles.bubbleAiText}>
                  {m.text}
                </Text>

                {m.role === "assistant" && !!m.citations?.length && (
                  <View style={styles.citations}>
                    <Text style={styles.citationsLabel}>From:</Text>
                    {m.citations.map((c) => (
                      <CitationChip
                        key={`${c.elementType}:${c.elementId}`}
                        citation={c}
                        state={citationState(c, isCitationLive)}
                        onSelect={onSelectCitation}
                      />
                    ))}
                  </View>
                )}
              </View>
            ))}

            {busy && (
              <View style={styles.thinking}>
                <ActivityIndicator size="small" color="#2563eb" />
                <Text style={styles.thinkingText}>Reading the board…</Text>
              </View>
            )}
          </ScrollView>

          {error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={14} color="#b91c1c" />
              <Text style={styles.errorText} testID="board-qa-error">
                {error}
              </Text>
            </View>
          )}

          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              placeholder="Ask about this board…"
              value={draft}
              onChangeText={setDraft}
              multiline
              editable={!busy}
              returnKeyType="send"
              blurOnSubmit
              onSubmitEditing={handleAsk}
              testID="board-qa-input"
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!draft.trim() || busy) && styles.sendBtnDisabled]}
              onPress={handleAsk}
              disabled={!draft.trim() || busy}
              accessibilityRole="button"
              accessibilityLabel="Ask"
              testID="board-qa-send"
            >
              {busy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="send" size={16} color="#fff" />
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CitationChip({
  citation,
  state,
  onSelect,
}: {
  citation: BoardQaCitation;
  state: CitationState;
  onSelect?: (elementId: string, canvasKind: string) => void;
}) {
  const kind = citationKind(citation.elementType);
  const testID = `board-qa-citation-${citation.elementId}`;

  if (state !== "live") {
    return (
      <View style={[styles.chip, styles.chipDead]} testID={testID}>
        <Ionicons name="unlink-outline" size={12} color="#b45309" />
        <Text style={styles.chipDeadText} numberOfLines={1}>
          {state === "deleted"
            ? "This element has been deleted"
            : "Can't open this element"}
        </Text>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={styles.chip}
      onPress={() => onSelect?.(citation.elementId, kind!)}
      accessibilityRole="button"
      testID={testID}
    >
      <Ionicons name="locate-outline" size={12} color="#2563eb" />
      <Text style={styles.chipText} numberOfLines={1}>
        {citation.excerpt || citation.elementId}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: Platform.OS === "ios" ? 40 : 24,
    maxHeight: "80%",
  },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  title: { flex: 1, fontSize: 18, fontWeight: "700", color: "#111" },
  closeBtn: { padding: 2 },
  scroll: { marginBottom: 10 },
  empty: { fontSize: 13, color: "#9ca3af", lineHeight: 19, paddingVertical: 8 },
  bubble: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 10 },
  bubbleUser: { backgroundColor: "#2563eb", alignSelf: "flex-end", maxWidth: "85%" },
  bubbleAi: { backgroundColor: "#f3f4f6", alignSelf: "flex-start", maxWidth: "95%" },
  bubbleUserText: { color: "#fff", fontSize: 14, lineHeight: 20 },
  bubbleAiText: { color: "#111827", fontSize: 14, lineHeight: 20 },
  citations: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#d1d5db",
    gap: 5,
  },
  citationsLabel: { fontSize: 11, fontWeight: "700", color: "#6b7280" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#eff6ff",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  chipText: { flex: 1, fontSize: 12, color: "#1d4ed8" },
  chipDead: { backgroundColor: "#fffbeb" },
  chipDeadText: { flex: 1, fontSize: 12, color: "#b45309", fontStyle: "italic" },
  thinking: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  thinkingText: { fontSize: 13, color: "#6b7280" },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fef2f2",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  errorText: { flex: 1, fontSize: 12, color: "#b91c1c" },
  composer: { flexDirection: "row", gap: 8, alignItems: "flex-end" },
  input: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    backgroundColor: "#f9fafb",
    color: "#111",
    maxHeight: 120,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnDisabled: { opacity: 0.5 },
});
