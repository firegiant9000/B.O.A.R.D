import React, { useEffect, useRef, useState } from "react";
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
import { Comment } from "../types";
import {
  MentionMember,
  tokenizeBody,
  findActiveMentionQuery,
  applyMention,
  filterMembers,
} from "../lib/mentions";

/**
 * Phase 7. The thread panel for a single comment: author + body, the reply list,
 * a reply composer, and resolve/reopen + delete actions. When `comment` is null
 * it doubles as the new-comment composer (the board screen opens it after the
 * user taps an element with the comment tool). Bottom-sheet styling mirrors
 * ShareBoardModal so the two share a visual language.
 */

function formatTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

function initial(name: string): string {
  return (name || "U").charAt(0).toUpperCase();
}

interface CommentThreadPanelProps {
  visible: boolean;
  /** The thread to show. Null ⇒ the new-comment composer. */
  comment: Comment | null;
  currentUserId: string;
  isAdmin: boolean;
  canComment: boolean;
  busy?: boolean;
  /** The anchored element no longer exists (orphaned comment). */
  detached?: boolean;
  /** Workspace members for @-mention autocomplete (Phase 10). */
  members?: MentionMember[];
  onCreate: (body: string) => void;
  onReply: (body: string) => void;
  onToggleResolve: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function CommentThreadPanel({
  visible,
  comment,
  currentUserId,
  isAdmin,
  canComment,
  busy = false,
  detached = false,
  members = [],
  onCreate,
  onReply,
  onToggleResolve,
  onDelete,
  onClose,
}: CommentThreadPanelProps) {
  const [draft, setDraft] = useState("");
  // Caret position, tracked so the @-mention autocomplete knows where the query is.
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const isNew = comment === null;
  // Reset the input whenever we switch threads / open the composer.
  const key = comment?.id ?? "__new__";
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key;
      setDraft("");
      setSelection({ start: 0, end: 0 });
    }
  }, [key]);

  // Active @-mention query at the caret and the members it matches (Phase 10). Self
  // is excluded — you can't mention yourself. The dropdown shows while a query is
  // open and there are matches.
  const activeQuery = findActiveMentionQuery(draft, selection.start);
  const suggestions =
    activeQuery !== null ? filterMembers(members, activeQuery.query, currentUserId) : [];
  const showSuggestions = canComment && members.length > 0 && suggestions.length > 0;

  const handleSelectMention = (member: MentionMember) => {
    const res = applyMention(draft, selection.start, member);
    setDraft(res.text);
    setSelection({ start: res.caret, end: res.caret });
  };

  const handleSubmit = () => {
    const body = draft.trim();
    if (!body) return;
    if (isNew) onCreate(body);
    else onReply(body);
    setDraft("");
    setSelection({ start: 0, end: 0 });
  };

  const canDelete = comment && (isAdmin || comment.authorId === currentUserId);

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
              <Ionicons name="chatbubble-ellipses-outline" size={20} color="#2563eb" />
            </View>
            <Text style={styles.title}>{isNew ? "New comment" : "Comment"}</Text>
            {comment && (
              <TouchableOpacity
                onPress={onToggleResolve}
                disabled={busy || !canComment}
                style={[styles.resolveBtn, comment.resolved && styles.resolveBtnActive]}
                hitSlop={6}
              >
                <Ionicons
                  name={comment.resolved ? "refresh-outline" : "checkmark-done-outline"}
                  size={15}
                  color={comment.resolved ? "#6b7280" : "#16a34a"}
                />
                <Text style={[styles.resolveText, comment.resolved && styles.resolveTextActive]}>
                  {comment.resolved ? "Reopen" : "Resolve"}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color="#666" />
            </TouchableOpacity>
          </View>

          {detached && !isNew && (
            <View style={styles.detachedBanner}>
              <Ionicons name="unlink-outline" size={14} color="#b45309" />
              <Text style={styles.detachedText}>
                The element this comment was anchored to was deleted.
              </Text>
            </View>
          )}

          {!isNew && comment && (
            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
              {/* Root comment */}
              <Bubble
                name={comment.authorName}
                body={comment.body}
                timeMs={comment.createdAt.getTime()}
                mine={comment.authorId === currentUserId}
              />
              {/* Replies */}
              {comment.replies.map((r) => (
                <Bubble
                  key={r.id}
                  name={r.authorName}
                  body={r.body}
                  timeMs={r.createdAtMs}
                  mine={r.authorId === currentUserId}
                />
              ))}
              {comment.replies.length === 0 && (
                <Text style={styles.emptyReplies}>No replies yet.</Text>
              )}
            </ScrollView>
          )}

          {/* Composer: a new comment body, or a reply. Hidden for read-only viewers
              (the rules also deny the write server-side). */}
          {canComment ? (
            <View>
              {/* @-mention autocomplete (Phase 10). Sits above the composer; tapping
                  a member inserts a structured token at the caret. */}
              {showSuggestions && (
                <View style={styles.suggestions}>
                  {suggestions.map((m) => (
                    <TouchableOpacity
                      key={m.uid}
                      style={styles.suggestionRow}
                      onPress={() => handleSelectMention(m)}
                    >
                      <View style={styles.suggestionAvatar}>
                        <Text style={styles.suggestionAvatarText}>{initial(m.displayName)}</Text>
                      </View>
                      <Text style={styles.suggestionName} numberOfLines={1}>
                        {m.displayName}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <View style={styles.composer}>
                <TextInput
                  style={styles.input}
                  placeholder={isNew ? "Add a comment… use @ to mention" : "Reply… use @ to mention"}
                  value={draft}
                  onChangeText={setDraft}
                  selection={selection}
                  onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
                  multiline
                  editable={!busy}
                  returnKeyType="send"
                  blurOnSubmit
                  onSubmitEditing={handleSubmit}
                />
                <TouchableOpacity
                  style={[styles.sendBtn, (!draft.trim() || busy) && styles.sendBtnDisabled]}
                  onPress={handleSubmit}
                  disabled={!draft.trim() || busy}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons name="send" size={16} color="#fff" />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <Text style={styles.readOnlyNote}>You have view-only access to this board.</Text>
          )}

          {canDelete && (
            <TouchableOpacity onPress={onDelete} disabled={busy} style={styles.deleteRow} hitSlop={6}>
              <Ionicons name="trash-outline" size={15} color="#ef4444" />
              <Text style={styles.deleteText}>Delete comment</Text>
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Bubble({
  name,
  body,
  timeMs,
  mine,
}: {
  name: string;
  body: string;
  timeMs: number;
  mine: boolean;
}) {
  return (
    <View style={styles.bubbleRow}>
      <View style={[styles.avatar, mine && styles.avatarMine]}>
        <Text style={styles.avatarText}>{initial(name)}</Text>
      </View>
      <View style={styles.bubbleBody}>
        <View style={styles.bubbleHeader}>
          <Text style={styles.bubbleName} numberOfLines={1}>
            {name}
            {mine ? " (you)" : ""}
          </Text>
          <Text style={styles.bubbleTime}>{formatTime(timeMs)}</Text>
        </View>
        <Text style={styles.bubbleText}>
          {tokenizeBody(body).map((seg, i) =>
            seg.type === "mention" ? (
              <Text key={i} style={styles.mention}>
                @{seg.displayName}
              </Text>
            ) : (
              <Text key={i}>{seg.text}</Text>
            )
          )}
        </Text>
      </View>
    </View>
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
  resolveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "#f0fdf4",
    marginRight: 8,
  },
  resolveBtnActive: { backgroundColor: "#f3f4f6" },
  resolveText: { fontSize: 12, fontWeight: "700", color: "#16a34a" },
  resolveTextActive: { color: "#6b7280" },
  closeBtn: { padding: 2 },
  detachedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fffbeb",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  detachedText: { flex: 1, fontSize: 12, color: "#b45309" },
  scroll: { marginBottom: 12 },
  bubbleRow: { flexDirection: "row", marginBottom: 14 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#6b7280",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  avatarMine: { backgroundColor: "#2563eb" },
  avatarText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  bubbleBody: { flex: 1 },
  bubbleHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  bubbleName: { flex: 1, fontSize: 14, fontWeight: "600", color: "#111827" },
  bubbleTime: { fontSize: 11, color: "#9ca3af" },
  bubbleText: { fontSize: 14, color: "#374151", lineHeight: 20 },
  mention: { color: "#2563eb", fontWeight: "600" },
  emptyReplies: { fontSize: 13, color: "#9ca3af", marginBottom: 8 },
  suggestions: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    backgroundColor: "#fff",
    marginBottom: 8,
    overflow: "hidden",
  },
  suggestionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f1f5f9",
  },
  suggestionAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
  },
  suggestionAvatarText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  suggestionName: { flex: 1, fontSize: 14, color: "#111827", fontWeight: "500" },
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
  readOnlyNote: { fontSize: 13, color: "#9ca3af", textAlign: "center", paddingVertical: 10 },
  deleteRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#eef0f3",
  },
  deleteText: { fontSize: 13, fontWeight: "600", color: "#ef4444" },
});
