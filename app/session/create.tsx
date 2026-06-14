import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  FlatList,
  Modal,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useAuth } from "../../src/hooks/useAuth";
import { Board } from "../../src/types";
import * as boardService from "../../src/services/boardService";
import * as sessionService from "../../src/services/sessionService";

const DURATION_OPTIONS = [
  { label: "30m", value: 30 },
  { label: "1h", value: 60 },
  { label: "1.5h", value: 90 },
  { label: "2h", value: 120 },
];

export default function CreateSessionScreen() {
  const router = useRouter();
  const { user, userProfile } = useAuth();
  const params = useLocalSearchParams<{
    boardId?: string;
    sessionId?: string;
  }>();

  const isEdit = !!params.sessionId;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedBoard, setSelectedBoard] = useState<Board | null>(null);
  const [date, setDate] = useState(new Date());
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [customDuration, setCustomDuration] = useState("");

  const [boards, setBoards] = useState<Board[]>([]);
  const [boardPickerVisible, setBoardPickerVisible] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    if (!user) return;
    try {
      const userBoards = await boardService.getUserBoards(user.uid);
      setBoards(userBoards);

      // Pre-select board if boardId param provided
      if (params.boardId) {
        const board = userBoards.find((b) => b.id === params.boardId);
        if (board) setSelectedBoard(board);
      }

      // Load existing session for edit mode
      if (params.sessionId) {
        const session = await sessionService.getSession(params.sessionId);
        if (session) {
          setTitle(session.title);
          setDescription(session.description);
          setDate(session.scheduledAt);
          setDurationMinutes(session.durationMinutes);
          const board = userBoards.find((b) => b.id === session.boardId);
          if (board) setSelectedBoard(board);
          if (!DURATION_OPTIONS.find((o) => o.value === session.durationMinutes)) {
            setCustomDuration(String(session.durationMinutes));
          }
        }
      }
    } catch {
      Alert.alert("Error", "Failed to load data");
    } finally {
      setInitialLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      Alert.alert("Validation", "Title is required");
      return;
    }
    if (!selectedBoard) {
      Alert.alert("Validation", "Please select a board");
      return;
    }
    if (!user) return;

    const parsedCustom = customDuration ? parseInt(customDuration, 10) : NaN;
    const finalDuration = !isNaN(parsedCustom) && parsedCustom > 0
      ? Math.max(5, parsedCustom)
      : durationMinutes;

    setLoading(true);
    try {
      if (isEdit && params.sessionId) {
        await sessionService.updateSession(params.sessionId, {
          title: title.trim(),
          description: description.trim(),
          boardId: selectedBoard.id,
          scheduledAt: date,
          durationMinutes: finalDuration,
        });
      } else {
        await sessionService.createSession({
          title: title.trim(),
          description: description.trim(),
          workspaceId: selectedBoard.workspaceId,
          boardId: selectedBoard.id,
          boardTitle: selectedBoard.title,
          scheduledAt: date,
          durationMinutes: finalDuration,
          createdById: user.uid,
          createdByName: userProfile?.displayName ?? user.displayName ?? "",
          participantIds: [],
          status: "scheduled",
        });
      }
      router.back();
    } catch {
      Alert.alert("Error", `Failed to ${isEdit ? "update" : "create"} session`);
    } finally {
      setLoading(false);
    }
  };

  const handleDateChange = (_: any, selectedDate?: Date) => {
    setShowDatePicker(false);
    if (selectedDate) {
      const newDate = new Date(date);
      newDate.setFullYear(
        selectedDate.getFullYear(),
        selectedDate.getMonth(),
        selectedDate.getDate()
      );
      setDate(newDate);
    }
  };

  const handleTimeChange = (_: any, selectedTime?: Date) => {
    setShowTimePicker(false);
    if (selectedTime) {
      const newDate = new Date(date);
      newDate.setHours(selectedTime.getHours(), selectedTime.getMinutes());
      setDate(newDate);
    }
  };

  if (initialLoading) {
    return (
      <View style={styles.centered}>
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
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="close" size={24} color="#333" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {isEdit ? "Edit Session" : "New Session"}
        </Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView style={styles.form} keyboardShouldPersistTaps="handled">
        {/* Title */}
        <Text style={styles.label}>Title</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="Session title"
          placeholderTextColor="#9ca3af"
        />

        {/* Board selector */}
        <Text style={styles.label}>Board</Text>
        <TouchableOpacity
          style={styles.selector}
          onPress={() => setBoardPickerVisible(true)}
        >
          <Text
            style={
              selectedBoard ? styles.selectorText : styles.selectorPlaceholder
            }
          >
            {selectedBoard ? selectedBoard.title : "Select a board"}
          </Text>
          <Ionicons name="chevron-down" size={20} color="#6b7280" />
        </TouchableOpacity>

        {/* Date */}
        <Text style={styles.label}>Date</Text>
        <TouchableOpacity
          style={styles.selector}
          onPress={() => setShowDatePicker(true)}
        >
          <Text style={styles.selectorText}>
            {date.toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </Text>
          <Ionicons name="calendar-outline" size={20} color="#6b7280" />
        </TouchableOpacity>
        {showDatePicker && (
          <DateTimePicker
            value={date}
            mode="date"
            onChange={handleDateChange}
          />
        )}

        {/* Time */}
        <Text style={styles.label}>Start Time</Text>
        <TouchableOpacity
          style={styles.selector}
          onPress={() => setShowTimePicker(true)}
        >
          <Text style={styles.selectorText}>
            {date.toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
          </Text>
          <Ionicons name="time-outline" size={20} color="#6b7280" />
        </TouchableOpacity>
        {showTimePicker && (
          <DateTimePicker
            value={date}
            mode="time"
            onChange={handleTimeChange}
          />
        )}

        {/* Duration */}
        <Text style={styles.label}>Duration</Text>
        <View style={styles.durationRow}>
          {DURATION_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.value}
              style={[
                styles.durationChip,
                durationMinutes === opt.value &&
                  !customDuration &&
                  styles.durationChipActive,
              ]}
              onPress={() => {
                setDurationMinutes(opt.value);
                setCustomDuration("");
              }}
            >
              <Text
                style={[
                  styles.durationChipText,
                  durationMinutes === opt.value &&
                    !customDuration &&
                    styles.durationChipTextActive,
                ]}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
          <TextInput
            style={[styles.durationInput, customDuration ? styles.durationInputActive : null]}
            value={customDuration}
            onChangeText={(val) => {
              setCustomDuration(val);
              const num = parseInt(val, 10);
              if (num > 0) setDurationMinutes(num);
            }}
            placeholder="min"
            placeholderTextColor="#9ca3af"
            keyboardType="numeric"
          />
        </View>

        {/* Description */}
        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={description}
          onChangeText={setDescription}
          placeholder="Optional description"
          placeholderTextColor="#9ca3af"
          multiline
          numberOfLines={4}
        />

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>
              {isEdit ? "Update Session" : "Create Session"}
            </Text>
          )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Board picker modal */}
      <Modal
        visible={boardPickerVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setBoardPickerVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Board</Text>
              <TouchableOpacity
                onPress={() => setBoardPickerVisible(false)}
              >
                <Ionicons name="close" size={24} color="#333" />
              </TouchableOpacity>
            </View>
            <FlatList
              data={boards}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.boardItem,
                    selectedBoard?.id === item.id && styles.boardItemSelected,
                  ]}
                  onPress={() => {
                    setSelectedBoard(item);
                    setBoardPickerVisible(false);
                  }}
                >
                  <Ionicons
                    name="easel-outline"
                    size={20}
                    color={
                      selectedBoard?.id === item.id ? "#2563eb" : "#6b7280"
                    }
                  />
                  <Text
                    style={[
                      styles.boardItemText,
                      selectedBoard?.id === item.id &&
                        styles.boardItemTextSelected,
                    ]}
                  >
                    {item.title}
                  </Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={styles.emptyText}>No boards found</Text>
              }
            />
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
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
  backBtn: {
    padding: 4,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    textAlign: "center",
  },
  form: {
    flex: 1,
    padding: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: "#111",
    backgroundColor: "#f9fafb",
  },
  textArea: {
    minHeight: 100,
    textAlignVertical: "top",
  },
  selector: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    padding: 12,
    backgroundColor: "#f9fafb",
  },
  selectorText: {
    fontSize: 16,
    color: "#111",
  },
  selectorPlaceholder: {
    fontSize: 16,
    color: "#9ca3af",
  },
  durationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  durationChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#f3f4f6",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  durationChipActive: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  durationChipText: {
    fontSize: 14,
    color: "#374151",
    fontWeight: "500",
  },
  durationChipTextActive: {
    color: "#fff",
  },
  durationInput: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    width: 60,
    textAlign: "center",
    backgroundColor: "#f9fafb",
  },
  durationInputActive: {
    borderColor: "#2563eb",
  },
  submitBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginTop: 24,
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  submitBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "60%",
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "600",
  },
  boardItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
  },
  boardItemSelected: {
    backgroundColor: "#eff6ff",
  },
  boardItemText: {
    fontSize: 16,
    color: "#333",
  },
  boardItemTextSelected: {
    color: "#2563eb",
    fontWeight: "600",
  },
  emptyText: {
    textAlign: "center",
    color: "#9ca3af",
    padding: 24,
  },
});
