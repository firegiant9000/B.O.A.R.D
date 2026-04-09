import React, { useRef, useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  PanResponder,
  TouchableOpacity,
  Platform,
} from "react-native";
import { TextElement } from "../types";

const HANDLE_SIZE = 16;
const MIN_WIDTH = 80;
const MIN_HEIGHT = 36;

interface TextElementViewProps {
  element: TextElement;
  isSelected: boolean;
  isEditing: boolean;
  onSelect: (id: string) => void;
  onBlur: (id: string, text: string) => void;
  onResize: (id: string, width: number, height: number, fontSize: number) => void;
}

export default function TextElementView({
  element,
  isSelected,
  isEditing,
  onSelect,
  onBlur,
  onResize,
}: TextElementViewProps) {
  const [localText, setLocalText] = useState(element.text);
  const [dims, setDims] = useState({ width: element.width, height: element.height });
  const inputRef = useRef<TextInput>(null);

  // Stable mutable refs for closures in PanResponder (created once)
  const dimsRef = useRef(dims);
  const onResizeRef = useRef(onResize);
  const onBlurRef = useRef(onBlur);
  const elementIdRef = useRef(element.id);
  const localTextRef = useRef(localText);

  useEffect(() => { dimsRef.current = dims; });
  useEffect(() => { onResizeRef.current = onResize; });
  useEffect(() => { onBlurRef.current = onBlur; });
  useEffect(() => { elementIdRef.current = element.id; });
  useEffect(() => { localTextRef.current = localText; });

  // Sync text from Firestore updates
  useEffect(() => { setLocalText(element.text); }, [element.text]);

  // Sync dimensions from Firestore updates
  useEffect(() => {
    const next = { width: element.width, height: element.height };
    setDims(next);
    dimsRef.current = next;
  }, [element.width, element.height]);

  // Focus the input whenever editing mode activates
  useEffect(() => {
    if (isEditing) {
      const t = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [isEditing]);

  // Factory — plain objects in closure (not React refs) are fine here since
  // the PanResponder is only created once via useRef below.
  const makeCornerPanResponder = (corner: "tl" | "tr" | "bl" | "br") => {
    const start = { w: 0, h: 0, px: 0, py: 0 };
    const live = { w: 0, h: 0 };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        start.w = dimsRef.current.width;
        start.h = dimsRef.current.height;
        start.px = evt.nativeEvent.pageX;
        start.py = evt.nativeEvent.pageY;
        live.w = start.w;
        live.h = start.h;
      },
      onPanResponderMove: (evt) => {
        const dx = evt.nativeEvent.pageX - start.px;
        const dy = evt.nativeEvent.pageY - start.py;
        let w = start.w;
        let h = start.h;
        if (corner === "br") { w += dx; h += dy; }
        else if (corner === "bl") { w -= dx; h += dy; }
        else if (corner === "tr") { w += dx; h -= dy; }
        else { w -= dx; h -= dy; } // tl
        w = Math.max(MIN_WIDTH, w);
        h = Math.max(MIN_HEIGHT, h);
        live.w = w;
        live.h = h;
        dimsRef.current = { width: w, height: h };
        setDims({ width: w, height: h });
      },
      onPanResponderRelease: () => {
        const newFontSize = Math.max(8, Math.round(live.h * 0.38));
        onResizeRef.current(elementIdRef.current, live.w, live.h, newFontSize);
      },
    });
  };

  // Create each corner's PanResponder exactly once
  const tlPan = useRef(makeCornerPanResponder("tl")).current;
  const trPan = useRef(makeCornerPanResponder("tr")).current;
  const blPan = useRef(makeCornerPanResponder("bl")).current;
  const brPan = useRef(makeCornerPanResponder("br")).current;

  const handleBlur = () => {
    onBlurRef.current(elementIdRef.current, localTextRef.current);
  };

  return (
    <View
      style={[
        styles.container,
        {
          left: element.position.x,
          top: element.position.y,
          width: dims.width,
          height: dims.height,
        },
      ]}
    >
      <TouchableOpacity
        activeOpacity={1}
        onPress={() => onSelect(element.id)}
        style={styles.textArea}
      >
        {isEditing ? (
          <TextInput
            ref={inputRef}
            style={[styles.textInput, { fontSize: element.fontSize, color: element.color }]}
            value={localText}
            onChangeText={setLocalText}
            onBlur={handleBlur}
            multiline
            blurOnSubmit={Platform.OS !== "web"}
            returnKeyType="done"
            placeholder="Type here..."
            placeholderTextColor="rgba(0,0,0,0.3)"
          />
        ) : (
          <Text style={[styles.staticText, { fontSize: element.fontSize, color: element.color }]}>
            {element.text || " "}
          </Text>
        )}
      </TouchableOpacity>

      {isSelected && (
        <>
          {/* Dashed selection border — pointerEvents="none" so it doesn't block text taps */}
          <View style={styles.selectionBorder} pointerEvents="none" />
          {/* Corner resize handles */}
          <View {...tlPan.panHandlers} style={[styles.handle, styles.handleTL]} />
          <View {...trPan.panHandlers} style={[styles.handle, styles.handleTR]} />
          <View {...blPan.panHandlers} style={[styles.handle, styles.handleBL]} />
          <View {...brPan.panHandlers} style={[styles.handle, styles.handleBR]} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
  },
  textArea: {
    flex: 1,
  },
  textInput: {
    flex: 1,
    padding: 4,
    textAlignVertical: "top",
    backgroundColor: "transparent",
  },
  staticText: {
    padding: 4,
    flexWrap: "wrap",
  },
  selectionBorder: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1.5,
    borderColor: "#2563eb",
    borderStyle: "dashed",
    borderRadius: 4,
  },
  handle: {
    position: "absolute",
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    borderRadius: HANDLE_SIZE / 2,
    backgroundColor: "#fff",
    borderWidth: 2,
    borderColor: "#2563eb",
  },
  handleTL: { top: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2 },
  handleTR: { top: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2 },
  handleBL: { bottom: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2 },
  handleBR: { bottom: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2 },
});
