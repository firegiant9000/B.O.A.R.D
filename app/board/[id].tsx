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
  Animated,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DrawingCanvas from "../../src/components/DrawingCanvas";
import Toolbar from "../../src/components/Toolbar";
import TextNoteOverlay from "../../src/components/TextNoteOverlay";
import TextElementView from "../../src/components/TextElementView";
import MemberList from "../../src/components/MemberList";
import JoinBoardModal from "../../src/components/JoinBoardModal";
import ShareBoardModal from "../../src/components/ShareBoardModal";
import BoardUserBar from "../../src/components/BoardUserBar";
import StartSessionModal from "../../src/components/StartSessionModal";
import { useAuth } from "../../src/hooks/useAuth";
import * as boardService from "../../src/services/boardService";
import * as pathService from "../../src/services/pathService";
import * as presenceService from "../../src/services/presenceService";
import * as friendService from "../../src/services/friendService";
import * as sessionService from "../../src/services/sessionService";
import { captureSvgAsPng } from "../../src/utils/canvasCapture";
import { captureException } from "../../src/lib/errorReporting";
import { Board, BoardPresence, DrawPath, Session, TextNote, TextElement } from "../../src/types";

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

  // Text note state (legacy sticky notes — kept for backwards compat)
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

  // Active admin-owned session for this board (drives End Session button)
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [endingSession, setEndingSession] = useState(false);

  // Ref to the underlying SVG element on web, for canvas snapshot capture
  const canvasSvgRef = useRef<any>(null);

  // Share modal
  const [shareBoardModalVisible, setShareBoardModalVisible] = useState(false);

  // Redo stack — stores path data to re-save on redo
  const [redoStack, setRedoStack] = useState<Omit<DrawPath, "id" | "createdAt">[]>([]);

  // Canvas ready — true after the first Firestore snapshot arrives
  const [canvasReady, setCanvasReady] = useState(false);

  // Dismissible error banner
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Canvas layout size for clamping text element creation position
  const [canvasSize, setCanvasSize] = useState({ width: 300, height: 500 });

  // Save toast animation
  const saveOpacity = useRef(new Animated.Value(0)).current;

  // Auto-save debounce
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref so the text-element snapshot callback always sees the current editing ID
  const editingTextIdRef = useRef<string | null>(null);

  // Derived
  const isAdmin = !!user && !!board && user.uid === board.adminId;

  // Safe navigation: fall back to Boards tab when there is no history to pop
  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/(tabs)");
    }
  };

  // Keep editingTextIdRef in sync for use inside snapshot callbacks
  useEffect(() => {
    editingTextIdRef.current = editingTextId;
  }, [editingTextId]);

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

    presenceService
      .joinBoard(id, user.uid, displayName, email)
      .catch((e) => captureException(e, { op: "board.joinPresence" }));

    const unsubscribe = presenceService.subscribeToBoardPresence(id, setPresence);

    return () => {
      unsubscribe();
      presenceService
        .leaveBoard(id, user.uid)
        .catch((e) => captureException(e, { op: "board.leavePresence" }));
    };
  }, [id, user]);

  // Load blocked IDs on mount
  useEffect(() => {
    if (!user) return;
    friendService
      .getBlockedIds(user.uid)
      .then(setBlockedIds)
      .catch((e) => captureException(e, { op: "board.getBlockedIds" }));
  }, [user]);

  // Real-time subscriptions for board content
  useEffect(() => {
    if (!id) return;
    return pathService.subscribeToBoardPaths(id, (incoming) => {
      setPaths(incoming);
      setCanvasReady(true);
    });
  }, [id]);

  useEffect(() => {
    if (!id) return;
    return pathService.subscribeToBoardNotes(id, setNotes);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    return pathService.subscribeToBoardTextElements(id, (incoming) => {
      // Don't overwrite a text element the local user is actively typing in
      setTextElements((prev) => {
        if (!editingTextIdRef.current) return incoming;
        return incoming.map((el) =>
          el.id === editingTextIdRef.current
            ? (prev.find((p) => p.id === editingTextIdRef.current) ?? el)
            : el
        );
      });
    });
  }, [id]);

  // Clear debounce timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const loadBoard = async () => {
    try {
      setLoading(true);
      const boardData = await boardService.getBoard(id!);

      if (!boardData) {
        Alert.alert("Not Found", "This board no longer exists.");
        goBack();
        return;
      }

      setBoard(boardData);

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

  // Find an admin-owned active session for this board.
  // Use the user-scoped query (rules-compatible) and filter client-side by board.
  const refreshActiveSession = useCallback(async () => {
    if (!id || !user) return;
    try {
      const sessions = await sessionService.getSessionsForUser(user.uid);
      const mine = sessions.find(
        (s) =>
          s.boardId === id &&
          s.status === "active" &&
          s.createdById === user.uid
      );
      setActiveSession(mine ?? null);
    } catch (err) {
      console.warn("[board] refreshActiveSession failed:", err);
    }
  }, [id, user]);

  useEffect(() => {
    refreshActiveSession();
  }, [refreshActiveSession]);

  const handleEndSession = async () => {
    if (!activeSession) return;
    setEndingSession(true);
    try {
      let svgEl: SVGSVGElement | null = null;
      const ref: any = canvasSvgRef.current;
      if (ref) {
        // react-native-svg on web exposes the DOM node in different shapes by version
        if (ref.tagName === "svg") svgEl = ref;
        else if (ref.elementRef?.current?.tagName === "svg")
          svgEl = ref.elementRef.current;
        else if (ref._touchableNode?.tagName === "svg") svgEl = ref._touchableNode;
        else if (typeof ref.querySelector === "function")
          svgEl = ref.querySelector("svg");
      }
      if (!svgEl && Platform.OS === "web" && typeof document !== "undefined") {
        // Last-ditch: there should only be one SVG inside the canvas container
        svgEl = document.querySelector(
          ".canvas-container svg, [data-canvas] svg, svg"
        ) as SVGSVGElement | null;
      }
      const snapshot = await captureSvgAsPng(svgEl);
      console.log(
        "[end-session] svgEl=",
        svgEl?.tagName,
        "snapshot=",
        snapshot ? `${Math.round(snapshot.length / 1024)}KB` : "null"
      );
      if (snapshot) {
        try {
          await sessionService.updateSessionSnapshot(activeSession.id, snapshot);
          console.log("[end-session] snapshot saved to", activeSession.id);
        } catch (err) {
          console.warn("[end-session] snapshot upload failed:", err);
        }
      }
      await sessionService.updateSessionStatus(activeSession.id, "ended");
      setActiveSession(null);
      showSaveToast();
    } catch {
      setErrorMessage("Failed to end session.");
    } finally {
      setEndingSession(false);
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

  const handleShare = () => {
    setShareBoardModalVisible(true);
  };

  const handleMemberAdded = (uid: string) => {
    if (uid && board) {
      setBoard((prev) =>
        prev ? { ...prev, members: [...new Set([...prev.members, uid])] } : prev
      );
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
    goBack();
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
      await pathService.savePath(id!, newPath);
      setRedoStack([]);
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
    const DEFAULT_EL_WIDTH = 160;
    const DEFAULT_EL_HEIGHT = 52;
    const newEl: Omit<TextElement, "id" | "createdAt"> = {
      boardId: id!,
      userId: user?.uid ?? "",
      text: "",
      position: {
        x: Math.max(4, Math.min(point.x - 75, canvasSize.width - DEFAULT_EL_WIDTH - 4)),
        y: Math.max(4, Math.min(point.y - 20, canvasSize.height - DEFAULT_EL_HEIGHT - 4)),
      },
      width: DEFAULT_EL_WIDTH,
      height: DEFAULT_EL_HEIGHT,
      fontSize: 20,
      color: activeColor,
    };
    try {
      const elId = await pathService.saveTextElement(id!, newEl);
      setSelectedTextId(elId);
      setEditingTextId(elId);
      scheduleSave();
    } catch {
      setErrorMessage("Failed to create text element.");
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
      setErrorMessage("Text save failed — changes may not persist.");
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
      setErrorMessage("Resize save failed.");
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
      await pathService.saveTextNote(id!, newNote);
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
      const { id: _id, createdAt: _createdAt, ...redoEntry } = targetPath;
      setRedoStack((prev) => [...prev, redoEntry]);
      scheduleSave();
    } catch {
      setErrorMessage("Undo failed.");
    }
  };

  const handleRedo = async () => {
    if (redoStack.length === 0) return;
    const redoEntry = redoStack[redoStack.length - 1];
    try {
      await pathService.savePath(id!, redoEntry);
      setRedoStack((prev) => prev.slice(0, -1));
      scheduleSave();
    } catch {
      setErrorMessage("Redo failed.");
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
      setRedoStack([]);
      scheduleSave();
    } catch {
      Alert.alert("Error", "Failed to clear board");
    }
  };

  const handleColorChange = (color: string) => {
    setActiveColor(color);
    if (selectedTextId) {
      pathService.updateTextElement(id!, selectedTextId, { color }).catch(() => setErrorMessage("Color update failed."));
      setTextElements((prev) =>
        prev.map((el) => (el.id === selectedTextId ? { ...el, color } : el))
      );
    }
  };

  const showSaveToast = () => {
    saveOpacity.setValue(1);
    Animated.timing(saveOpacity, {
      toValue: 0,
      duration: 1500,
      delay: 800,
      useNativeDriver: true,
    }).start();
  };

  const handleSave = async () => {
    try {
      await boardService.updateBoard(id!, {});
      showSaveToast();
    } catch {
      setErrorMessage("Failed to save board.");
    }
  };

  const handleTextDelete = async (elementId: string) => {
    try {
      await pathService.deleteTextElement(id!, elementId);
      setTextElements((prev) => prev.filter((el) => el.id !== elementId));
      setSelectedTextId(null);
      setEditingTextId(null);
      scheduleSave();
    } catch {
      setErrorMessage("Failed to delete text element.");
    }
  };

  // --- Blocked user handler ---

  const handleBlockUser = (userId: string) => {
    setBlockedIds((prev) => [...prev, userId]);
  };

  const handleAdminChanged = (newAdminId: string) => {
    setBoard((prev) => (prev ? { ...prev, adminId: newAdminId } : prev));
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

      <ShareBoardModal
        visible={shareBoardModalVisible}
        boardId={id!}
        inviteCode={board?.inviteCode ?? ""}
        members={board?.members ?? []}
        currentUserId={user?.uid ?? ""}
        onClose={() => setShareBoardModalVisible(false)}
        onMemberAdded={handleMemberAdded}
      />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={goBack}
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
            ownerId={board?.ownerId}
            adminId={board?.adminId}
            boardId={id}
            onAdminChanged={handleAdminChanged}
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
              {activeSession ? (
                <TouchableOpacity
                  style={styles.endSessionBtn}
                  onPress={handleEndSession}
                  disabled={endingSession}
                >
                  {endingSession ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons name="stop-circle-outline" size={16} color="#fff" />
                  )}
                  <Text style={styles.startSessionText}>End Session</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.startSessionBtn}
                  onPress={() => setSessionModalVisible(true)}
                >
                  <Ionicons name="play-circle-outline" size={16} color="#fff" />
                  <Text style={styles.startSessionText}>Session</Text>
                </TouchableOpacity>
              )}
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

      {/* Save toast */}
      <Animated.View style={[styles.saveToast, { opacity: saveOpacity }]} pointerEvents="none">
        <Ionicons name="checkmark-circle" size={14} color="#16a34a" />
        <Text style={styles.saveToastText}>Saved</Text>
      </Animated.View>

      {/* Error banner */}
      {errorMessage && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={15} color="#b91c1c" />
          <Text style={styles.errorBannerText}>{errorMessage}</Text>
          <TouchableOpacity onPress={() => setErrorMessage(null)}>
            <Ionicons name="close" size={15} color="#b91c1c" />
          </TouchableOpacity>
        </View>
      )}

      {/* Canvas + Notes + Text Elements */}
      <View
        style={styles.canvasContainer}
        onLayout={(e) => setCanvasSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      >
        {!canvasReady && (
          <View style={styles.canvasLoadingOverlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#2563eb" />
            <Text style={styles.canvasLoadingText}>Loading canvas…</Text>
          </View>
        )}
        <DrawingCanvas
          ref={canvasSvgRef}
          paths={visiblePaths}
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
              onDelete={el.userId === user?.uid || isAdmin ? handleTextDelete : undefined}
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
        onRedo={handleRedo}
        canRedo={redoStack.length > 0}
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
          onSessionCreated={() => {
            setSessionModalVisible(false);
            refreshActiveSession();
          }}
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
  endSessionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#ef4444",
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
  canvasLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.85)",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    zIndex: 10,
  },
  canvasLoadingText: {
    fontSize: 14,
    color: "#6b7280",
    fontWeight: "500",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fef2f2",
    borderBottomWidth: 1,
    borderBottomColor: "#fecaca",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorBannerText: {
    flex: 1,
    fontSize: 13,
    color: "#b91c1c",
  },
  saveToast: {
    position: "absolute",
    top: 110,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#f0fdf4",
    borderWidth: 1,
    borderColor: "#bbf7d0",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    zIndex: 100,
  },
  saveToastText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#16a34a",
  },
});
