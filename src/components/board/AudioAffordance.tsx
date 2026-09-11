import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  useAudioRecorder,
  useAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import * as audioService from "../../services/audioService";
import { AudioElement, Plan } from "../../types";

export interface AudioAffordanceProps {
  boardId: string;
  anchorElementId: string;
  userId: string;
  x: number;
  y: number;
  plan: Plan;
  /** The anchor's existing voice note, or `null` when none has been recorded
   *  yet. Owned by the caller's own subscription (mirrors every other
   *  element kind on this board) — this component never subscribes itself. */
  audio: AudioElement | null;
  /** Fired with the new doc's id once a recording finishes uploading. The
   *  caller's subscription (subscribeToBoardAudio) is what actually delivers
   *  the full AudioElement back down as `audio` — this is just a hook for a
   *  caller that wants to react immediately (e.g. select the new note). */
  onSaved?: (audioId: string) => void;
  onDeleted?: () => void;
  /** Called instead of the built-in `Alert` when a free-tier user taps the
   *  locked affordance, so the caller can open the real upsell flow
   *  (UpsellModal) instead of this component's plain-text fallback. */
  onUpgradeRequested?: () => void;
}

/**
 * Month 5 (ROADMAP.md:583-587, roadmap item 9) — the speaker/mic icon
 * anchored to a board element (a stroke, sticky, text, or image). Three
 * states:
 *  - an existing voice note (`audio` set): speaker icon; tap toggles
 *    play/pause, long-press deletes it (audioService.deleteVoiceNote also
 *    removes the Storage object — see that function's own comment).
 *  - no note yet, plan allows recording: mic icon; tap starts recording, a
 *    second tap (or the 60s cap firing first) stops and uploads via
 *    audioService.saveVoiceNote.
 *  - no note yet, plan doesn't allow it: a locked mic icon; tapping offers an
 *    upgrade instead of ever touching the recorder. This is the CLIENT half
 *    of an advisory-only check — see audioService.canRecordVoiceNotes's
 *    header for why nothing here actually stops a determined client from
 *    recording anyway.
 *
 * Calls only audioService for persistence and expo-audio's hooks for the
 * device mic/speaker — never Firestore/Storage directly — per this branch's
 * "UI calls a service" rule.
 */
export default function AudioAffordance({
  boardId,
  anchorElementId,
  userId,
  x,
  y,
  plan,
  audio,
  onSaved,
  onDeleted,
  onUpgradeRequested,
}: AudioAffordanceProps) {
  const canRecord = audioService.canRecordVoiceNotes(plan);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const player = useAudioPlayer(audio?.downloadUrl ?? null);

  const [status, setStatus] = useState<"idle" | "recording" | "saving">("idle");
  const [isPlaying, setIsPlaying] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const autoStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoStop = useCallback(() => {
    if (autoStopTimer.current) {
      clearTimeout(autoStopTimer.current);
      autoStopTimer.current = null;
    }
  }, []);

  // If this affordance unmounts mid-recording (the user navigates away, the
  // element it's anchored to gets deleted, ...) the 60s auto-stop timer must
  // not fire afterward — it would call `recorder.stop()`/`saveVoiceNote` for
  // a component nobody can see the result of, and leak a live timer besides.
  useEffect(() => clearAutoStop, [clearAutoStop]);

  // Stops the recorder (via the recorder's own `.stop()`, whether called by
  // a tap or by the 60s auto-stop timer below) and uploads what was
  // captured. `audioService.saveVoiceNote` re-checks the cap too — it's the
  // one client choke point every caller of this module goes through, though
  // like everything else in this file that is advisory only, not a server
  // check (see audioService.MAX_DURATION_MS's comment). Clamping `durationMs`
  // here just keeps a borderline auto-stop race from ever handing it a value
  // a hair over 60s.
  const stopAndSave = useCallback(async () => {
    clearAutoStop();
    const startedAt = startedAtRef.current;
    startedAtRef.current = null;
    if (startedAt == null) return;
    try {
      await recorder.stop();
    } catch (e) {
      setStatus("idle");
      Alert.alert("Recording failed", e instanceof Error ? e.message : "Please try again.");
      return;
    }
    const uri = recorder.uri;
    if (!uri) {
      setStatus("idle");
      return;
    }
    const durationMs = Math.min(Date.now() - startedAt, audioService.MAX_DURATION_MS);
    setStatus("saving");
    try {
      const id = await audioService.saveVoiceNote({
        boardId,
        anchorElementId,
        uri,
        durationMs,
        userId,
        x,
        y,
      });
      onSaved?.(id);
    } catch (e) {
      Alert.alert("Couldn't save voice note", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setStatus("idle");
    }
  }, [recorder, clearAutoStop, boardId, anchorElementId, userId, x, y, onSaved]);

  const startRecording = useCallback(async () => {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      Alert.alert(
        "Microphone access needed",
        "Allow microphone access in Settings to record a voice note."
      );
      return;
    }
    await setAudioModeAsync({ allowsRecording: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    startedAtRef.current = Date.now();
    setStatus("recording");
    // ROADMAP.md:584 — "up to 60s". Belt-and-suspenders with
    // audioService.saveVoiceNote's own rejection: this stops the recorder
    // itself instead of ever letting a caller assemble an over-cap file.
    autoStopTimer.current = setTimeout(() => {
      stopAndSave();
    }, audioService.MAX_DURATION_MS);
  }, [recorder, stopAndSave]);

  const showUpgradePrompt = useCallback(() => {
    if (onUpgradeRequested) {
      onUpgradeRequested();
      return;
    }
    Alert.alert(
      "Voice notes are a Pro feature",
      "Upgrade your plan to record voice notes on board elements."
    );
  }, [onUpgradeRequested]);

  const togglePlayback = useCallback(() => {
    if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    } else {
      player.play();
      setIsPlaying(true);
    }
  }, [player, isPlaying]);

  const handleDelete = useCallback(async () => {
    if (!audio) return;
    if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    }
    await audioService.deleteVoiceNote(boardId, audio.id);
    onDeleted?.();
  }, [audio, boardId, isPlaying, player, onDeleted]);

  if (audio) {
    return (
      <TouchableOpacity
        testID="audio-affordance-play"
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? "Pause voice note" : "Play voice note"}
        style={[styles.button, styles.playButton]}
        onPress={togglePlayback}
        onLongPress={handleDelete}
      >
        <Ionicons name={isPlaying ? "pause" : "volume-high"} size={16} color="#fff" />
      </TouchableOpacity>
    );
  }

  if (!canRecord) {
    return (
      <TouchableOpacity
        testID="audio-affordance-locked"
        accessibilityRole="button"
        accessibilityLabel="Voice notes are a Pro feature"
        style={[styles.button, styles.lockedButton]}
        onPress={showUpgradePrompt}
      >
        <Ionicons name="mic-off-outline" size={16} color="#9ca3af" />
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      testID="audio-affordance-record"
      accessibilityRole="button"
      accessibilityLabel={status === "recording" ? "Stop recording" : "Record a voice note"}
      disabled={status === "saving"}
      style={[styles.button, status === "recording" ? styles.recordingButton : styles.recordButton]}
      onPress={status === "recording" ? stopAndSave : startRecording}
    >
      <Ionicons name={status === "recording" ? "square" : "mic-outline"} size={16} color="#fff" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  playButton: {
    backgroundColor: "#2563eb",
  },
  recordButton: {
    backgroundColor: "#2563eb",
  },
  recordingButton: {
    backgroundColor: "#dc2626",
  },
  lockedButton: {
    backgroundColor: "#e5e7eb",
  },
});
