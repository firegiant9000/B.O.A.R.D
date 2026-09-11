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
jest.mock("expo-audio", () => ({
  useAudioRecorder: jest.fn(() => mockRecorder),
  useAudioPlayer: jest.fn(() => mockPlayer),
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
import { Alert } from "react-native";
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
});

describe("playback of an existing note", () => {
  it("toggles play/pause on tap", () => {
    render(<AudioAffordance {...baseProps} plan="free" audio={existingAudio} />);
    const button = screen.getByTestId("audio-affordance-play");
    fireEvent.press(button);
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    fireEvent.press(button);
    expect(mockPlayer.pause).toHaveBeenCalledTimes(1);
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
