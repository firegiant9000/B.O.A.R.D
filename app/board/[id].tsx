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
  Share,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DrawingCanvas from "../../src/components/DrawingCanvas";
import Toolbar from "../../src/components/Toolbar";
import TextNoteOverlay from "../../src/components/TextNoteOverlay";
import TextElementView from "../../src/components/TextElementView";
import MemberList from "../../src/components/MemberList";
import JoinBoardModal from "../../src/components/JoinBoardModal";
import { useAuth } from "../../src/hooks/useAuth";
import * as boardService from "../../src/services/boardService";
import * as pathService from "../../src/services/pathService";
import { Board, DrawPath, TextNote, TextElement } from "../../src/types";

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

  // Text element state
  const [textElements, setTextElements] = useState<TextElement[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  // Tool state
  const [activeTool, setActiveTool] = useState<Tool>("pen");
  const [activeColor, setActiveColor] = useState("#000000");
  const [activeStrokeWidth, setActiveStrokeWidth] = useState(5);

  // Text note state (legacy sticky notes — kept for backwards compat)
  const [pendingNotePosition, setPendingNotePosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Deep-link join modal
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [deepLinkCode, setDeepLinkCode] = useState<string | undefined>();

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
      const [boardData, pathsData, notesData, textElementsData] = await Promise.all([
        boardService.getBoard(id!),
        pathService.getBoardPaths(id!),
        pathService.getBoardNotes(id!),
        pathService.getBoardTextElements(id!),
      ]);
      if (!boardData) {
        Alert.alert("Board not found", "This board may have been deleted.", [
          { text: "OK", onPress: () => router.back() },
        ]);
        return;
      }
      setBoard(boardData);
      setPaths(pathsData);
      setNotes(notesData);
      setTextElements(textElementsData);

      // Deep-link gate: if the viewer isn't a member yet, prompt them to join
      if (boardData && user && !boardData.members.includes(user.uid)) {
        setDeepLinkCode(boardData.inviteCode);
        setJoinModalVisible(true);
      }
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

  // --- Share action ---

  const handleShare = async () => {
    const deepLink = `boardapp://board/${id}`;
    const inviteCode = board?.inviteCode ?? "";

    // Web: navigator.share requires HTTPS which isn't available in dev.
    // Show the invite code in an alert so users can copy it manually.
    if (Platform.OS === "web") {
      Alert.alert(
        "Share Board",
        `Invite code: ${inviteCode}\n\nOr share this link:\n${deepLink}`
      );
      return;
    }

    try {
      await Share.share({
        message: `Join my board "${board?.title ?? "Board"}" on B.O.A.R.D!\nInvite code: ${inviteCode}\n\n${deepLink}`,
        url: deepLink,
      });
    } catch {
      // User dismissed the share sheet — no action needed
    }
  };

  // --- Deep-link join callback ---

  const handleDeepLinkJoined = () => {
    setJoinModalVisible(false);
    setDeepLinkCode(undefined);
    // Reload so the members array and content reflect the new membership
    loadBoard();
  };

  const handleDeepLinkCancel = () => {
    setJoinModalVisible(false);
    setDeepLinkCode(undefined);
    router.back();
  };

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

  // --- Canvas tap ---

  const handleCanvasTap = (point: { x: number; y: number }) => {
    if (activeTool === "text") {
      if (selectedTextId || editingTextId) {
        // First tap on blank canvas deselects the active element
        setSelectedTextId(null);
        setEditingTextId(null);
      } else {
        handleCreateTextElement(point);
      }
    }
  };

  // --- Text element handlers ---

  const handleCreateTextElement = async (point: { x: number; y: number }) => {
    const newEl: Omit<TextElement, "id" | "createdAt"> = {
      boardId: id!,
      userId: user?.uid ?? "",
      text: "",
      position: { x: Math.max(4, point.x - 75), y: Math.max(4, point.y - 20) },
      width: 160,
      height: 52,
      fontSize: 20,
      color: activeColor,
    };
    try {
      const elId = await pathService.saveTextElement(id!, newEl);
      const saved: TextElement = { ...newEl, id: elId, createdAt: new Date() };
      setTextElements((prev) => [...prev, saved]);
      setSelectedTextId(elId);
      setEditingTextId(elId);
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to create text element");
    }
  };

  const handleTextSelect = (elementId: string) => {
    setSelectedTextId(elementId);
    setEditingTextId(elementId);
  };

  const handleTextBlur = async (elementId: string, text: string) => {
    setEditingTextId(null);
    setSelectedTextId(null);
    try {
      await pathService.updateTextElement(id!, elementId, { text });
      setTextElements((prev) =>
        prev.map((el) => (el.id === elementId ? { ...el, text } : el))
      );
      scheduleSave();
    } catch {
      // Silent — text is already in local state
    }
  };

  const handleTextResize = async (
    elementId: string,
    width: number,
    height: number,
    fontSize: number
  ) => {
    try {
      await pathService.updateTextElement(id!, elementId, { width, height, fontSize });
      setTextElements((prev) =>
        prev.map((el) =>
          el.id === elementId ? { ...el, width, height, fontSize } : el
        )
      );
      scheduleSave();
    } catch {
      // Silent
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
        pathService.clearBoardTextElements(id!),
      ]);
      setPaths([]);
      setNotes([]);
      setTextElements([]);
      setSelectedTextId(null);
      setEditingTextId(null);
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to clear board");
    }
  };

  const handleColorChange = async (color: string) => {
    setActiveColor(color);
    if (selectedTextId) {
      try {
        await pathService.updateTextElement(id!, selectedTextId, { color });
        setTextElements((prev) =>
          prev.map((el) => (el.id === selectedTextId ? { ...el, color } : el))
        );
      } catch {
        // Silent
      }
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
      <JoinBoardModal
        visible={joinModalVisible}
        initialCode={deepLinkCode}
        onClose={handleDeepLinkCancel}
        onJoined={handleDeepLinkJoined}
      />

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
        <MemberList
          boardId={id!}
          memberUids={board?.members ?? []}
          currentUserId={user?.uid}
        />
        <TouchableOpacity
          onPress={() => router.push(`/session/create?boardId=${id}`)}
          style={styles.backBtn}
        >
          <Ionicons name="calendar-outline" size={24} color="#333" />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleShare}
          style={styles.shareBtn}
          hitSlop={8}
        >
          <Ionicons name="share-outline" size={22} color="#2563eb" />
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
        {/* Text elements overlay — box-none so blank areas pass touches to canvas */}
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {textElements.map((el) => (
            <TextElementView
              key={el.id}
              element={el}
              isSelected={selectedTextId === el.id}
              isEditing={editingTextId === el.id}
              onSelect={handleTextSelect}
              onBlur={handleTextBlur}
              onResize={handleTextResize}
            />
          ))}
        </View>
      </View>

      {/* Toolbar */}
      <Toolbar
        activeTool={activeTool}
        activeColor={activeColor}
        activeStrokeWidth={activeStrokeWidth}
        onToolChange={setActiveTool}
        onColorChange={handleColorChange}
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
  shareBtn: {
    padding: 4,
    marginLeft: 8,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    textAlign: "left",
    marginHorizontal: 12,
  },
  canvasContainer: {
    flex: 1,
  },
});
