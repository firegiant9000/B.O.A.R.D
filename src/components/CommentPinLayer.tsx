import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";

/**
 * Phase 7. Numbered comment pins, rendered in the board-space canvas overlay
 * (which already applies the viewport transform), so each pin sits at its
 * anchored element and pans/zooms with the content. Like SelectionOverlay the pin
 * chrome is counter-scaled (÷ zoom) to a constant on-screen size. This layer is
 * intentionally dumb: the board screen resolves each pin's live board-space
 * position from the current element arrays and passes it in, so comment state
 * never forces a re-render of the element tree (Appendix A.4 step 5).
 */

export interface CommentPin {
  id: string;
  /** Board-space position of the pin (already resolved from the anchor element). */
  x: number;
  y: number;
  /** 1-based number shown in the pin, in thread creation order. */
  number: number;
  resolved: boolean;
  unread: boolean;
}

interface CommentPinLayerProps {
  pins: CommentPin[];
  scale: number;
  activeId: string | null;
  onPressPin: (id: string) => void;
}

const PIN_SIZE = 26; // screen px

export default function CommentPinLayer({
  pins,
  scale,
  activeId,
  onPressPin,
}: CommentPinLayerProps) {
  const inv = 1 / (scale || 1);
  const size = PIN_SIZE * inv;

  return (
    <>
      {pins.map((pin) => {
        const active = pin.id === activeId;
        return (
          <TouchableOpacity
            key={pin.id}
            onPress={() => onPressPin(pin.id)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={[
              styles.pin,
              {
                left: pin.x,
                top: pin.y - size, // anchor the pin's tail at (x, y)
                width: size,
                height: size,
                borderRadius: size / 2,
                borderBottomLeftRadius: 2 * inv,
                borderWidth: 2 * inv,
              },
              pin.resolved ? styles.pinResolved : styles.pinOpen,
              active && styles.pinActive,
            ]}
          >
            <Text
              style={[
                styles.pinText,
                { fontSize: 13 * inv },
                pin.resolved && styles.pinTextResolved,
              ]}
            >
              {pin.resolved ? "✓" : pin.number}
            </Text>
            {pin.unread && !pin.resolved && (
              <View
                style={[
                  styles.unreadDot,
                  {
                    width: 9 * inv,
                    height: 9 * inv,
                    borderRadius: 4.5 * inv,
                    right: -2 * inv,
                    top: -2 * inv,
                    borderWidth: 1.5 * inv,
                  },
                ]}
              />
            )}
          </TouchableOpacity>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  pin: {
    position: "absolute",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
    ...(Platform.OS === "web" ? { cursor: "pointer" as any } : {}),
  },
  pinOpen: {
    backgroundColor: "#2563eb",
  },
  pinResolved: {
    backgroundColor: "#9ca3af",
  },
  pinActive: {
    backgroundColor: "#1d4ed8",
    borderColor: "#fbbf24",
  },
  pinText: {
    color: "#fff",
    fontWeight: "700",
  },
  pinTextResolved: {
    color: "#f3f4f6",
  },
  unreadDot: {
    position: "absolute",
    backgroundColor: "#ef4444",
    borderColor: "#fff",
  },
});
