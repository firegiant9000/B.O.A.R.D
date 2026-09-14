jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

const mockRecorder = {
  prepareToRecordAsync: jest.fn(async () => undefined),
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
  uri: "file://recorded.m4a",
};
const mockPlayer = {
  play: jest.fn(),
  pause: jest.fn(),
};
// Mutable so tests can simulate the player's own status changing (e.g. a
// note finishing on its own, not via a tap) and re-render to observe it —
// see the "toggles play/pause" test below.
const mockPlayerStatus: { playing: boolean } = { playing: false };
jest.mock("expo-audio", () => ({
  useAudioRecorder: jest.fn(() => mockRecorder),
  useAudioPlayer: jest.fn(() => mockPlayer),
  useAudioPlayerStatus: jest.fn(() => mockPlayerStatus),
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  setAudioModeAsync: jest.fn(async () => undefined),
}));

jest.mock("../../../services/audioService", () => ({
  canRecordVoiceNotes: jest.fn((plan: string) => plan !== "free"),
  saveVoiceNote: jest.fn(async () => "new-audio-id"),
  deleteVoiceNote: jest.fn(async () => undefined),
  MAX_DURATION_MS: 60_000,
}));

import React from "react";
import { Alert, StyleSheet } from "react-native";
import { render, fireEvent, act, screen } from "@testing-library/react-native";
import AudioAffordance from "../AudioAffordance";
import * as audioService from "../../../services/audioService";
import * as expoAudio from "expo-audio";
import { AudioElement } from "../../../types";

/**
 * AudioAffordance.test.tsx — Month 5 voice notes. Follows the BoardCanvas
 * pattern: mock @expo/vector-icons and the heavy native module (expo-audio),
 * mock the service boundary, drive the real component.
 */

const baseProps = {
  boardId: "b1",
  anchorElementId: "e1",
  userId: "u1",
  x: 10,
  y: 20,
};

const existingAudio: AudioElement = {
  id: "a1",
  schemaVersion: 1,
  boardId: "b1",
  userId: "u1",
  anchorElementId: "e1",
  storagePath: "boards/b1/audio/a1/note.m4a",
  downloadUrl: "https://dl/note.m4a",
  durationMs: 5000,
  x: 10,
  y: 20,
  createdAt: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  mockRecorder.uri = "file://recorded.m4a";
  mockPlayerStatus.playing = false;
});

describe("advisory Pro gate", () => {
  it("renders the locked affordance on the free plan and offers an upgrade on tap", () => {
    const onUpgradeRequested = jest.fn();
    render(
      <AudioAffordance {...baseProps} plan="free" audio={null} onUpgradeRequested={onUpgradeRequested} />
    );
    fireEvent.press(screen.getByTestId("audio-affordance-locked"));
    expect(onUpgradeRequested).toHaveBeenCalledTimes(1);
    // Advisory only: never touches the recorder.
    expect(expoAudio.requestRecordingPermissionsAsync).not.toHaveBeenCalled();
  });

  it("falls back to a plain alert when no onUpgradeRequested is given", () => {
    render(<AudioAffordance {...baseProps} plan="free" audio={null} />);
    fireEvent.press(screen.getByTestId("audio-affordance-locked"));
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringMatching(/pro/i),
      expect.any(String)
    );
  });

  it("renders the record affordance on pro/edu, not the locked one", () => {
    render(<AudioAffordance {...baseProps} plan="pro" audio={null} />);
    expect(screen.getByTestId("audio-affordance-record")).toBeTruthy();
    render(<AudioAffordance {...baseProps} plan="edu" audio={null} />);
    expect(screen.getAllByTestId("audio-affordance-record").length).toBeGreaterThan(0);
  });
});

describe("recording flow", () => {
  it("requests permission, records, then stops+saves on the second tap", async () => {
    render(<AudioAffordance {...baseProps} plan="pro" audio={null} />);
    const button = screen.getByTestId("audio-affordance-record");

    await act(async () => {
      fireEvent.press(button);
    });
    expect(expoAudio.requestRecordingPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(expoAudio.setAudioModeAsync).toHaveBeenCalledWith({ allowsRecording: true });
    expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
    expect(mockRecorder.record).toHaveBeenCalledTimes(1);

    const onSaved = jest.fn();
    // Re-render isn't needed: same button instance, now in "recording" state.
    await act(async () => {
      fireEvent.press(button);
    });
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(audioService.saveVoiceNote).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: "b1",
        anchorElementId: "e1",
        uri: "file://recorded.m4a",
        userId: "u1",
        x: 10,
        y: 20,
      })
    );
  });

  it("never starts the recorder when permission is denied", async () => {
    (expoAudio.requestRecordingPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      granted: false,
    });
    render(<AudioAffordance {...baseProps} plan="pro" audio={null} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId("audio-affordance-record"));
    });
    expect(mockRecorder.record).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringMatching(/microphone/i),
      expect.any(String)
    );
  });

  it("registers the 60s auto-stop cap when recording starts", async () => {
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    render(<AudioAffordance {...baseProps} plan="pro" audio={null} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId("audio-affordance-record"));
    });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), audioService.MAX_DURATION_MS);
    setTimeoutSpy.mockRestore();
  });

  it("surfaces a save failure without crashing", async () => {
    (audioService.saveVoiceNote as jest.Mock).mockRejectedValueOnce(new Error("network down"));
    render(<AudioAffordance {...baseProps} plan="pro" audio={null} />);
    const button = screen.getByTestId("audio-affordance-record");
    await act(async () => {
      fireEvent.press(button);
    });
    await act(async () => {
      fireEvent.press(button);
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringMatching(/couldn/i),
      expect.stringMatching(/network down/)
    );
  });

  // Fix round 2: Finding 4 (unmount stops the recorder) and Finding 5 (the
  // audio mode resets after recording) were fixed as two separate code
  // paths — stopAndSave's `finally`, and the unmount cleanup. Finding 4 is
  // also what made "record, then select something else" unmount this
  // component instead of reusing it, so this is now a ROUTINE flow, not an
  // edge case. This test locks both halves together so the two paths can't
  // silently drift apart again.
  it("stops the recorder AND resets the audio mode when unmounted mid-recording", async () => {
    const { unmount } = render(<AudioAffordance {...baseProps} plan="pro" audio={null} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId("audio-affordance-record"));
    });
    expect(expoAudio.setAudioModeAsync).toHaveBeenLastCalledWith({ allowsRecording: true });
    expect(mockRecorder.stop).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
    });

    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(expoAudio.setAudioModeAsync).toHaveBeenLastCalledWith({ allowsRecording: false });
  });

  it("does not touch the recorder or the audio mode when unmounted while idle (never recorded)", async () => {
    const { unmount } = render(<AudioAffordance {...baseProps} plan="pro" audio={null} />);
    await act(async () => {
      unmount();
    });
    expect(mockRecorder.stop).not.toHaveBeenCalled();
    expect(expoAudio.setAudioModeAsync).not.toHaveBeenCalled();
  });
});

describe("playback of an existing note", () => {
  it("toggles play/pause on tap, reading the real player status rather than a local flag", () => {
    const { rerender } = render(<AudioAffordance {...baseProps} plan="free" audio={existingAudio} />);
    const button = () => screen.getByTestId("audio-affordance-play");

    fireEvent.press(button());
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);

    // The real `useAudioPlayerStatus` would flip `playing` on its own once
    // playback actually starts; simulate that and re-render.
    mockPlayerStatus.playing = true;
    rerender(<AudioAffordance {...baseProps} plan="free" audio={existingAudio} />);
    fireEvent.press(button());
    expect(mockPlayer.pause).toHaveBeenCalledTimes(1);
  });

  // Item 6, fix round 1: this test would have passed under the old
  // "local isPlaying state, toggled only by taps" model too — that model's
  // bug only shows up when playback ends ON ITS OWN. This is the case that
  // model got wrong: a single tap after the note finishes must immediately
  // call `.play()` again, not spend one tap re-syncing a stale flag.
  it("replays with a single tap after the note finishes on its own", () => {
    const { rerender } = render(<AudioAffordance {...baseProps} plan="free" audio={existingAudio} />);
    fireEvent.press(screen.getByTestId("audio-affordance-play"));
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);

    // Playback starts, then the real player reports it finished — nobody
    // tapped anything.
    mockPlayerStatus.playing = true;
    rerender(<AudioAffordance {...baseProps} plan="free" audio={existingAudio} />);
    mockPlayerStatus.playing = false;
    rerender(<AudioAffordance {...baseProps} plan="free" audio={existingAudio} />);

    fireEvent.press(screen.getByTestId("audio-affordance-play"));
    expect(mockPlayer.play).toHaveBeenCalledTimes(2);
    expect(mockPlayer.pause).not.toHaveBeenCalled();
  });

  it("deletes the note on long-press", async () => {
    const onDeleted = jest.fn();
    render(
      <AudioAffordance {...baseProps} plan="free" audio={existingAudio} onDeleted={onDeleted} />
    );
    await act(async () => {
      fireEvent(screen.getByTestId("audio-affordance-play"), "longPress");
    });
    expect(audioService.deleteVoiceNote).toHaveBeenCalledWith("b1", "a1");
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("renders playback even on the free plan (an existing note isn't re-gated)", () => {
    render(<AudioAffordance {...baseProps} plan="free" audio={existingAudio} />);
    expect(screen.getByTestId("audio-affordance-play")).toBeTruthy();
    expect(screen.queryByTestId("audio-affordance-locked")).toBeNull();
  });
});

// Item 11, fix round 1: the `scale` prop must resize THIS component's own
// button (dimensions), never rely on a caller wrapping it in a
// `transform: scale` (RN's transform is center-origin and drifts a
// top-left-positioned box off its true coordinate at any zoom ≠ 1).
describe("the scale prop (item 11)", () => {
  it("defaults to the base 28px button size when scale is omitted", () => {
    render(<AudioAffordance {...baseProps} plan="free" audio={existingAudio} />);
    const flat = StyleSheet.flatten(screen.getByTestId("audio-affordance-play").props.style);
    expect(flat.width).toBe(28);
    expect(flat.height).toBe(28);
    expect(flat.borderRadius).toBe(14);
  });

  it("scales the button's own dimensions instead of leaving sizing to a wrapper", () => {
    render(<AudioAffordance {...baseProps} plan="free" audio={existingAudio} scale={0.5} />);
    const flat = StyleSheet.flatten(screen.getByTestId("audio-affordance-play").props.style);
    expect(flat.width).toBe(14);
    expect(flat.height).toBe(14);
    expect(flat.borderRadius).toBe(7);
  });
});
