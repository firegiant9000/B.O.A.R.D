import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DrawingCanvas from "../../src/components/DrawingCanvas";
import Toolbar from "../../src/components/Toolbar";
import TextNoteOverlay from "../../src/components/TextNoteOverlay";
import { useAuth } from "../../src/hooks/useAuth";
import * as boardService from "../../src/services/boardService";
import * as pathService from "../../src/services/pathService";
import { Board, DrawPath, TextNote } from "../../src/types";

type Tool = "pen" | "eraser" | "text";

export default function BoardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();

  // Board state
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);

  // Drawing state
  const [paths, setPaths] = useState<DrawPath[]>([]);
  const [notes, setNotes] = useState<TextNote[]>([]);
  const [currentPoints, setCurrentPoints] = useState<
    { x: number; y: number }[] | null
  >(null);

  // Tool state
  const [activeTool, setActiveTool] = useState<Tool>("pen");
  const [activeColor, setActiveColor] = useState("#000000");
  const [activeStrokeWidth, setActiveStrokeWidth] = useState(5);

  // Text note state
  const [pendingNotePosition, setPendingNotePosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Auto-save debounce
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load board data on mount
  useEffect(() => {
    if (!id) return;
    loadBoard();
  }, [id]);

  // Clear debounced save timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [id]);

  const loadBoard = async () => {
    try {
      setLoading(true);
      const [boardData, pathsData, notesData] = await Promise.all([
        boardService.getBoard(id!),
        pathService.getBoardPaths(id!),
        pathService.getBoardNotes(id!),
      ]);
      setBoard(boardData);
      setPaths(pathsData);
      setNotes(notesData);
    } catch (err) {
      Alert.alert("Error", "Failed to load board");
    } finally {
      setLoading(false);
    }
  };

  // Debounced save — updates the board's updatedAt timestamp
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await boardService.updateBoard(id!, {});
      } catch {
        // Silent fail for timestamp update
      }
    }, 2000);
  }, [id]);

  // --- Drawing handlers ---

  const handleStrokeStart = () => {
    if (activeTool === "text") return;
    setCurrentPoints([]);
  };

  const handleStrokeMove = (point: { x: number; y: number }) => {
    if (activeTool === "text") return;
    setCurrentPoints((prev) => (prev ? [...prev, point] : [point]));
  };

  const handleStrokeEnd = async () => {
    if (activeTool === "text") return;
    if (!currentPoints || currentPoints.length === 0) {
      setCurrentPoints(null);
      return;
    }

    const newPath: Omit<DrawPath, "id" | "createdAt"> = {
      boardId: id!,
      userId: user?.uid ?? "",
      points: currentPoints,
      color: activeColor,
      strokeWidth: activeStrokeWidth,
      tool: activeTool as "pen" | "eraser",
    };

    try {
      const pathId = await pathService.savePath(id!, newPath);
      const savedPath: DrawPath = {
        ...newPath,
        id: pathId,
        createdAt: new Date(),
      };
      setPaths((prev) => [...prev, savedPath]);
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to save stroke");
    }

    setCurrentPoints(null);
  };

  // --- Canvas tap (for text tool) ---

  const handleCanvasTap = (point: { x: number; y: number }) => {
    if (activeTool === "text") {
      setPendingNotePosition(point);
    }
  };

  // --- Text note handlers ---

  const handleSubmitNote = async (content: string) => {
    if (!pendingNotePosition) return;

    const newNote: Omit<TextNote, "id" | "createdAt"> = {
      boardId: id!,
      userId: user?.uid ?? "",
      content,
      position: pendingNotePosition,
    };

    try {
      const noteId = await pathService.saveTextNote(id!, newNote);
      setNotes((prev) => [
        ...prev,
        { ...newNote, id: noteId, createdAt: new Date() },
      ]);
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to save note");
    }

    setPendingNotePosition(null);
  };

  const handleCancelNote = () => {
    setPendingNotePosition(null);
  };

  const handleDeleteNote = async (noteId: string) => {
    try {
      await pathService.deleteTextNote(id!, noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to delete note");
    }
  };

  // --- Toolbar actions ---

  const handleUndo = async () => {
    if (paths.length === 0) return;
    const lastPath = paths[paths.length - 1];
    try {
      await pathService.deletePath(id!, lastPath.id);
      setPaths((prev) => prev.slice(0, -1));
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to undo");
    }
  };

  const handleClear = async () => {
    try {
      await Promise.all([
        pathService.clearBoardPaths(id!),
        pathService.clearBoardNotes(id!),
      ]);
      setPaths([]);
      setNotes([]);
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to clear board");
    }
  };

  const handleSave = async () => {
    try {
      await boardService.updateBoard(id!, {});
      Alert.alert("Saved", "Board saved successfully");
    } catch {
      Alert.alert("Error", "Failed to save board");
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color="#333" />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {board?.title ?? "Board"}
        </Text>
        <TouchableOpacity
          onPress={() => router.push(`/session/create?boardId=${id}`)}
          style={styles.backBtn}
        >
          <Ionicons name="calendar-outline" size={24} color="#333" />
        </TouchableOpacity>
      </View>

      {/* Canvas + Notes layer */}
      <View style={styles.canvasContainer}>
        <DrawingCanvas
          paths={paths}
          currentPath={currentPoints}
          color={activeColor}
          strokeWidth={activeStrokeWidth}
          tool={activeTool === "text" ? "pen" : activeTool}
          onStrokeStart={handleStrokeStart}
          onStrokeMove={handleStrokeMove}
          onStrokeEnd={handleStrokeEnd}
          onCanvasTap={handleCanvasTap}
        />
        <TextNoteOverlay
          notes={notes}
          pendingNotePosition={pendingNotePosition}
          onSubmitNote={handleSubmitNote}
          onCancelNote={handleCancelNote}
          onDeleteNote={handleDeleteNote}
        />
      </View>

      {/* Toolbar */}
      <Toolbar
        activeTool={activeTool}
        activeColor={activeColor}
        activeStrokeWidth={activeStrokeWidth}
        onToolChange={setActiveTool}
        onColorChange={setActiveColor}
        onStrokeWidthChange={setActiveStrokeWidth}
        onUndo={handleUndo}
        onClear={handleClear}
        onSave={handleSave}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  backBtn: {
    padding: 4,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    textAlign: "center",
    marginHorizontal: 12,
  },
  canvasContainer: {
    flex: 1,
  },
});
