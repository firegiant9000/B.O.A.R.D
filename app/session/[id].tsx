import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Share,
  Clipboard,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/hooks/useAuth";
import { Session, Board } from "../../src/types";
import * as sessionService from "../../src/services/sessionService";
import * as boardService from "../../src/services/boardService";
import * as notificationService from "../../src/services/notificationService";
import * as activityService from "../../src/services/activityService";
import * as aiService from "../../src/services/aiService";
import { getUsersByIds } from "../../src/services/friendService";
import { exportRecapPdf } from "../../src/utils/recapExport";
import { showAlert, confirmAlert } from "../../src/utils/alerts";
import SessionLobby from "../../src/components/session/SessionLobby";
import SessionLive from "../../src/components/session/SessionLive";
import SessionRecap from "../../src/components/session/SessionRecap";

type Profile = { uid: string; displayName: string; email: string };

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user, userProfile } = useAuth();

  const [session, setSession] = useState<Session | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [participants, setParticipants] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  const [agenda, setAgenda] = useState("");
  const [agendaDirty, setAgendaDirty] = useState(false);
  const [savingAgenda, setSavingAgenda] = useState(false);
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);

  const isCreator = session?.createdById === user?.uid;

  const loadSession = useCallback(async () => {
    if (!id) return;
    try {
      const s = await sessionService.getSession(id);
      setSession(s);
      if (!s) return;
      setAgenda(s.agenda ?? "");
      setAgendaDirty(false);
      const [b, liveProfiles] = await Promise.all([
        boardService.getBoard(s.boardId),
        getUsersByIds(Array.from(new Set([s.createdById, ...s.participantIds]))),
      ]);
      setBoard(b);
      // Recap prefers the frozen snapshot taken at end; otherwise resolve live.
      setParticipants(
        s.participants && s.participants.length > 0 ? s.participants : liveProfiles
      );
    } catch {
      showAlert("Error", "Failed to load session");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const goToBoard = () => session && router.push(`/board/${session.boardId}`);

  const handleSaveAgenda = async () => {
    if (!session) return;
    setSavingAgenda(true);
    try {
      await sessionService.updateSession(session.id, { agenda: agenda.trim() });
      setSession((prev) => (prev ? { ...prev, agenda: agenda.trim() } : prev));
      setAgendaDirty(false);
    } catch {
      showAlert("Error", "Failed to save agenda.");
    } finally {
      setSavingAgenda(false);
    }
  };

  const handleStart = async () => {
    if (!session) return;
    setStarting(true);
    try {
      await sessionService.startSession(session.id);
      setSession((prev) => (prev ? { ...prev, status: "active", startedAt: new Date() } : prev));
      if (session.participantIds.length > 0) {
        const tokens = await sessionService.getParticipantPushTokens(session.participantIds);
        await notificationService.sendSessionPushNotifications(
          tokens,
          session.title,
          session.boardTitle,
          userProfile?.displayName ?? "Admin",
          { sessionId: session.id, boardId: session.boardId }
        );
      }
    } catch {
      showAlert("Error", "Failed to start session.");
    } finally {
      setStarting(false);
    }
  };

  const handleEnd = () => {
    if (!session) return;
    confirmAlert({
      title: "End Session",
      message: "Mark this session as ended?",
      confirmText: "End Session",
      destructive: true,
      onConfirm: async () => {
        setEnding(true);
        try {
          // Freeze who was in the session so the recap is stable. Snapshot capture
          // happens from the board's End Session button (it has the canvas ref);
          // ending here just records the participants + endedAt.
          const frozen = await sessionService.resolveParticipantSnapshot(session);
          await sessionService.endSession(session.id, { participants: frozen });
          activityService.logSessionEnded({
            workspaceId: session.workspaceId || board?.workspaceId || "",
            boardId: session.boardId,
            sessionId: session.id,
            actorId: user?.uid ?? "",
            actorName: userProfile?.displayName ?? user?.email ?? "User",
            participantCount: session.participantIds.length,
            title: session.title,
          });
          setSession((prev) =>
            prev ? { ...prev, status: "ended", endedAt: new Date(), participants: frozen } : prev
          );
          setParticipants(frozen);
        } catch {
          showAlert("Error", "Failed to end session.");
        } finally {
          setEnding(false);
        }
      },
    });
  };

  const handleGenerateSummary = async () => {
    if (!session) return;
    if (!aiService.isSummaryConfigured()) {
      showAlert("API Key Required", "Add your OpenAI API key in the Profile tab to generate summaries.");
      return;
    }
    setGenerating(true);
    try {
      const summary = await aiService.generateSessionSummary(
        session.boardId,
        {
          sessionTitle: session.title,
          boardTitle: session.boardTitle,
          durationMinutes: session.durationMinutes,
          participantCount: session.participantIds.length + 1,
        },
        session.canvasSnapshot
      );
      await sessionService.updateSessionSummary(session.id, summary);
      setSession((prev) => (prev ? { ...prev, summary } : prev));
    } catch (error: any) {
      showAlert("Summary Failed", error?.message ?? "Failed to generate summary.");
    } finally {
      setGenerating(false);
    }
  };

  const handleExport = async () => {
    if (!session) return;
    setExporting(true);
    try {
      await exportRecapPdf(session);
    } catch (error: any) {
      showAlert("Export Failed", error?.message ?? "Could not export the recap.");
    } finally {
      setExporting(false);
    }
  };

  const handleShare = async () => {
    if (!session) return;
    // Phase 8 will mint a read-only embed link; until then, share the invite code.
    const lines = [`Recap: ${session.title}`, `Board: ${session.boardTitle}`];
    if (session.joinCode) lines.push(`Invite code: ${session.joinCode}`);
    try {
      await Share.share({ message: lines.join("\n") });
    } catch {
      // user dismissed the share sheet — no-op
    }
  };

  const handleCopyCode = () => {
    if (!session?.joinCode) return;
    Clipboard.setString(session.joinCode);
    showAlert("Copied", "Invite code copied to clipboard.");
  };

  const handleDelete = () => {
    if (!session) return;
    confirmAlert({
      title: "Delete Session",
      message: `Delete "${session.title}"? This cannot be undone.`,
      confirmText: "Delete",
      destructive: true,
      onConfirm: async () => {
        try {
          await sessionService.deleteSession(session.id);
          router.back();
        } catch {
          showAlert("Error", "Failed to delete session.");
        }
      },
    });
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Session not found</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.link}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#333" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          Session
        </Text>
        {isCreator && session.status !== "active" ? (
          <View style={styles.headerActions}>
            {session.status === "scheduled" && (
              <TouchableOpacity
                onPress={() => router.push(`/session/create?sessionId=${session.id}`)}
                style={styles.headerIconBtn}
              >
                <Ionicons name="create-outline" size={22} color="#2563eb" />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={handleDelete} style={styles.headerIconBtn}>
              <Ionicons name="trash-outline" size={22} color="#ef4444" />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ width: 32 }} />
        )}
      </View>

      <ScrollView style={styles.content}>
        {session.status === "scheduled" && (
          <SessionLobby
            session={session}
            board={board}
            participants={participants}
            isCreator={!!isCreator}
            agenda={agenda}
            onAgendaChange={(t) => {
              setAgenda(t);
              setAgendaDirty(true);
            }}
            onSaveAgenda={handleSaveAgenda}
            savingAgenda={savingAgenda}
            agendaDirty={agendaDirty}
            onStart={handleStart}
            starting={starting}
            onCopyCode={handleCopyCode}
            onGoToBoard={goToBoard}
          />
        )}
        {session.status === "active" && (
          <SessionLive
            session={session}
            participants={participants}
            isCreator={!!isCreator}
            onEnd={handleEnd}
            ending={ending}
            onGoToBoard={goToBoard}
          />
        )}
        {session.status === "ended" && (
          <SessionRecap
            session={session}
            participants={participants}
            isCreator={!!isCreator}
            summaryConfigured={aiService.isSummaryConfigured()}
            onGenerateSummary={handleGenerateSummary}
            generating={generating}
            onExport={handleExport}
            exporting={exporting}
            onShare={handleShare}
            onGoToBoard={goToBoard}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  centered: {
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
  backBtn: { padding: 4 },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    textAlign: "center",
  },
  headerActions: { flexDirection: "row", gap: 8 },
  headerIconBtn: { padding: 4 },
  content: { flex: 1 },
  errorText: { fontSize: 16, color: "#6b7280", marginBottom: 12 },
  link: { fontSize: 16, color: "#2563eb", fontWeight: "600" },
});
