import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { TextNote } from "../types";

interface TextNoteOverlayProps {
  notes: TextNote[];
  /** If set, shows a text input at this position for creating a new note */
  pendingNotePosition: { x: number; y: number } | null;
  currentUserId: string;
  isAdmin: boolean;
  onSubmitNote: (content: string) => void;
  onCancelNote: () => void;
  onDeleteNote: (noteId: string) => void;
}

export default function TextNoteOverlay({
  notes,
  pendingNotePosition,
  currentUserId,
  isAdmin,
  onSubmitNote,
  onCancelNote,
  onDeleteNote,
}: TextNoteOverlayProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (pendingNotePosition) {
      setText("");
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [pendingNotePosition]);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (trimmed) {
      onSubmitNote(trimmed);
    } else {
      onCancelNote();
    }
    setText("");
    Keyboard.dismiss();
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Render existing notes */}
      {notes.map((note) => {
        const canDelete = isAdmin || note.userId === currentUserId;
        return (
          <View
            key={note.id}
            style={[
              styles.note,
              { left: note.position.x - 60, top: note.position.y - 20 },
              isAdmin && note.userId !== currentUserId && styles.noteOtherUser,
            ]}
          >
            <Text style={styles.noteText}>{note.content}</Text>
            {canDelete && (
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() => onDeleteNote(note.id)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close-circle" size={16} color="#FF3B30" />
              </TouchableOpacity>
            )}
          </View>
        );
      })}

      {/* Pending new note input */}
      {pendingNotePosition && (
        <View
          style={[
            styles.inputContainer,
            {
              left: Math.max(10, pendingNotePosition.x - 75),
              top: Math.max(10, pendingNotePosition.y - 20),
            },
          ]}
        >
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Type note..."
            onSubmitEditing={handleSubmit}
            onBlur={handleSubmit}
            returnKeyType="done"
            maxLength={200}
            autoFocus
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    position: "absolute",
    backgroundColor: "#FFF9C4",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    maxWidth: 200,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 4,
  },
  noteOtherUser: {
    borderWidth: 1,
    borderColor: "#FF9500",
    borderStyle: "dashed",
  },
  noteText: {
    fontSize: 14,
    color: "#333",
    flex: 1,
  },
  deleteBtn: {
    marginTop: -2,
  },
  inputContainer: {
    position: "absolute",
    backgroundColor: "#FFF9C4",
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#2563eb",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  input: {
    width: 150,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
});
