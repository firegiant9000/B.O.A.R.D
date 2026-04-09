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
import BoardUserBar from "../../src/components/BoardUserBar";
import StartSessionModal from "../../src/components/StartSessionModal";
import { useAuth } from "../../src/hooks/useAuth";
import * as boardService from "../../src/services/boardService";
import * as pathService from "../../src/services/pathService";
import * as presenceService from "../../src/services/presenceService";
import * as friendService from "../../src/services/friendService";
import { Board, BoardPresence, DrawPath, TextNote, TextElement } from "../../src/types";

type Tool = "pen" | "eraser" | "text";

export default function BoardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user, userProfile } = useAuth();

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

  // Text note state
  const [pendingNotePosition, setPendingNotePosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Presence & friends state
  const [presence, setPresence] = useState<BoardPresence[]>([]);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);

  // Deep-link join modal
  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [deepLinkCode, setDeepLinkCode] = useState<string | undefined>();

  // Session modal
  const [sessionModalVisible, setSessionModalVisible] = useState(false);

  // Auto-save debounce
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derived
  const isAdmin = !!user && !!board && user.uid === board.adminId;

  // Load board data on mount
  useEffect(() => {
    if (!id) return;
    loadBoard();
  }, [id]);

  // Presence: join on mount, subscribe to updates, leave on unmount
  useEffect(() => {
    if (!id || !user) return;

    const displayName = userProfile?.displayName ?? user.email ?? "User";
    const email = userProfile?.email ?? user.email ?? "";

    presenceService.joinBoard(id, user.uid, displayName, email).catch(() => {});

    const unsubscribe = presenceService.subscribeToBoardPresence(id, setPresence);

    return () => {
      unsubscribe();
      presenceService.leaveBoard(id, user.uid).catch(() => {});
    };
  }, [id, user]);

  // Load blocked IDs on mount
  useEffect(() => {
    if (!user) return;
    friendService.getBlockedIds(user.uid).then(setBlockedIds).catch(() => {});
  }, [user]);

  // Clear debounce timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

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
        Alert.alert("Not Found", "This board no longer exists.");
        router.back();
        return;
      }

      setBoard(boardData);
      setPaths(pathsData);
      setNotes(notesData);
      setTextElements(textElementsData);

      // Deep-link gate: if the viewer isn't a member yet, prompt them to join
      if (user && !boardData.members.includes(user.uid)) {
        setDeepLinkCode(boardData.inviteCode);
        setJoinModalVisible(true);
      }
    } catch {
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
      // User dismissed the share sheet
    }
  };

  // --- Deep-link join callback ---

  const handleDeepLinkJoined = () => {
    setJoinModalVisible(false);
    setDeepLinkCode(undefined);
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
    const targetPath = isAdmin
      ? paths[paths.length - 1]
      : [...paths].reverse().find((p) => p.userId === user?.uid);
    if (!targetPath) return;
    try {
      await pathService.deletePath(id!, targetPath.id);
      setPaths((prev) => prev.filter((p) => p.id !== targetPath.id));
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

  const handleColorChange = (color: string) => {
    setActiveColor(color);
    if (selectedTextId) {
      pathService.updateTextElement(id!, selectedTextId, { color }).catch(() => {});
      setTextElements((prev) =>
        prev.map((el) => (el.id === selectedTextId ? { ...el, color } : el))
      );
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

  // --- Blocked user handler ---

  const handleBlockUser = (userId: string) => {
    setBlockedIds((prev) => [...prev, userId]);
  };

  // Filter out blocked users' content
  const visiblePaths = paths.filter((p) => !blockedIds.includes(p.userId));
  const visibleNotes = notes.filter((n) => !blockedIds.includes(n.userId));
  const visibleTextElements = textElements.filter((el) => !blockedIds.includes(el.userId));

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  const currentUserInfo = {
    uid: user?.uid ?? "",
    displayName: userProfile?.displayName ?? user?.email ?? "User",
    email: userProfile?.email ?? user?.email ?? "",
  };

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

        <View style={styles.headerRight}>
          <MemberList
            boardId={id!}
            memberUids={board?.members ?? []}
            currentUserId={user?.uid}
          />
          <BoardUserBar
            presence={presence}
            boardTitle={board?.title ?? "Board"}
            currentUser={currentUserInfo}
            blockedIds={blockedIds}
            onBlock={handleBlockUser}
          />
          <TouchableOpacity
            onPress={handleShare}
            style={styles.iconBtn}
            hitSlop={8}
          >
            <Ionicons name="share-outline" size={22} color="#2563eb" />
          </TouchableOpacity>
          {isAdmin && (
            <>
              <TouchableOpacity
                style={styles.startSessionBtn}
                onPress={() => setSessionModalVisible(true)}
              >
                <Ionicons name="play-circle-outline" size={16} color="#fff" />
                <Text style={styles.startSessionText}>Session</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={() =>
                  Alert.alert(
                    "Board Admin",
                    "You are the admin of this board. You can delete any user's notes and clear the entire board.",
                    [{ text: "OK" }]
                  )
                }
              >
                <Ionicons name="shield-checkmark" size={20} color="#2563eb" />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {/* Canvas + Notes + Text Elements */}
      <View style={styles.canvasContainer}>
        <DrawingCanvas
          paths={visiblePaths}
          currentPath={currentPoints}
          color={activeColor}
          strokeWidth={activeStrokeWidth}
          tool={activeTool === "text" ? "pen" : activeTool}
          onStrokeStart={handleStrokeStart}
          onStrokeMove={handleStrokeMove}
          onStrokeEnd={handleStrokeEnd}
          onCanvasTap={handleCanvasTap}
          disabled={activeTool === "text"}
        />
        <TextNoteOverlay
          notes={visibleNotes}
          pendingNotePosition={pendingNotePosition}
          currentUserId={user?.uid ?? ""}
          isAdmin={isAdmin}
          onSubmitNote={handleSubmitNote}
          onCancelNote={handleCancelNote}
          onDeleteNote={handleDeleteNote}
        />
        {/* Text elements overlay */}
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {visibleTextElements.map((el) => (
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
        isAdmin={isAdmin}
        onToolChange={setActiveTool}
        onColorChange={handleColorChange}
        onStrokeWidthChange={setActiveStrokeWidth}
        onUndo={handleUndo}
        onClear={handleClear}
        onSave={handleSave}
      />

      {isAdmin && (
        <StartSessionModal
          visible={sessionModalVisible}
          boardId={id!}
          boardTitle={board?.title ?? "Board"}
          adminId={user?.uid ?? ""}
          adminName={currentUserInfo.displayName}
          presenceUsers={presence}
          onClose={() => setSessionModalVisible(false)}
          onSessionCreated={() => setSessionModalVisible(false)}
        />
      )}
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
    marginRight: 4,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    marginHorizontal: 8,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 32,
    justifyContent: "flex-end",
  },
  iconBtn: {
    padding: 4,
  },
  startSessionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#2563eb",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  startSessionText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  canvasContainer: {
    flex: 1,
  },
});
