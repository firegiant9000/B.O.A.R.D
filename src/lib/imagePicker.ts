/**
 * Platform image-pick + prepare adapter (Phase 9).
 *
 * A thin seam over the source-specific bits so the service / board screen stay
 * platform-agnostic and unit-testable. Picking and downscaling are inherently
 * native-module / DOM work (untestable in jsdom), so they live here, out of the
 * service layer's coverage scope.
 *
 *   - Native (iOS/Android): `expo-image-picker` for gallery/camera, then
 *     `expo-image-manipulator` to resize + JPEG-compress the full image and a
 *     thumbnail; each result file is read into a Blob for `uploadBytes`.
 *   - Web: a hidden `<input type=file>` for selection, then an offscreen
 *     `<canvas>` to downscale — zero native modules.
 *
 * Returns `null` when the user cancels or permission is denied, so callers can
 * no-op silently.
 */

import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  ImageManipulator,
  SaveFormat,
} from "expo-image-manipulator";
import {
  PreparedAsset,
  PreparedImage,
  fitWithin,
  MAX_IMAGE_DIM,
  THUMBNAIL_DIM,
} from "./images";

export type ImageSource = "library" | "camera";

const JPEG_QUALITY = 0.8;

/** Pick an image from the gallery/camera (native) or a file dialog (web), then
 *  downscale it to a full-size + thumbnail pair ready for upload. */
export async function pickAndPrepareImage(
  source: ImageSource
): Promise<PreparedImage | null> {
  if (Platform.OS === "web") {
    return pickAndPrepareWeb();
  }
  return pickAndPrepareNative(source);
}

// --- Native (expo-image-picker + expo-image-manipulator) ---

async function pickAndPrepareNative(
  source: ImageSource
): Promise<PreparedImage | null> {
  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return null;
  } else {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return null;
  }

  const opts: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images"],
    quality: 1,
    exif: false,
  };
  const result =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(opts)
      : await ImagePicker.launchImageLibraryAsync(opts);
  if (result.canceled || !result.assets?.length) return null;

  const asset = result.assets[0];
  const naturalWidth = asset.width ?? 0;
  const naturalHeight = asset.height ?? 0;

  const full = await resizeNative(asset.uri, naturalWidth, naturalHeight, MAX_IMAGE_DIM);
  const thumbnail = await resizeNative(asset.uri, naturalWidth, naturalHeight, THUMBNAIL_DIM);
  return {
    full,
    thumbnail,
    naturalWidth,
    naturalHeight,
    alt: asset.fileName ?? "image",
  };
}

/** Prepare an already-obtained native image uri (e.g. from the OS clipboard on
 *  Cmd/Ctrl+V) into the full + thumbnail pair, given its natural dimensions. */
export async function prepareNativeImageUri(
  uri: string,
  naturalWidth: number,
  naturalHeight: number,
  alt = "image"
): Promise<PreparedImage> {
  const full = await resizeNative(uri, naturalWidth, naturalHeight, MAX_IMAGE_DIM);
  const thumbnail = await resizeNative(uri, naturalWidth, naturalHeight, THUMBNAIL_DIM);
  return { full, thumbnail, naturalWidth, naturalHeight, alt };
}

async function resizeNative(
  uri: string,
  naturalWidth: number,
  naturalHeight: number,
  maxEdge: number
): Promise<PreparedAsset> {
  const target = fitWithin(naturalWidth || maxEdge, naturalHeight || maxEdge, maxEdge);
  const ref = await ImageManipulator.manipulate(uri)
    .resize({ width: target.width, height: target.height })
    .renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
  const blob = await (await fetch(out.uri)).blob();
  return { blob, width: out.width ?? target.width, height: out.height ?? target.height };
}

// --- Web (file input + canvas) ---

function pickAndPrepareWeb(): Promise<PreparedImage | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) {
        resolve(null);
        return;
      }
      prepareWebFile(file).then(resolve, reject);
    };
    // A canceled dialog fires no `change`; nothing to clean up until the next pick.
    document.body.appendChild(input);
    input.click();
  });
}

/** Downscale a picked `File`/`Blob` (used by the file dialog and by paste/drop
 *  on web in later phases) into a full-size + thumbnail pair. */
export async function prepareWebFile(file: Blob & { name?: string }): Promise<PreparedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;
    const full = await drawScaled(img, fitWithin(naturalWidth, naturalHeight, MAX_IMAGE_DIM));
    const thumbnail = await drawScaled(img, fitWithin(naturalWidth, naturalHeight, THUMBNAIL_DIM));
    return {
      full,
      thumbnail,
      naturalWidth,
      naturalHeight,
      alt: file.name ?? "image",
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = src;
  });
}

function drawScaled(
  img: HTMLImageElement,
  size: { width: number; height: number }
): Promise<PreparedAsset> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Canvas 2D context unavailable"));
      return;
    }
    ctx.drawImage(img, 0, 0, size.width, size.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Canvas toBlob returned null"));
          return;
        }
        resolve({ blob, width: size.width, height: size.height });
      },
      "image/jpeg",
      JPEG_QUALITY
    );
  });
}
