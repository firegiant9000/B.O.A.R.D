import React, { useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  LayoutChangeEvent,
  GestureResponderEvent,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { fromHex8, toHex6, toCssRgba, isValidHex, clampAlpha } from "../lib/color";
import { valueFromPosition, positionFromValue } from "../lib/sliderMath";
import * as workspaceService from "../services/workspaceService";
import type { Plan } from "../types";

/**
 * The Month 5 custom colour picker (ROADMAP item 12): hex input, alpha
 * slider, a recent-colours row, and the per-workspace swatch palette (ROADMAP
 * item 14's Pro affordance — see `canUseSwatches` below).
 *
 * Rendered by `BoardModals.tsx`, opened from a "Colour" pill in
 * `PenOptionsBar`/`Toolbar`. Every colour choice here (hex apply, a recent
 * tap, a swatch tap) calls the SAME `onChange`, which the board screen wires
 * to `tools.chooseColor` — this component has no colour-model logic of its
 * own beyond parsing the hex text field (`src/lib/color.ts`).
 */

const SWATCH_SIZE = 28;
const ALPHA_TRACK_HEIGHT = 28;

export interface ColorPickerModalProps {
  visible: boolean;
  onClose: () => void;
  /** Plain opaque `#rrggbb` — matches `DrawPath.color`. */
  color: string;
  /** 0-1. */
  alpha: number;
  onChange: (hex: string, alpha: number) => void;
  recentColors: string[];

  /** The workspace's plan — the advisory Pro gate on adding a NEW swatch
   *  (see `workspaceService.ts#canUseCustomPalette`'s header). Existing
   *  swatches remain visible/usable to every plan; only adding one is gated. */
  plan: Plan;
  /** Whether the CALLER's workspace role may write to the workspace doc at
   *  all beyond renaming it — firestore.rules' `workspaces/{id}` update rule
   *  restricts every other field (including `swatches`) to owner/admin
   *  members (`workspaceService.ts#canManageMembers`'s own `MANAGER_ROLES`).
   *  A Pro-plan member who isn't a workspace owner/admin would otherwise see
   *  "add swatch" succeed optimistically here and then be silently denied
   *  server-side on the next load — this keeps the control disabled for
   *  them instead, the same silent-disable the swatch cap already uses
   *  below, rather than a "Pro" badge that would misdescribe a role
   *  restriction as a plan one. */
  canManageWorkspace: boolean;
  workspaceSwatches: string[];
  onAddSwatch: (hex: string) => void;
  /** Called instead of the built-in `Alert` when a free-tier user taps the
   *  locked "add swatch" affordance, so the caller can open the real upsell
   *  flow (UpsellModal, via `upsellResource="customPalette"`) instead of
   *  this component's plain-text fallback — mirrors
   *  `AudioAffordance`'s `onUpgradeRequested`. */
  onUpgradeRequested?: () => void;
}

export default function ColorPickerModal({
  visible,
  onClose,
  color,
  alpha,
  onChange,
  recentColors,
  plan,
  canManageWorkspace,
  workspaceSwatches,
  onAddSwatch,
  onUpgradeRequested,
}: ColorPickerModalProps) {
  const [hexText, setHexText] = useState(color);
  useEffect(() => {
    if (visible) setHexText(color);
  }, [visible, color]);

  const hexValid = isValidHex(hexText);
  // Defensive fallback (opaque black) for a malformed `color` prop — should
  // never happen in practice (it always comes from `tools.activeColor`,
  // itself only ever set via valid hex), but a render-time crash on a bad
  // value would be a worse failure mode than a wrong-looking swatch.
  const parsedColor = fromHex8(color) ?? { r: 0, g: 0, b: 0, a: 1 };

  const commitHex = (text: string) => {
    const parsed = fromHex8(text);
    if (parsed) onChange(toHex6(parsed), alpha);
  };

  const [trackWidth, setTrackWidth] = useState(1);
  const onTrackLayout = (e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width);

  // Plain Responder System props, not PanResponder — see StrokeWidthModal.tsx's
  // identical header comment: this is a 1D drag with no velocity/multi-touch
  // tracking to justify PanResponder's `touchHistory` bookkeeping (also not
  // exercisable via RNTL's `fireEvent`), and an inline handler recreated every
  // render always closes over the current `trackWidth`/`color` — no
  // `useRef`-memoized handler to go stale once `onLayout` reports the real width.
  const updateAlphaFromX = (x: number) => {
    onChange(color, clampAlpha(Math.round(valueFromPosition(x, trackWidth, 0, 1) * 100) / 100));
  };
  const onAlphaTouch = (e: GestureResponderEvent) => updateAlphaFromX(e.nativeEvent.locationX);

  const canUseSwatches = workspaceService.canUseCustomPalette(plan);
  const atSwatchCap = workspaceSwatches.length >= workspaceService.MAX_WORKSPACE_SWATCHES;
  // Disabled the same silent way `atSwatchCap` already is — see
  // `canManageWorkspace`'s own prop doc for why this is a role restriction,
  // not a plan one, and so gets no "Pro" badge of its own.
  const canAddSwatch = canUseSwatches && canManageWorkspace && !atSwatchCap;

  const handleAddSwatch = () => {
    if (!canUseSwatches) {
      if (onUpgradeRequested) {
        onUpgradeRequested();
      } else {
        Alert.alert(
          "Custom swatches are a Pro feature",
          "Upgrade your plan to save colours to this workspace's swatch palette."
        );
      }
      return;
    }
    if (!canAddSwatch) return;
    onAddSwatch(toHex6({ ...parsedColor, a: 1 }));
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Colour</Text>
            <TouchableOpacity
              testID="color-picker-close"
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close colour picker"
            >
              <Ionicons name="close" size={20} color="#6b7280" />
            </TouchableOpacity>
          </View>

          <View style={styles.previewRow}>
            <View style={styles.previewCheckerboard}>
              <View
                style={[styles.previewSwatch, { backgroundColor: toCssRgba({ ...parsedColor, a: alpha }) }]}
              />
            </View>
            <TextInput
              testID="color-picker-hex-input"
              style={[styles.hexInput, !hexValid && styles.hexInputInvalid]}
              value={hexText}
              onChangeText={setHexText}
              onSubmitEditing={() => commitHex(hexText)}
              onBlur={() => commitHex(hexText)}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="#rrggbb"
            />
          </View>

          <Text style={styles.sectionLabel}>Alpha: {Math.round(alpha * 100)}%</Text>
          <View
            testID="color-picker-alpha-track"
            style={styles.alphaTrack}
            onLayout={onTrackLayout}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={onAlphaTouch}
            onResponderMove={onAlphaTouch}
          >
            <View
              testID="color-picker-alpha-thumb"
              style={[styles.alphaThumb, { left: positionFromValue(alpha, trackWidth, 0, 1) - 8 }]}
            />
          </View>

          {recentColors.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>Recent</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.swatchRow}>
                {recentColors.map((hex) => (
                  <TouchableOpacity
                    key={hex}
                    testID={`color-picker-recent-${hex}`}
                    style={[styles.swatch, { backgroundColor: hex }]}
                    onPress={() => onChange(hex, alpha)}
                    accessibilityRole="button"
                    accessibilityLabel={`Use recent colour ${hex}`}
                  />
                ))}
              </ScrollView>
            </>
          )}

          <View style={styles.sectionLabelRow}>
            <Text style={styles.sectionLabel}>Workspace swatches</Text>
            {!canUseSwatches && (
              <TouchableOpacity
                testID="color-picker-swatch-pro-badge"
                style={styles.proBadge}
                onPress={handleAddSwatch}
                accessibilityRole="button"
                accessibilityLabel="Custom swatches are a Pro feature — upgrade to add one"
              >
                <Text style={styles.proBadgeText}>Pro</Text>
              </TouchableOpacity>
            )}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.swatchRow}>
            {workspaceSwatches.map((hex) => (
              <TouchableOpacity
                key={hex}
                testID={`color-picker-swatch-${hex}`}
                style={[styles.swatch, { backgroundColor: hex }]}
                onPress={() => onChange(hex, alpha)}
                accessibilityRole="button"
                accessibilityLabel={`Use workspace swatch ${hex}`}
              />
            ))}
            <TouchableOpacity
              testID="color-picker-add-swatch"
              style={[styles.swatch, styles.addSwatch, !canAddSwatch && styles.addSwatchDisabled]}
              onPress={handleAddSwatch}
              accessibilityRole="button"
              accessibilityLabel={
                !canUseSwatches
                  ? "Custom swatches are a Pro feature"
                  : !canManageWorkspace
                    ? "Only a workspace owner or admin can add swatches"
                    : "Add the current colour to the workspace palette"
              }
            >
              <Ionicons name="add" size={16} color="#6b7280" />
            </TouchableOpacity>
          </ScrollView>

          <TouchableOpacity
            testID="color-picker-done"
            style={styles.doneButton}
            onPress={onClose}
            accessibilityRole="button"
          >
            <Text style={styles.doneButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(17, 24, 39, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
  },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 14,
  },
  previewCheckerboard: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#e5e7eb",
    justifyContent: "center",
    alignItems: "center",
  },
  previewSwatch: {
    width: 36,
    height: 36,
    borderRadius: 8,
  },
  hexInput: {
    flex: 1,
    height: 40,
    borderWidth: 1,
    borderColor: "#D1D1D6",
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 15,
    color: "#111827",
  },
  hexInputInvalid: {
    borderColor: "#dc2626",
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6b7280",
    marginBottom: 6,
    marginTop: 4,
  },
  sectionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  alphaTrack: {
    height: ALPHA_TRACK_HEIGHT,
    borderRadius: ALPHA_TRACK_HEIGHT / 2,
    backgroundColor: "#e5e7eb",
    justifyContent: "center",
    marginBottom: 10,
  },
  alphaThumb: {
    position: "absolute",
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#2563eb",
  },
  swatchRow: {
    flexDirection: "row",
    marginBottom: 10,
  },
  swatch: {
    width: SWATCH_SIZE,
    height: SWATCH_SIZE,
    borderRadius: SWATCH_SIZE / 2,
    marginRight: 8,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.1)",
  },
  addSwatch: {
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#f3f4f6",
    borderStyle: "dashed",
  },
  addSwatchDisabled: {
    opacity: 0.5,
  },
  proBadge: {
    backgroundColor: "#7c3aed",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  proBadgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },
  doneButton: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 8,
  },
  doneButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
});
