import React, { useEffect, useRef, useState } from "react";
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
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { fromHex8, toHex6, toCssRgba, isValidHex, hasAlphaByte, clampAlpha } from "../lib/color";
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
  /** Fix Wave F7 — long-press a workspace swatch to free its slot
   *  (`workspaceService.ts#removeWorkspaceSwatch`). Same `canManageWorkspace`
   *  role gate as adding; NOT plan-gated — removing frees capacity rather
   *  than spending it, so a downgraded workspace can still tidy its existing
   *  swatches (see that function's own comment for why removal carries no
   *  Pro check). */
  onRemoveSwatch: (hex: string) => void;
  /** Called when a free-tier user taps the locked "add swatch" affordance,
   *  routing to the real upsell flow (UpsellModal, via
   *  `upsellResource="customPalette"`) — mirrors `AudioAffordance`'s
   *  `onUpgradeRequested`, except REQUIRED here rather than optional with a
   *  plain-`Alert` fallback: this project's own native-denial bar
   *  (`UpsellModal.test.tsx`) forbids even the word "upgrade" on a denial
   *  surface, and a fallback `Alert` in this file would be a second denial
   *  surface neither of the store-compliance source scans cover (this file
   *  is in neither list). Required means there is exactly one. */
  onUpgradeRequested: () => void;
  /** Fix Wave F5 — `useBoardElements#selectionOpacityInert`: true when the
   *  current selection is non-empty but has nothing the alpha slider would
   *  actually change (no paths, or only eraser paths). Disables the alpha
   *  track instead of leaving it a silent no-op. Defaults to false — every
   *  existing caller that predates this prop keeps today's always-enabled
   *  behavior. */
  opacityControlDisabled?: boolean;
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
  onRemoveSwatch,
  onUpgradeRequested,
  opacityControlDisabled = false,
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

  const [trackWidth, setTrackWidth] = useState(1);
  const onTrackLayout = (e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width);

  // Fix round 1, item 2: `onChange` used to fire on every `onResponderMove`
  // (~60/sec for a whole drag), each call rebuilding and batch-writing every
  // selected element's doc through `elements.applyColor`/`applyOpacity` —
  // this is a NEW way to reach those write paths this task added (they were
  // previously reachable only from discrete taps: 8 colour dots, 3 width
  // buttons). `localAlpha` is the live, per-move value this component's OWN
  // preview (the % label, the thumb, the swatch) renders from; `onChange`
  // — the actual Firestore-writing commit — fires exactly once, on release,
  // with whatever `localAlpha` settled on. `localAlphaRef` (not just the
  // `localAlpha` state) is what `commitAlpha` reads, so the release handler
  // never risks reading a value from before the last move's `setState` flushed.
  const [localAlpha, setLocalAlpha] = useState(alpha);
  const localAlphaRef = useRef(alpha);
  const draggingAlphaRef = useRef(false);
  useEffect(() => {
    if (!draggingAlphaRef.current) {
      setLocalAlpha(alpha);
      localAlphaRef.current = alpha;
    }
  }, [alpha]);

  const updateAlphaFromX = (x: number) => {
    const next = clampAlpha(Math.round(valueFromPosition(x, trackWidth, 0, 1) * 100) / 100);
    localAlphaRef.current = next;
    setLocalAlpha(next);
  };
  const onAlphaGrant = (e: GestureResponderEvent) => {
    draggingAlphaRef.current = true;
    updateAlphaFromX(e.nativeEvent.locationX);
  };
  const onAlphaMove = (e: GestureResponderEvent) => updateAlphaFromX(e.nativeEvent.locationX);
  const commitAlpha = () => {
    draggingAlphaRef.current = false;
    onChange(color, localAlphaRef.current);
  };

  // Fix round 1, item 6: an 8-digit hex the user typed DOES carry a real
  // alpha byte (`fromHex8` reads it) — passing the OLD `alpha` unconditionally
  // discarded it. Fix round 2's regression: the fix for that OVER-corrected —
  // `fromHex8` returns `a: 1` for EVERY 6-digit hex regardless of what alpha
  // was already in effect, so reading `parsed.a` unconditionally instead
  // forced alpha to fully opaque on every plain `#rrggbb` commit (the common
  // case), silently overwriting the selection's real opacity via `onChange`
  // -> `elements.applyOpacity`. `hasAlphaByte` is what actually distinguishes
  // "the text really carried an alpha byte" from "fromHex8 defaulted one" —
  // only then does the typed byte win; otherwise the live slider value
  // (`localAlpha`, not the possibly-stale `alpha` prop) is preserved.
  const commitHex = (text: string) => {
    const parsed = fromHex8(text);
    if (!parsed) return;
    onChange(toHex6(parsed), hasAlphaByte(text) ? parsed.a : localAlpha);
  };

  const canUseSwatches = workspaceService.canUseCustomPalette(plan);
  const atSwatchCap = workspaceSwatches.length >= workspaceService.MAX_WORKSPACE_SWATCHES;
  // Disabled the same silent way `atSwatchCap` already is — see
  // `canManageWorkspace`'s own prop doc for why this is a role restriction,
  // not a plan one, and so gets no "Pro" badge of its own.
  const canAddSwatch = canUseSwatches && canManageWorkspace && !atSwatchCap;

  const handleAddSwatch = () => {
    if (!canUseSwatches) {
      onUpgradeRequested();
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
                style={[styles.previewSwatch, { backgroundColor: toCssRgba({ ...parsedColor, a: localAlpha }) }]}
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

          <Text style={styles.sectionLabel}>Alpha: {Math.round(localAlpha * 100)}%</Text>
          {/* Fix Wave F5 — honest, not just silent: the selection has
              nothing this control would change (see
              `useBoardElements#selectionOpacityInert`'s own comment). A
              SEPARATE Text (not nested inside the label above) so the label
              itself stays a single plain-text node either way. */}
          {opacityControlDisabled && (
            <Text style={styles.alphaDisabledNote}>Selection has no strokes to change.</Text>
          )}
          <View
            testID="color-picker-alpha-track"
            style={[styles.alphaTrack, opacityControlDisabled && styles.alphaTrackDisabled]}
            onLayout={onTrackLayout}
            onStartShouldSetResponder={() => !opacityControlDisabled}
            onMoveShouldSetResponder={() => !opacityControlDisabled}
            onResponderGrant={opacityControlDisabled ? undefined : onAlphaGrant}
            onResponderMove={opacityControlDisabled ? undefined : onAlphaMove}
            onResponderRelease={opacityControlDisabled ? undefined : commitAlpha}
            onResponderTerminate={opacityControlDisabled ? undefined : commitAlpha}
          >
            <View
              testID="color-picker-alpha-thumb"
              style={[styles.alphaThumb, { left: positionFromValue(localAlpha, trackWidth, 0, 1) - 8 }]}
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
                    onPress={() => onChange(hex, localAlpha)}
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
                onPress={() => onChange(hex, localAlpha)}
                // Fix Wave F7 — long-press to remove, the same role gate as
                // adding (firestore.rules restricts `swatches` writes to
                // owner/admin regardless of plan; see `onRemoveSwatch`'s own
                // prop doc for why this carries no separate PLAN gate). A
                // plain member sees the same swatch with no long-press
                // affordance at all, same silent-disable `canAddSwatch`
                // already uses for adding.
                onLongPress={canManageWorkspace ? () => onRemoveSwatch(hex) : undefined}
                accessibilityRole="button"
                accessibilityLabel={
                  canManageWorkspace
                    ? `Use workspace swatch ${hex}. Long-press to remove it.`
                    : `Use workspace swatch ${hex}`
                }
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
  alphaTrackDisabled: {
    opacity: 0.4,
  },
  alphaDisabledNote: {
    fontWeight: "400",
    fontStyle: "italic",
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
